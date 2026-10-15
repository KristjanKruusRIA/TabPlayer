// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { DocumentController } from './controller';
import { blankProject, type EditCommand, type Project, type AssetInfo } from './project';
import type { NativeBridge } from './bridge';
import type { BuiltDocument } from './engine';
import { defaultMix } from './document-settings';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import {getHarmonyChord} from './harmony/chord-source';
import type {HarmonyLibrary,HarmonyLibraryEntry} from './editor/harmony-types';
const engravingView=vi.hoisted(()=>vi.fn());
const personalLibrary=vi.hoisted(()=>({read:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]})),put:vi.fn(async(entry:HarmonyLibraryEntry):Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[entry]})),remove:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]}))}));
vi.mock('./harmony/library',async original=>({...await original<typeof import('./harmony/library')>(),readHarmonyLibrary:personalLibrary.read,putHarmonyLibraryEntry:personalLibrary.put,removeHarmonyLibraryEntry:personalLibrary.remove}));

const integration=vi.hoisted(()=>({loadDocument:vi.fn(),beforeScoreChange:vi.fn(),destroy:vi.fn(),stageBacking:vi.fn(),commits:vi.fn(),activeNotes:vi.fn((_trackId:string)=>[]),practiceSpeed:100,practiceFixed:false,setPractice:vi.fn(),exportOptions:vi.fn(),exportBusy:false,exportRun:vi.fn(async()=>true),exportCancel:vi.fn(async()=>{})}));
vi.mock('./audio/bridge',()=>({nativeAudioBridge:{stageBacking:integration.stageBacking}}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:(options:unknown)=>{integration.exportOptions(options);return {busy:integration.exportBusy,progress:undefined,run:integration.exportRun,cancel:integration.exportCancel};}}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  built:BuiltDocument|null=null;state:PlaybackState={ready:true,playing:false,time:0,endTime:4000,measure:0,speed:integration.practiceSpeed,metronome:false,practice:{settings:{...structuredClone(DEFAULT_PRACTICE),tempo:integration.practiceFixed?{kind:'fixed',bpm:90}:{kind:'relative',ratio:integration.practiceSpeed/100}},phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:integration.practiceSpeed/100,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loop:null,error:null};
  constructor(private options:{onEdit:(command:EditCommand)=>void|Promise<void>}){}
  subscribe=()=>()=>{};getState=()=>this.state;
  activeNotes=(trackId:string)=>integration.activeNotes(trackId);
  loadDocument=async(project:unknown,built:BuiltDocument,track:number,documentEpoch:number)=>{this.built=built;integration.loadDocument(project,built,track,documentEpoch);};
  beforeScoreChange=integration.beforeScoreChange;destroy=integration.destroy;
  play=vi.fn();pause=vi.fn();stop=vi.fn();seekToMeasure=vi.fn();setSpeed=vi.fn();setLoop=vi.fn();clearLoop=vi.fn();setMetronome=vi.fn();
  setPractice=integration.setPractice;exportPracticeRatio=()=>integration.practiceFixed?null:this.state.speed/100;
  devices=async()=>[];deviceId=()=>null;selectDevice=vi.fn();backingDurationMs=()=>undefined;
  mix=(track:{index:number})=>{const value=this.built?.settings.mixes[`base/${track.index}`];return value?{mute:value.mute,solo:value.solo,volume:value.gain,pan:value.pan}:undefined;};
  setMix=(track:number,patch:object)=>this.options.onEdit({type:'setTrackMix',trackId:`base/${track}`,mix:{...(this.built?.settings.mixes[`base/${track}`]??defaultMix()),...patch}});
  setMute=(track:number,mute:boolean)=>this.setMix(track,{mute});setSolo=(track:number,solo:boolean)=>this.setMix(track,{solo});setTrackVolume=(track:number,gain:number)=>this.setMix(track,{gain});setPan=(track:number,pan:number)=>this.setMix(track,{pan});
}}));

vi.mock('./ScoreView',()=>({ScoreView:({onSelect,track,...rest}: {track:number;onSelect: (target: unknown, string: number,noteIndex?:number)=>void}) =>{engravingView({track,...rest});return (
  <><button onClick={()=>onSelect({track:0,staff:0,bar:0,voice:0,beat:1},5)}>Select rendered note</button>
    <button onClick={()=>onSelect({track,staff:0,bar:0,voice:0,beat:0},-1,1)}>Select rendered chord note</button>
    {[
      {label:'fractional beat',field:'beat',value:0.5,string:6},
      {label:'negative staff',field:'staff',value:-1,string:6},
      {label:'non-finite measure',field:'bar',value:Infinity,string:6},
      {label:'non-finite voice',field:'voice',value:NaN,string:6},
      {label:'fractional string',field:'beat',value:0,string:1.5},
    ].map(({label,field,value,string})=><button key={label} onClick={()=>onSelect({track:0,staff:0,bar:0,voice:0,beat:0,[field]:value},string)}>Select {label}</button>)}
  </>);}}));
afterEach(()=>{cleanup();vi.clearAllMocks();integration.exportBusy=false;integration.practiceSpeed=100;integration.practiceFixed=false;});

async function setup(initial=blankProject(),openProject?:Project) {
  let edits: EditCommand[]=[...initial.edits]; let cursor=edits.length;let assets:Record<string,AssetInfo>={...initial.assets};
  const snapshot=()=>({project:{...initial,assets,edits:edits.slice(0,cursor)},canUndo:cursor>0,canRedo:cursor<edits.length,dirty:cursor>0,path:null});
  const bridge: NativeBridge={snapshot:async()=>snapshot(),readDocument:async()=>openProject?{project:openProject,path:'saved.tabplayer',token:'opened-document'}:null,
    createBlankDocument:async()=>({project:blankProject(),path:null,token:'new-document'}),
    replaceProject:async token=>{initial=token==='opened-document'?openProject!:blankProject();edits=[...initial.edits];assets={...initial.assets};cursor=edits.length;return snapshot();},
    applyEdit:async(command,assetToken)=>{integration.commits(command,assetToken);if(assetToken&&command.type==='setBacking'&&command.backing)assets={...assets,[command.backing.assetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20}};edits=edits.slice(0,cursor);edits.push(command);cursor++;return snapshot();},
    undo:async()=>{cursor--;return snapshot();},redo:async()=>{cursor++;return snapshot();},
    saveProject:async()=>null,exportGp:async()=>false,askUnsaved:async()=> 'discard',confirmExport:async()=>false};
  const controller=await DocumentController.create(bridge); render(<App controller={controller}/>); return controller;
}
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const currentBeat=(controller:DocumentController,index=0)=>controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[index];

it('opens the rich chord editor and keeps text edits from replacing its metadata',async()=>{
  const chord={name:'Legacy',nameMode:'manual' as const,recipe:null,firstFret:0,frets:[0,19,-1,2,30,0],fingers:[-2,1,-1,0,4,-2],barreFrets:[0,19,19],showName:false,showDiagram:false,showFingering:false};
  const c=await setup({...blankProject(),edits:[{type:'setHarmonyChord',target:{track:0,staff:0,bar:0,voice:0,beat:0},chord,fillEmptyBeat:false}]});
  click('Edit chord diagram');const dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Apply chord'})).toBeEnabled());
  expect(dialog.getByLabelText('Chord name')).toHaveValue('Legacy');fireEvent.click(dialog.getByRole('button',{name:'Apply chord'}));await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(2));
  expect(getHarmonyChord(currentBeat(c).chord!)).toEqual(chord);change('Beat text','Exact text');click('Apply beat text');await waitFor(()=>expect(currentBeat(c).text).toBe('Exact text'));
  expect(c.getState().snapshot.project.edits.at(-1)?.type).toBe('setBeatText');expect(getHarmonyChord(currentBeat(c).chord!)).toEqual(chord);
  const history=c.getState().snapshot;click('Browse scales');expect(await screen.findByRole('dialog',{name:'Scale browser'})).toBeInTheDocument();click('Close scales');expect(c.getState().snapshot).toBe(history);
});
it('keeps personal library management independent of project history and reloads it when opened',async()=>{
  const c=await setup(),before=c.getState().snapshot;click('Edit chord diagram');let dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Save to library'})).toBeEnabled());
  fireEvent.change(dialog.getByLabelText('Chord name'),{target:{value:'Personal shape'}});fireEvent.change(dialog.getByLabelText('Library label'),{target:{value:'My chord'}});fireEvent.click(dialog.getByRole('button',{name:'Save to library'}));
  await waitFor(()=>expect(dialog.getByRole('status')).toHaveTextContent('Saved to library.'));expect(personalLibrary.put).toHaveBeenCalledWith(expect.objectContaining({label:'My chord',chord:expect.objectContaining({name:'Personal shape'})}));expect(c.getState().snapshot).toBe(before);
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));click('New');await waitFor(()=>expect(c.getState().documentEpoch).toBe(1));click('Edit chord diagram');dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Apply chord'})).toBeEnabled());expect(personalLibrary.read).toHaveBeenCalledTimes(2);expect(c.getState().snapshot.project.edits).toHaveLength(0);
});
it('applies a named harmony interval through one native history command',async()=>{
  const c=await setup();change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes[0]?.realValue).toBe(69));click('Select bar');
  change('Transposition mode','chromatic');change('Interval quality','minor');change('Interval direction','down');click('Transpose harmony');await waitFor(()=>expect(currentBeat(c).notes[0].realValue).toBe(66));
  expect(c.getState().snapshot.project.edits).toHaveLength(2);expect(c.getState().snapshot.project.edits.at(-1)).toMatchObject({type:'transposeHarmony',interval:{kind:'chromatic',number:3,quality:'minor',direction:'down',octaves:0}});
  click('Undo');await waitFor(()=>expect(currentBeat(c).notes[0].realValue).toBe(69));
});
it('uses the selected staff for scale preview without inventing a passage selection',async()=>{
  const c=await setup({...blankProject(),edits:[{type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,28]}]});click('Track 2: Bass');const before=c.getState().snapshot;click('Browse scales');
  const svg=await screen.findByRole('img',{name:'Scale fretboard'}),labels=Array.from(svg.querySelectorAll('text')).filter(node=>node.getAttribute('x')==='3').map(node=>node.textContent);
  expect(labels).toEqual(['G2','D2','A1','E1']);expect(screen.getByText('Select melodic notes to match scales.')).toBeInTheDocument();expect(c.getState().snapshot).toBe(before);
});
it('keeps a late previous-dialog library response from replacing newer records',async()=>{
  let first!:HarmonyLibraryEntry,resolveFirst!:(value:HarmonyLibrary)=>void;
  personalLibrary.put.mockImplementationOnce(entry=>{first=entry;return new Promise(resolve=>{resolveFirst=resolve;});});
  const c=await setup(),before=c.getState().snapshot;click('Edit chord diagram');let dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Save to library'})).toBeEnabled());
  fireEvent.change(dialog.getByLabelText('Library label'),{target:{value:'First'}});fireEvent.click(dialog.getByRole('button',{name:'Save to library'}));await waitFor(()=>expect(personalLibrary.put).toHaveBeenCalledTimes(1));fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));
  personalLibrary.read.mockResolvedValueOnce({format:'TabPlayerHarmonyLibrary',version:1,entries:[first]});personalLibrary.put.mockImplementationOnce(async entry=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[first,entry]}));
  click('Edit chord diagram');dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Save to library'})).toBeEnabled());fireEvent.change(dialog.getByLabelText('Library label'),{target:{value:'Second'}});fireEvent.click(dialog.getByRole('button',{name:'Save to library'}));await waitFor(()=>expect(dialog.getByRole('option',{name:'Second'})).toBeInTheDocument());
  await act(async()=>{resolveFirst({format:'TabPlayerHarmonyLibrary',version:1,entries:[first]});});expect(dialog.getByRole('option',{name:'Second'})).toBeInTheDocument();expect(c.getState().snapshot).toBe(before);
});

it.each([{scale:.1,marginMm:15},{scale:1,marginMm:100}])('keeps old print geometry editable with a recoverable page notice: %j',async invalid=>{
  const project={...blankProject(),edits:[{type:'setPrintLayout' as const,layout:{paper:'A4' as const,orientation:'portrait' as const,profile:'ScoreTab' as const,...invalid}}]},c=await setup(project);
  expect(screen.getByRole('alert')).toHaveTextContent(/saved print layout/i);expect(c.getState().settings.print).toEqual(project.edits[0].layout);
  expect(screen.getByLabelText('Width (mm)')).toHaveValue(210);click('Apply page layout');await waitFor(()=>expect(c.getState().settings.page?.widthMm).toBe(210));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(c.getState().snapshot.project.edits[0]).toEqual(project.edits[0]);
});

it('keeps track visibility and fractional zoom in session state and resets them on New',async()=>{
  const c=await setup(),original=c.getState().score;
  change('Displayed tracks','all');change('Zoom (%)','127.5');
  expect(engravingView).toHaveBeenLastCalledWith(expect.objectContaining({visibleTracks:[0],zoom:127.5,projection:expect.objectContaining({score:expect.anything()})}));
  expect(c.getState().snapshot.project.edits).toHaveLength(0);expect(c.getState().score).toBe(original);
  click('New');await waitFor(()=>expect(c.getState().documentEpoch).toBe(1));
  expect(screen.getByLabelText('Displayed tracks')).toHaveValue('selected');expect(screen.getByLabelText('Zoom (%)')).toHaveValue(100);
});
it('applies engraving and custom page edits once while keeping canonical music through history',async()=>{
  const c=await setup(),original=c.getState().score;
  change('Hide dynamics','true');click('Apply engraving');await waitFor(()=>expect(c.getState().settings.engraving.stylesheet.hideDynamics).toBe(true));
  expect(c.getState().score).toBe(original);expect(c.getState().snapshot.project.edits).toHaveLength(1);
  change('Width (mm)','250');click('Apply page layout');await waitFor(()=>expect(c.getState().settings.page?.widthMm).toBe(250));
  expect(c.getState().snapshot.project.edits).toHaveLength(2);expect(c.getState().score).toBe(original);
  click('Undo');await waitFor(()=>expect(c.getState().settings.page).toBeNull());expect(c.getState().score).toBe(original);
  click('Redo');await waitFor(()=>expect(c.getState().settings.page?.widthMm).toBe(250));expect(c.getState().score).toBe(original);
});

it('keeps copied music and paste drafts across unrelated renders and New, with one repeated paste command',async()=>{
  const c=await setup();change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(5));click('Select bar');
  const workspace=screen.getByRole('region',{name:'Score workspace'});fireEvent.keyDown(workspace,{key:'c',ctrlKey:true});
  await waitFor(()=>expect(screen.getByText('Complete bars inserted before measure 1')).toBeInTheDocument());
  const clipboard=screen.getByText('Musical clipboard').closest('details')!;clipboard.open=true;change('Paste repetitions','2');change('Fret','6');
  expect(screen.getByLabelText('Paste repetitions')).toHaveValue(2);expect(c.getState().snapshot.project.edits).toHaveLength(1);
  click('New');await waitFor(()=>expect(c.getState().documentEpoch).toBe(1));expect(screen.getByText('Complete bars inserted before measure 1')).toBeInTheDocument();
  change('Paste repetitions','2');click('Paste music');await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(6));
  expect(c.getState().snapshot.project.edits).toHaveLength(1);expect(c.getState().snapshot.project.edits[0]).toMatchObject({type:'pasteMusic',options:{count:2}});
  expect(currentBeat(c).notes[0].fret).toBe(5);click('Undo');await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(4));
});
it('routes music clipboard shortcuts while preserving text input shortcuts and practice independence',async()=>{
  const c=await setup();change('Fret','3');click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));click('Select bar');
  const workspace=screen.getByRole('region',{name:'Score workspace'}),history=c.getState().snapshot.project.edits.length;
  fireEvent.keyDown(screen.getByLabelText('Fret'),{key:'x',ctrlKey:true});expect(c.getState().snapshot.project.edits).toHaveLength(history);
  fireEvent.keyDown(workspace,{key:'x',ctrlKey:true});await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  fireEvent.keyDown(workspace,{key:'v',ctrlKey:true});await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(5));expect(currentBeat(c).notes[0].fret).toBe(3);
  const before=c.getState().snapshot;const details=screen.getByText('Practice settings').closest('details')!;details.open=true;change('Relative speed (%)','123');click('Apply practice settings');
  expect(integration.setPractice).toHaveBeenCalledWith(expect.objectContaining({tempo:{kind:'relative',ratio:1.23}}));expect(c.getState().snapshot).toEqual(before);
});
it('passes fixed-mode export unavailability without claiming a constant practice coefficient',async()=>{
  integration.practiceFixed=true;await setup();await waitFor(()=>expect(integration.exportOptions).toHaveBeenLastCalledWith(expect.objectContaining({currentSpeed:null})));
  click('Export score');change('Export format','wav');expect(screen.getByRole('option',{name:'Current speed coefficient'})).toBeDisabled();
});

it('selects editable music with keyboard shortcuts without changing history or text editing',async()=>{
  const c=await setup();change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(5));
  const history=c.getState().snapshot.project.edits.length,workspace=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(workspace,{key:'a',ctrlKey:true});expect(screen.getByText('1 note · 16 beats')).toBeInTheDocument();
  expect(c.getState().snapshot.project.edits).toHaveLength(history);
  click('Up semitone');await waitFor(()=>expect(currentBeat(c).notes[0].fret).toBe(6));
  expect(c.getState().snapshot.project.edits.at(-1)).toMatchObject({type:'transposeSelection',semitones:1});
  fireEvent.keyDown(workspace,{key:'Escape'});expect(screen.getByText('0 notes · 0 beats')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText('Fret'),{key:'a',ctrlKey:true});expect(screen.getByText('0 notes · 0 beats')).toBeInTheDocument();
  fireEvent.keyDown(workspace,{key:'ArrowRight',shiftKey:true});expect(screen.getByText('1 note · 2 beats')).toBeInTheDocument();
  const selectedHistory=c.getState().snapshot.project.edits.length;click('New');await waitFor(()=>expect(c.getState().documentEpoch).toBe(1));
  expect(screen.getByText('0 notes · 0 beats')).toBeInTheDocument();expect(selectedHistory).toBe(history+1);
});
it('keeps the beat cursor on its original music across insert and remove measure ranges',async()=>{
  const c=await setup();change('Measure','3');change('Measures to insert','2');click('Insert before');
  await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(6));await waitFor(()=>expect(screen.getByLabelText('Measure')).toHaveValue(5));
  change('First measure to remove','1');change('Last measure to remove','2');click('Remove measure range');
  await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(4));await waitFor(()=>expect(screen.getByLabelText('Measure')).toHaveValue(3));
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['insertMeasures','removeMeasures']);
});

it('creates piano chords, edits the clicked member and replays its history',async()=>{
  const c=await setup();change('New notation track name','Piano');click('Add pitched track');
  await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));click('Track 2: Piano');
  change('Written pitch','C4');click('Add pitched note');
  const notes=()=>c.getState().score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes;
  await waitFor(()=>expect(notes().map(n=>n.realValue)).toEqual([60]));
  change('Written pitch','E4');click('Add pitched note');await waitFor(()=>expect(notes().map(n=>n.realValue)).toEqual([60,64]));
  click('Select rendered chord note');expect(screen.getByLabelText('Chord note')).toHaveValue('1');expect(screen.getByLabelText('Written pitch')).toHaveValue('E4');
  change('Written pitch','F4');click('Update pitched note');await waitFor(()=>expect(notes().map(n=>n.realValue)).toEqual([60,65]));
  click('Undo');await waitFor(()=>expect(notes().map(n=>n.realValue)).toEqual([60,64]));
  click('Redo');await waitFor(()=>expect(notes().map(n=>n.realValue)).toEqual([60,65]));
});

it('clears the indexed chord member after successful clipboard paste',async()=>{
  const target={track:1,staff:0,bar:0,voice:0,beat:0};
  const c=await setup({...blankProject(),edits:[{type:'addPitchedTrack',name:'Piano',program:0},{type:'addPitchedNote',target,pitch:60},{type:'addPitchedNote',target,pitch:64}]});
  click('Track 2: Piano');click('Select rendered chord note');expect(screen.getByLabelText('Chord note')).toHaveValue('1');click('Select bar');
  const workspace=screen.getByRole('region',{name:'Score workspace'});fireEvent.keyDown(workspace,{key:'c',ctrlKey:true});await waitFor(()=>expect(screen.getByLabelText('Paste repetitions')).toBeInTheDocument());
  fireEvent.keyDown(workspace,{key:'v',ctrlKey:true});await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(5));expect(screen.getByLabelText('Chord note')).toHaveValue('-1');
});

it('keeps clipboard shortcuts inside the chord modal from editing the score',async()=>{
  const c=await setup({...blankProject(),edits:[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}]});click('Select bar');
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'c',ctrlKey:true});await waitFor(()=>expect(screen.getByLabelText('Paste repetitions')).toBeInTheDocument());
  click('Edit chord diagram');const dialog=screen.getByRole('dialog',{name:'Harmony chord'}),before=c.getState().snapshot;
  const cancel=within(dialog).getByRole('button',{name:'Cancel'});cancel.focus();
  for(const key of ['c','x','v'])fireEvent.keyDown(cancel,{key,ctrlKey:true});
  await waitFor(()=>expect(c.getState().busy).toBe(false));expect(c.getState().snapshot).toBe(before);expect(dialog).toBeInTheDocument();
});

it('edits song metadata and measure directions through the integrated inspector',async()=>{
  const c=await setup();change('Album','New album');click('Apply song metadata');
  await waitFor(()=>expect(c.getState().score.album).toBe('New album'));
  expect(c.getState().snapshot.project.edits.at(-1)).toMatchObject({type:'setScoreMetadata',fields:{album:'New album'}});
  fireEvent.click(screen.getByLabelText('Fine'));click('Apply directions');
  await waitFor(()=>expect(c.getState().score.masterBars[0].directions?.has(0)).toBe(true));
});

it.each([25,50,100,200])('passes %i percent practice speed to export as a render ratio',async speed=>{
  integration.practiceSpeed=speed;await setup();
  await waitFor(()=>expect(integration.exportOptions).toHaveBeenLastCalledWith(expect.objectContaining({currentSpeed:speed/100})));
});

it('selects rendered notes and enters frets on empty strings to form chords',async()=>{
  const c=await setup(); click('Select rendered note'); expect(screen.getByLabelText('Beat')).toHaveValue(2);
  expect(screen.getByLabelText('String')).toHaveValue('5'); change('Fret','7'); click('Set note');
  await waitFor(()=>expect(currentBeat(c,1).notes[0]?.fret).toBe(7));
  change('String','6');change('Fret','3');click('Set note');
  await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(2));
  click('Remove note');await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(1));
  click('Make rest');await waitFor(()=>expect(currentBeat(c,1).isRest).toBe(true));
});
it('persists selected track sound and mixer without replacing the score identity',async()=>{
  const c=await setup(),score=c.getState().score;change('Sound source','green-guitar');await waitFor(()=>expect(c.getState().settings.sounds['base/0'].voiceId).toBe('green-guitar'));expect(c.getState().score).toBe(score);
  fireEvent.click(screen.getByLabelText('Mute'));await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));expect(c.getState().score).toBe(score);
  expect(integration.beforeScoreChange).not.toHaveBeenCalled();expect(integration.loadDocument).toHaveBeenLastCalledWith(c.getState().snapshot.project,expect.objectContaining({score,settings:c.getState().settings}),0,0);
});
it('loads documents into native playback and opening does not reset saved mix',async()=>{
  const c=await setup();await waitFor(()=>expect(integration.loadDocument).toHaveBeenCalled());fireEvent.click(screen.getByLabelText('Mute'));await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));
  click('New');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(0));expect(screen.getByLabelText('Mute')).not.toBeChecked();expect(integration.loadDocument).toHaveBeenLastCalledWith(c.getState().snapshot.project,expect.objectContaining({score:c.getState().score}),0,1);
});
it('opens the export dialog and persists custom page layout through the existing history',async()=>{
  const c=await setup();click('Export score');const dialog=within(screen.getByRole('dialog',{name:'Export score'}));change('Export format','pdf');fireEvent.change(dialog.getByLabelText('Width (mm)'),{target:{value:'250'}});fireEvent.click(dialog.getByRole('button',{name:'Apply page layout'}));click('Export');await waitFor(()=>expect(c.getState().settings.page?.widthMm).toBe(250));await waitFor(()=>expect(integration.exportRun).toHaveBeenCalledWith(expect.objectContaining({format:'pdf',page:expect.objectContaining({widthMm:250})})));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());
});
it('opens saved mix and recorded voice without creating reset edits',async()=>{
  const saved={...blankProject(),edits:[{type:'setTrackMix' as const,trackId:'base/0',mix:{gain:.4,pan:.2,mute:true,solo:false}}]};const c=await setup(blankProject(),saved);click('Open');await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));await waitFor(()=>expect(screen.getByLabelText('Mute')).toBeChecked());expect(c.getState().snapshot.project.edits).toHaveLength(1);expect(integration.commits).not.toHaveBeenCalled();
});
it('stages backing and commits its token with the finite backing command',async()=>{
  const assetId='a'.repeat(64);integration.stageBacking.mockResolvedValueOnce({assetId,token:'staged-audio',info:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20},durationMs:1000});const c=await setup();const score=c.getState().score;
  click('Import backing');await waitFor(()=>expect(c.getState().settings.backing?.assetId).toBe(assetId));expect(integration.commits).toHaveBeenLastCalledWith({type:'setBacking',backing:{assetId,offsetMs:0,anchors:[],mix:defaultMix()}},'staged-audio');expect(c.getState().snapshot.project.assets[assetId].byteLength).toBe(20);expect(c.getState().score).toBe(score);
});
it('default print export leaves exact history unchanged',async()=>{
  const c=await setup(),before=c.getState().snapshot.project;click('Export score');change('Export format','pdf');click('Export');await waitFor(()=>expect(integration.exportRun).toHaveBeenCalled());expect(c.getState().snapshot.project).toEqual(before);expect(integration.commits).not.toHaveBeenCalled();
});
it('cancels an active export through the coordinator and closes the dialog',async()=>{
  let finish:(value:boolean)=>void=()=>{};integration.exportRun.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));const c=await setup();click('Export score');click('Export');await waitFor(()=>expect(integration.exportRun).toHaveBeenCalled());integration.exportBusy=true;
  change('Title','Export cancellation');click('Apply score info');await waitFor(()=>expect(c.getState().score.title).toBe('Export cancellation'));click('Cancel export');await waitFor(()=>expect(integration.exportCancel).toHaveBeenCalled());await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());finish(false);
});
it('shows native export failure inside the open modal without a duplicate background alert',async()=>{
  integration.exportRun.mockRejectedValueOnce(new Error('Native export failed.'));await setup();click('Export score');click('Export');const dialog=screen.getByRole('dialog',{name:'Export score'});
  await waitFor(()=>expect(within(dialog).getByRole('alert')).toHaveTextContent('Native export failed.'));expect(screen.getAllByRole('alert')).toHaveLength(1);expect(within(dialog).getByRole('button',{name:'Export'})).toBeEnabled();
});
it('focuses export options and Escape restores the toolbar opener',async()=>{
  await setup();const opener=screen.getByRole('button',{name:'Export score'});opener.focus();fireEvent.click(opener);const format=screen.getByLabelText('Export format');expect(format).toHaveFocus();fireEvent.keyDown(format,{key:'Escape'});await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());expect(opener).toHaveFocus();
});
it('edits rhythm, reports overflow, and supports undo and redo',async()=>{
  const c=await setup();change('Duration','2');click('Apply rhythm');
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('overfill'));
  expect(c.getState().snapshot.project.edits).toHaveLength(0);
  change('Duration','8');click('Apply rhythm');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
  click('Undo');await waitFor(()=>expect(currentBeat(c).duration).toBe(4));
  click('Redo');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
});
it('navigates beats and strings and accepts fret keys when the score has focus',async()=>{
  const c=await setup();const workspace=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(workspace,{key:'ArrowRight'});fireEvent.keyDown(workspace,{key:'ArrowDown'});
  expect(screen.getByLabelText('Beat')).toHaveValue(2);expect(screen.getByLabelText('String')).toHaveValue('5');
  fireEvent.keyDown(workspace,{key:'7'});fireEvent.keyDown(workspace,{key:'Enter'});
  await waitFor(()=>expect(currentBeat(c,1).notes[0]?.fret).toBe(7));
});
it('repairs selection after deleting the last beat, measure, and track',async()=>{
  const c=await setup();change('Beat','4');click('Delete beat');
  await waitFor(()=>expect(screen.getByLabelText('Beat')).toHaveValue(3));
  change('Measure','4');click('Remove measure');await waitFor(()=>expect(screen.getByLabelText('Measure')).toHaveValue(3));
  click('Append measure');await waitFor(()=>expect(c.getState().score.masterBars).toHaveLength(4));
  expect(screen.getByLabelText('Measure')).toHaveValue(3);
  click('Add track');await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));
  click('Track 2: Bass');click('Remove track');await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(1));
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toHaveAttribute('aria-pressed','true');
  expect(Number((screen.getByLabelText('String') as HTMLSelectElement).value)).toBeLessThanOrEqual(6);
});
it('inserts a beat into an empty voice and changes score information and tuning',async()=>{
  const c=await setup();for(let i=0;i<4;i++){click('Delete beat');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(i+1));}
  expect(screen.getByRole('button',{name:'Set note'})).toBeDisabled();
  click('Insert beat');await waitFor(()=>expect(currentBeat(c)).toBeDefined());
  change('Title','My study');change('Artist','Band');change('Initial tempo','90');click('Apply score info');
  await waitFor(()=>expect(c.getState().score.title).toBe('My study'));
  change('Tuning (notes, high to low)','E4 B3 G3 D3 A2 D2');click('Apply tuning');
  await waitFor(()=>expect(c.getState().score.tracks[0].staves[0].tuning.at(-1)).toBe(38));
});

it('refreshes_fret_after_undo_with_same_indices',async()=>{
  const c=await setup();change('Fret','3');click('Set note');
  await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(3));
  change('Fret','7');click('Set note');
  await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(7));
  click('Undo');
  await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(3));
  await waitFor(()=>expect(screen.getByLabelText('Fret')).toHaveValue(3));
  expect(screen.getByLabelText('Measure')).toHaveValue(1);
  expect(screen.getByLabelText('Beat')).toHaveValue(1);
  click('Redo');
  await waitFor(()=>expect(screen.getByLabelText('Fret')).toHaveValue(7));
});

it('refreshes fret after replacing a document at the same indices',async()=>{
  const c=await setup();change('Fret','9');click('Set note');
  await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(9));
  click('New');
  await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  await waitFor(()=>expect(screen.getByLabelText('Fret')).toHaveValue(0));
});

it('preserves selection when a rendered selection contains invalid indices',async()=>{
  await setup();click('Select rendered note');
  for (const label of ['fractional beat','negative staff','non-finite measure','non-finite voice','fractional string']) {
    click(`Select ${label}`);
    expect(screen.getByLabelText('Measure')).toHaveValue(1);
    expect(screen.getByLabelText('Beat')).toHaveValue(2);
    expect(screen.getByLabelText('String')).toHaveValue('5');
  }
});

it('navigates backwards into the insertion location of an empty voice',async()=>{
  const c=await setup();
  for(let i=0;i<4;i++){click('Delete beat');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(i+1));}
  const workspace=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(workspace,{key:'ArrowRight'});
  expect(screen.getByLabelText('Measure')).toHaveValue(2);
  fireEvent.keyDown(workspace,{key:'ArrowLeft'});
  expect(screen.getByLabelText('Measure')).toHaveValue(1);
  expect(screen.getByLabelText('Beat')).toHaveValue(1);
  expect(screen.getByRole('button',{name:'Insert beat'})).toBeEnabled();
});

it('toggles the selected-track instrument view without editing the document',async()=>{
  const c=await setup();const before=c.getState().snapshot;
  expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();
  click('Show instrument');
  expect(screen.getByRole('region',{name:'Instrument view'})).toHaveTextContent('Guitar');
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('auto');
  expect(screen.getByRole('button',{name:'Hide instrument'})).toHaveAttribute('aria-pressed','true');
  expect(integration.activeNotes).toHaveBeenCalledWith('base/0');
  expect(c.getState().snapshot).toBe(before);
  click('Hide instrument');
  expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();
  expect(c.getState().snapshot).toBe(before);
});

it('follows a newly selected bass track and repairs the viewer after New',async()=>{
  const c=await setup();click('Show instrument');click('Add track');
  await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));
  click('Track 2: Bass');
  expect(screen.getByRole('region',{name:'Instrument view'})).toHaveTextContent('Bass');
  click('New');
  await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(1));
  expect(screen.getByRole('region',{name:'Instrument view'})).toHaveTextContent('Guitar');
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('auto');
});
