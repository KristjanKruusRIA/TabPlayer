// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceApp } from './workspace/WorkspaceApp';
import { WorkspaceController } from './workspace/WorkspaceController';
import type { DocumentSnapshot,NativeWorkspaceBridge,WorkspaceSnapshot } from './workspace/types';
import type { DocumentCandidate } from './project';
import type { NativeAudioBridge } from './audio/bridge';
import type { ExportNativeBridge } from './export/bridge';
import { DocumentController } from './controller';
import { blankProject, type EditCommand, type Project, type AssetInfo } from './project';
import type { NativeBridge } from './bridge';
import {buildScore,exportGp,type BuiltDocument} from './engine';
import {createHash} from 'node:crypto';
import { defaultMix } from './document-settings';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import {getHarmonyChord} from './harmony/chord-source';
import type {HarmonyLibrary,HarmonyLibraryEntry} from './editor/harmony-types';
const engravingView=vi.hoisted(()=>vi.fn());
const documentBridges=vi.hoisted(()=>new Map<string,NativeBridge>());
vi.mock('./bridge',async original=>({...await original<typeof import('./bridge')>(),createDocumentBridge:(id:string)=>{const bridge=documentBridges.get(id);if(!bridge)throw new Error('Missing addressed document bridge');return bridge;}}));
const personalLibrary=vi.hoisted(()=>({read:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]})),put:vi.fn(async(entry:HarmonyLibraryEntry):Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[entry]})),remove:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]}))}));
vi.mock('./harmony/library',async original=>({...await original<typeof import('./harmony/library')>(),readHarmonyLibrary:personalLibrary.read,putHarmonyLibraryEntry:personalLibrary.put,removeHarmonyLibraryEntry:personalLibrary.remove}));

const integration=vi.hoisted(()=>({loadDocument:vi.fn(),beforeScoreChange:vi.fn(),destroy:vi.fn(),playerOptions:vi.fn(),stop:vi.fn(),stageBacking:vi.fn<NativeAudioBridge['stageBacking']>(),commits:vi.fn(),activeNotes:vi.fn((_trackId:string)=>[]),practiceSpeed:100,practiceFixed:false,setPractice:vi.fn(),play:vi.fn(),pause:vi.fn(),playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn(),exportOptions:vi.fn(),exportBusy:false,exportRun:vi.fn(async(_options:unknown,_source?:unknown)=>true),exportCancel:vi.fn(async()=>{})}));
vi.mock('./audio/bridge',()=>({createDocumentAudioBridge:vi.fn(()=>({prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:integration.stageBacking,stageEmbeddedBacking:vi.fn(async()=>null)} satisfies NativeAudioBridge))}));
vi.mock('./export/bridge',()=>({createDocumentExportBridge:vi.fn(()=>({exportPdf:vi.fn(async()=>null),exportMidi:vi.fn(async()=>false),exportAudio:vi.fn(async()=>null),status:vi.fn(async()=>null),cancel:vi.fn(async()=>{})} satisfies ExportNativeBridge))}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:(options:unknown)=>{integration.exportOptions(options);return {busy:integration.exportBusy,progress:undefined,run:integration.exportRun,cancel:integration.exportCancel};}}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  built:BuiltDocument|null=null;state:PlaybackState={ready:true,playing:false,time:0,endTime:4000,measure:0,speed:integration.practiceSpeed,metronome:false,practice:{settings:{...structuredClone(DEFAULT_PRACTICE),tempo:integration.practiceFixed?{kind:'fixed',bpm:90}:{kind:'relative',ratio:integration.practiceSpeed/100}},phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:integration.practiceSpeed/100,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null};
  constructor(private options:{bridge:NativeAudioBridge;onEdit:(command:EditCommand)=>void|Promise<void>}){integration.playerOptions(options);}
  subscribe=()=>()=>{};getState=()=>this.state;
  generation=7;cursorPlaybackChoices=(target:{bar:number;beat:number})=>target?[{generation:7,occurrenceIndex:target.bar,startTick:target.bar*3840+target.beat*960}]:[];
  selectionPlaybackChoices=()=>[{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:960}];
  playbackOccurrences=()=>Array.from({length:this.built?.score.masterBars.length??4},(_,bar)=>({bar,occurrence:0,startTick:bar*3840,endTick:(bar+1)*3840,startMs:bar*2000,endMs:(bar+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]}));
  playFromCursor=integration.playFromCursor;playSelection=integration.playSelection;loopSelection=integration.loopSelection;
  activeNotes=(trackId:string)=>integration.activeNotes(trackId);
  loadDocument=async(project:unknown,built:BuiltDocument,track:number,documentEpoch:number)=>{this.built=built;integration.loadDocument(project,built,track,documentEpoch);};
  beforeScoreChange=integration.beforeScoreChange;destroy=integration.destroy;
  play=integration.play;pause=integration.pause;stop=integration.stop;seekToMeasure=vi.fn();setSpeed=vi.fn();setLoop=vi.fn();clearLoop=vi.fn();setMetronome=vi.fn();
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

let testWorkspace:WorkspaceController;
const activeController=()=>testWorkspace.getState().documents.find(entry=>entry.id===testWorkspace.getState().active.documentId)!.controller;
async function setup(initial=blankProject(),openProject?:Project) {
  documentBridges.clear();let next=0,activation=0,active={documentId:'',activationId:''};
  const records=new Map<string,DocumentSnapshot>(),staged=new Map<string,DocumentCandidate>();
  const add=(project:Project,path:string|null=null)=>{
    const documentId=`app-document-${++next}`;let edits:EditCommand[]=[...project.edits],cursor=edits.length,revision=0,assets:Record<string,AssetInfo>={...project.assets},dirty=cursor>0;
    const record=():DocumentSnapshot=>({documentId,revision,snapshot:{project:{...project,assets,edits:edits.slice(0,cursor)},canUndo:cursor>0,canRedo:cursor<edits.length,redoEdit:edits[cursor]??null,dirty,path}});
    const update=()=>{revision++;const value=record();records.set(documentId,value);return value;};
    const check=(expected:number)=>{if(expected!==revision||!records.has(documentId))throw new Error('Invalid addressed revision');};
    const bridge:NativeBridge={documentId,snapshot:async()=>record(),cancelAsset:vi.fn(async()=>true),
      applyEdit:async(command,expected,assetToken)=>{check(expected);integration.commits(command,assetToken);if(assetToken&&command.type==='setBacking'&&command.backing)assets={...assets,[command.backing.assetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20}};edits=edits.slice(0,cursor);edits.push(command);cursor++;dirty=true;return update();},
      undo:async expected=>{check(expected);cursor--;dirty=true;return update();},redo:async expected=>{check(expected);cursor++;dirty=true;return update();},saveProject:async()=>null,exportGp:vi.fn(async()=>false),askUnsaved:vi.fn(async()=> 'discard' as const),confirmExport:vi.fn(async()=>false)};
    records.set(documentId,record());documentBridges.set(documentId,bridge);return documentId;
  };
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()],active:{...active}});
  const activate=(id:string)=>{if(id!==active.documentId)active={documentId:id,activationId:`app-activation-${++activation}`};return snapshot();};
  const stage=(project:Project,path:string|null,token:string)=>{const candidate={project,path,token};staged.set(token,candidate);return candidate;};
  activate(add(initial));
  const bridge:NativeWorkspaceBridge={snapshot:async()=>snapshot(),readDocument:async()=>openProject?{kind:'candidate',candidate:stage(openProject,'saved.tabplayer','opened-document')}:null,createBlankDocument:async()=>stage(blankProject(),null,'new-document'),cancelDocument:async token=>staged.delete(token),addDocument:async token=>{const candidate=staged.get(token);if(!candidate)throw new Error('Missing document candidate');staged.delete(token);return activate(add(candidate.project,candidate.path));},activateDocument:async id=>activate(id),closeDocuments:async decisions=>{const order=[...records.keys()],index=order.indexOf(active.documentId);for(const decision of decisions)records.delete(decision.documentId);if(!records.size)add(blankProject());return records.has(active.documentId)?snapshot():activate([...records.keys()][Math.min(index,records.size-1)]);}};
  testWorkspace=await WorkspaceController.create(bridge);const controller=activeController();render(<WorkspaceApp workspace={testWorkspace}/>);return controller;
}
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const currentBeat=(controller:DocumentController,index=0)=>controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[index];

it('describes a new unsaved score accurately and passes canonical edit focus to the paper',async()=>{
  await setup();expect(document.querySelector('.statusbar')).toHaveTextContent('New score');
  expect(engravingView.mock.lastCall?.[0]).toMatchObject({editTarget:{track:0,staff:0,bar:0,voice:0,beat:0},editString:6,editNoteIndex:null});
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'ArrowRight'});
  expect(engravingView.mock.lastCall?.[0]).toMatchObject({editTarget:{track:0,staff:0,bar:0,voice:0,beat:1}});
});
it('passes canonical paper targets and musical selections to transport only on explicit actions',async()=>{
  const c=await setup(),before=c.getState().snapshot;click('Select rendered note');click('Select bar');
  expect(integration.play).not.toHaveBeenCalled();expect(integration.playFromCursor).not.toHaveBeenCalled();expect(integration.playSelection).not.toHaveBeenCalled();expect(integration.loopSelection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Selected playback',{selector:'summary'}));click('Play from cursor');
  expect(integration.playFromCursor).toHaveBeenCalledWith({track:0,staff:0,bar:0,voice:0,beat:1},{generation:7,occurrenceIndex:0,startTick:960});
  click('Play selection');expect(integration.playSelection).toHaveBeenCalledWith({kind:'bars',tracks:[0],firstBar:0,lastBar:0},{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:960});
  click('Loop selection');expect(integration.loopSelection).toHaveBeenCalledTimes(1);expect(c.getState().snapshot).toBe(before);
});

it('places practice and page controls inside their inspector task landmarks',async()=>{
  await setup();
  expect(screen.getByLabelText('Tempo mode').closest('[aria-label="Practice tools"]')).not.toBeNull();
  expect(screen.getByLabelText('Width (mm)').closest('[aria-label="Presentation tools"]')).not.toBeNull();
});

it('offers discoverable editing help that closes with Escape without changing music',async()=>{
  const c=await setup(),before=c.getState().snapshot;
  const opener=screen.getByText('Help',{selector:'summary'});fireEvent.click(opener);
  const help=screen.getByRole('region',{name:'Keyboard and editing help'});
  expect(help).toHaveTextContent('Ctrl/Cmd + S');expect(help).toHaveTextContent('Shift + Left/Right');
  fireEvent.keyDown(help,{key:'Escape'});expect(opener.closest('details')).not.toHaveAttribute('open');
  expect(opener).toHaveFocus();expect(c.getState().snapshot).toBe(before);
});

it('routes save history and playback shortcuts through existing actions outside fields and dialogs',async()=>{
  const c=await setup(),save=vi.spyOn(c,'save').mockResolvedValue(true);
  const workspace=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(workspace,{key:'s',ctrlKey:true});await waitFor(()=>expect(save).toHaveBeenCalledWith(false));
  fireEvent.keyDown(workspace,{key:'S',metaKey:true,shiftKey:true});await waitFor(()=>expect(save).toHaveBeenCalledWith(true));
  click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  fireEvent.keyDown(workspace,{key:'z',ctrlKey:true});await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  fireEvent.keyDown(workspace,{key:'z',ctrlKey:true,shiftKey:true});await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  fireEvent.keyDown(workspace,{key:' '});expect(integration.play).toHaveBeenCalledTimes(1);
  save.mockClear();fireEvent.keyDown(screen.getByLabelText('Fret'),{key:'s',ctrlKey:true});
  click('Export score');fireEvent.keyDown(screen.getByLabelText('Export format'),{key:'s',ctrlKey:true});
  expect(save).not.toHaveBeenCalled();expect(integration.play).toHaveBeenCalledTimes(1);
});

it('reveals paste options through a collapsed Edit task without changing history',async()=>{
  const c=await setup(),workspace=screen.getByRole('region',{name:'Score workspace'});click('Select bar');
  fireEvent.keyDown(workspace,{key:'c',ctrlKey:true});await waitFor(()=>expect(screen.getByLabelText('Paste repetitions')).toBeInTheDocument());
  const editTask=document.querySelector<HTMLDetailsElement>('.inspector-task[id$="-edit"]')!;editTask.open=false;
  const clipboardSummary=screen.getByText('Musical clipboard',{selector:'summary'}),scroll=vi.fn();clipboardSummary.parentElement!.scrollIntoView=scroll;
  const before=c.getState().snapshot;fireEvent.keyDown(workspace,{key:'v',ctrlKey:true,shiftKey:true});
  expect(editTask.open).toBe(true);expect(clipboardSummary).toHaveFocus();expect(scroll).toHaveBeenCalledWith({block:'nearest'});expect(c.getState().snapshot).toBe(before);
});

it.each(['Add pitched track','Add percussion track'])('omits string caret context for %s',async action=>{
  const c=await setup();click(action);await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));
  fireEvent.click(screen.getByRole('button',{name:/^Track 2:/}));
  expect(engravingView.mock.lastCall?.[0]).toMatchObject({editTarget:{track:1,staff:0,bar:0,voice:0,beat:0},editNoteIndex:null});
  expect(engravingView.mock.lastCall?.[0].editString).toBeUndefined();
});

it('starts Harmony at its heading during initial library loading and focuses name when ready',async()=>{
  let finish!:(library:HarmonyLibrary)=>void;personalLibrary.read.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  await setup();click('Edit chord diagram');const dialog=screen.getByRole('dialog',{name:'Harmony chord'});
  const initialFocus=document.activeElement;await act(async()=>finish({format:'TabPlayerHarmonyLibrary',version:1,entries:[]}));
  await waitFor(()=>expect(within(dialog).getByLabelText('Chord name')).toBeEnabled());
  expect(initialFocus).toBe(dialog);expect(within(dialog).getByLabelText('Chord name')).toHaveFocus();
});

it('distinguishes a clean imported score from a new or saved native project',async()=>{
  const bytes=exportGp(buildScore(blankProject())),base={kind:'file' as const,filename:'Study.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  await setup({...blankProject(),base});expect(document.querySelector('.statusbar')).toHaveTextContent('Not saved');
});

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
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));click('New');await waitFor(()=>expect(activeController()).not.toBe(c));expect(testWorkspace.getState().documents).toHaveLength(2);click('Edit chord diagram');dialog=within(await screen.findByRole('dialog',{name:'Harmony chord'}));await waitFor(()=>expect(dialog.getByRole('button',{name:'Apply chord'})).toBeEnabled());expect(personalLibrary.read).toHaveBeenCalledTimes(2);expect(activeController().getState().snapshot.project.edits).toHaveLength(0);expect(testWorkspace.getState().documents[0].controller).toBe(c);
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
  click('New');await waitFor(()=>expect(activeController()).not.toBe(c));expect(testWorkspace.getState().documents).toHaveLength(2);
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
  click('New');await waitFor(()=>expect(activeController()).not.toBe(c));expect(testWorkspace.getState().documents).toHaveLength(2);expect(screen.getByText('Complete bars inserted before measure 1')).toBeInTheDocument();
  const destination=activeController();expect(c.getState().snapshot.project.edits).toHaveLength(1);change('Paste repetitions','2');click('Paste music');await waitFor(()=>expect(destination.getState().score.masterBars).toHaveLength(6));
  expect(destination.getState().snapshot.project.edits).toHaveLength(1);expect(destination.getState().snapshot.project.edits[0]).toMatchObject({type:'pasteMusic',options:{count:2}});
  expect(currentBeat(destination).notes[0].fret).toBe(5);click('Undo');await waitFor(()=>expect(destination.getState().score.masterBars).toHaveLength(4));
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
  const selectedHistory=c.getState().snapshot.project.edits.length;click('New');await waitFor(()=>expect(activeController()).not.toBe(c));expect(testWorkspace.getState().documents).toHaveLength(2);
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
  const oldHistory=c.getState();click('New');await waitFor(()=>expect(activeController()).not.toBe(c));const fresh=activeController();expect(fresh.getState().snapshot.project.edits).toHaveLength(0);expect(c.getState()).toBe(oldHistory);expect(screen.getByLabelText('Mute')).not.toBeChecked();expect(integration.loadDocument).toHaveBeenLastCalledWith(fresh.getState().snapshot.project,expect.objectContaining({score:fresh.getState().score}),0,0);
});
it('opens the export dialog and persists custom page layout through the existing history',async()=>{
  const c=await setup();click('Export score');const dialog=within(screen.getByRole('dialog',{name:'Export score'}));change('Export format','pdf');fireEvent.change(dialog.getByLabelText('Width (mm)'),{target:{value:'250'}});fireEvent.click(dialog.getByRole('button',{name:'Apply page layout'}));click('Export');await waitFor(()=>expect(c.getState().settings.page?.widthMm).toBe(250));await waitFor(()=>expect(integration.exportRun).toHaveBeenCalledWith(expect.objectContaining({format:'pdf',page:expect.objectContaining({widthMm:250})}),expect.objectContaining({revision:c.getState().revision,score:c.getState().score})));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());
});
it('opens saved mix and recorded voice without creating reset edits',async()=>{
  const saved={...blankProject(),edits:[{type:'setTrackMix' as const,trackId:'base/0',mix:{gain:.4,pan:.2,mute:true,solo:false}}]};const c=await setup(blankProject(),saved);const oldHistory=c.getState();click('Open');await waitFor(()=>expect(activeController()).not.toBe(c));const opened=activeController();expect(opened.getState().settings.mixes['base/0'].mute).toBe(true);expect(c.getState()).toBe(oldHistory);await waitFor(()=>expect(screen.getByLabelText('Mute')).toBeChecked());expect(opened.getState().snapshot.project.edits).toHaveLength(1);expect(integration.commits).not.toHaveBeenCalled();
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
  expect(screen.getByRole('button',{name:'Apply score info'})).toBeDisabled();change('Zoom (%)','125');click('Cancel export');await waitFor(()=>expect(integration.exportCancel).toHaveBeenCalled());expect(testWorkspace.getState().busy).toBe(true);await act(async()=>{finish(false);});await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());
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

it('refreshes fret after adding a document at the same indices',async()=>{
  const c=await setup();change('Fret','9');click('Set note');
  await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(9));
  const history=c.getState();click('New');
  await waitFor(()=>expect(activeController()).not.toBe(c));expect(currentBeat(activeController()).notes).toHaveLength(0);expect(c.getState()).toBe(history);
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
  const history=c.getState();click('New');
  await waitFor(()=>expect(activeController()).not.toBe(c));expect(activeController().getState().score.tracks).toHaveLength(1);expect(c.getState()).toBe(history);
  expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();click('Show instrument');expect(screen.getByRole('region',{name:'Instrument view'})).toHaveTextContent('Guitar');
  expect(screen.getByLabelText('Instrument view mode')).toHaveValue('auto');
});

it('switching restores per-tab views, resets musical selection and drafts, and retires one bound player',async()=>{
  const a=await setup();change('Fret','7');click('Set note');await waitFor(()=>expect(currentBeat(a).notes[0]?.fret).toBe(7));click('Select bar');change('Zoom (%)','137.5');change('Displayed tracks','all');click('Show instrument');change('Measure','3');change('Fret','19');const before=a.getState(),first=testWorkspace.getState().active;
  expect(screen.getAllByRole('region',{name:'Score workspace'})).toHaveLength(1);expect(integration.playerOptions).toHaveBeenCalledTimes(1);
  click('New');await waitFor(()=>expect(activeController()).not.toBe(a));const b=activeController();expect(screen.getByLabelText('Zoom (%)')).toHaveValue(100);expect(screen.getByLabelText('Measure')).toHaveValue(1);expect(screen.getByLabelText('Fret')).toHaveValue(0);expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();expect(screen.getByText(/0 notes.*0 beats/)).toBeInTheDocument();
  change('Zoom (%)','75');const bHistory=b.getState();fireEvent.click(screen.getAllByRole('tab')[0]);await waitFor(()=>expect(activeController()).toBe(a));expect(testWorkspace.getState().active.activationId).not.toBe(first.activationId);
  expect(screen.getByLabelText('Zoom (%)')).toHaveValue(137.5);expect(screen.getByLabelText('Displayed tracks')).toHaveValue('all');expect(screen.getByLabelText('Measure')).toHaveValue(3);expect(screen.getByLabelText('Fret')).toHaveValue(0);expect(screen.getByRole('region',{name:'Instrument view'})).toBeInTheDocument();expect(screen.getByText(/0 notes.*0 beats/)).toBeInTheDocument();
  expect(a.getState()).toBe(before);expect(b.getState()).toBe(bHistory);expect(integration.playerOptions).toHaveBeenCalledTimes(3);expect(integration.destroy).toHaveBeenCalledTimes(2);expect(screen.getAllByRole('region',{name:'Score workspace'})).toHaveLength(1);expect(integration.play).not.toHaveBeenCalled();expect(integration.playSelection).not.toHaveBeenCalled();expect(integration.playFromCursor).not.toHaveBeenCalled();
});
it.each([{ctrlKey:true},{metaKey:true}])('routes workspace New, Open, cycle and close shortcuts outside fields and dialogs: %j',async modifier=>{
  const a=await setup(blankProject(),blankProject()),id=a.getState().documentId;let score=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(score,{key:'n',...modifier});await waitFor(()=>expect(testWorkspace.getState().documents).toHaveLength(2));const b=activeController();score=screen.getByRole('region',{name:'Score workspace'});
  fireEvent.keyDown(score,{key:'o',...modifier});await waitFor(()=>expect(testWorkspace.getState().documents).toHaveLength(3));const c=activeController();
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'Tab',...modifier});await waitFor(()=>expect(activeController()).toBe(a));
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'Tab',shiftKey:true,...modifier});await waitFor(()=>expect(activeController()).toBe(c));
  for(const key of ['w','Tab','n','o'])fireEvent.keyDown(screen.getByLabelText('Fret'),{key,...modifier});expect(testWorkspace.getState().documents).toHaveLength(3);expect(activeController()).toBe(c);
  click('Browse scales');const dialog=screen.getByRole('dialog',{name:'Scale browser'});for(const key of ['w','Tab','n','o'])fireEvent.keyDown(dialog,{key,...modifier});expect(testWorkspace.getState().documents).toHaveLength(3);expect(activeController()).toBe(c);click('Close scales');
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'w',...modifier});await waitFor(()=>expect(testWorkspace.getState().documents).toHaveLength(2));expect(activeController()).toBe(b);expect(testWorkspace.getState().documents[0].id).toBe(id);
});
it.each([{open:'Edit chord diagram',dialog:'Harmony chord',close:'Cancel'},{open:'Browse scales',dialog:'Scale browser',close:'Close scales'},{open:'Export score',dialog:'Export score',close:'Cancel'}])('holds exactly one editor lease for $dialog and releases it when dismissed',async({open,dialog,close})=>{
  await setup();const begin=vi.spyOn(testWorkspace,'beginEditorOperation');click(open);expect(screen.getByRole('dialog',{name:dialog})).toBeInTheDocument();expect(begin).toHaveBeenCalledTimes(1);expect(testWorkspace.getState().busy).toBe(true);expect(screen.getByRole('tab')).toBeDisabled();expect(screen.getByRole('button',{name:'New'})).toBeDisabled();expect(screen.getByRole('button',{name:'Apply score info'})).toBeDisabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
  click(close);await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(begin).toHaveBeenCalledTimes(1);expect(screen.getByRole('tab')).toBeEnabled();expect(screen.getByRole('button',{name:'Apply score info'})).toBeEnabled();
});
it('uses its existing export dialog lease through page commit, frozen revision and late cancellation',async()=>{
  let finishRun!:(value:boolean)=>void,finishCancel!:()=>void;integration.exportRun.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finishRun=resolve;}));integration.exportCancel.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishCancel=resolve;}));const c=await setup(),begin=vi.spyOn(testWorkspace,'beginEditorOperation');
  click('Export score');change('Export format','pdf');const dialog=within(screen.getByRole('dialog',{name:'Export score'}));fireEvent.change(dialog.getByLabelText('Width (mm)'),{target:{value:'245'}});fireEvent.click(dialog.getByRole('button',{name:'Apply page layout'}));click('Export');await waitFor(()=>expect(integration.exportRun).toHaveBeenCalled());expect(c.getState().settings.page?.widthMm).toBe(245);expect(begin).toHaveBeenCalledTimes(1);expect(testWorkspace.getState().busy).toBe(true);
  const source=integration.exportRun.mock.calls.at(-1)?.[1];expect(source).toMatchObject({revision:c.getState().revision,score:c.getState().score,settings:c.getState().settings});click('Cancel export');await waitFor(()=>expect(integration.exportCancel).toHaveBeenCalledTimes(1));expect(testWorkspace.getState().busy).toBe(true);expect(screen.getByRole('tab')).toBeDisabled();
  await act(async()=>{finishRun(false);});expect(testWorkspace.getState().busy).toBe(true);await act(async()=>{finishCancel();});await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(begin).toHaveBeenCalledTimes(1);
});
it.each(['success','cancel','error'] as const)('direct GP export reserves and releases one lease on %s',async result=>{
  const c=await setup(),bridge=documentBridges.get(c.getState().documentId)!,begin=vi.spyOn(testWorkspace,'beginEditorOperation');let decide!:(value:boolean)=>void;vi.mocked(bridge.confirmExport).mockImplementationOnce(()=>new Promise<boolean>(resolve=>{decide=resolve;}));if(result==='error')vi.mocked(bridge.exportGp).mockRejectedValueOnce(new Error('GP write failed'));else vi.mocked(bridge.exportGp).mockResolvedValueOnce(result==='success');
  click('Export GP');await waitFor(()=>expect(bridge.confirmExport).toHaveBeenCalledTimes(1));expect(testWorkspace.getState().busy).toBe(true);expect(begin).toHaveBeenCalledTimes(1);await act(async()=>{decide(result!=='cancel');});await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(begin).toHaveBeenCalledTimes(1);if(result==='cancel')expect(bridge.exportGp).not.toHaveBeenCalled();else expect(bridge.exportGp).toHaveBeenCalledWith(expect.any(Uint8Array),c.getState().revision);if(result==='error')expect(screen.getByRole('alert')).toHaveTextContent('GP write failed');
});
it.each(['success','cancel','error'] as const)('backing import holds its origin lease through staging and releases once on %s',async result=>{
  const c=await setup(),begin=vi.spyOn(testWorkspace,'beginEditorOperation'),assetId='d'.repeat(64);let finish!:(value:{assetId:string;token:string;info:AssetInfo;durationMs:number}|null)=>void,reject!:(error:Error)=>void;integration.stageBacking.mockImplementationOnce(()=>new Promise((resolve,fail)=>{finish=resolve;reject=fail;}));
  click('Import backing');expect(testWorkspace.getState().busy).toBe(true);expect(begin).toHaveBeenCalledTimes(1);expect(screen.getByRole('tab')).toBeDisabled();await act(async()=>{if(result==='error')reject(new Error('Backing picker failed'));else finish(result==='cancel'?null:{assetId,token:'leased-backing',info:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20},durationMs:1000});});await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(begin).toHaveBeenCalledTimes(1);expect(c.getState().snapshot.project.edits).toHaveLength(result==='success'?1:0);if(result==='error')expect(screen.getByRole('alert')).toHaveTextContent('Backing picker failed');
});

it('keeps connected focus on the new active tab after toolbar Close score',async()=>{
  const a=await setup();click('New');await waitFor(()=>expect(activeController()).not.toBe(a));const origin=screen.getByRole('button',{name:'Close score'});origin.focus();fireEvent.click(origin);await waitFor(()=>expect(activeController()).toBe(a));
  expect(document.activeElement).not.toBe(document.body);expect(document.activeElement?.isConnected).toBe(true);expect(screen.getByRole('tab',{selected:true})).toHaveFocus();
});
it('keeps connected focus after Ctrl W from the score',async()=>{
  const a=await setup();click('New');await waitFor(()=>expect(activeController()).not.toBe(a));screen.getByRole('region',{name:'Score workspace'}).focus();fireEvent.keyDown(document.activeElement!,{key:'w',ctrlKey:true});await waitFor(()=>expect(activeController()).toBe(a));
  expect(document.activeElement).not.toBe(document.body);expect(document.activeElement?.isConnected).toBe(true);expect(screen.getByRole('tab',{selected:true})).toHaveFocus();
});
it('cycles twice with Ctrl Tab dispatched through the actual focused element',async()=>{
  const a=await setup();click('New');await waitFor(()=>expect(activeController()).not.toBe(a));const b=activeController();screen.getByRole('region',{name:'Score workspace'}).focus();
  fireEvent.keyDown(document.activeElement!,{key:'Tab',ctrlKey:true});await waitFor(()=>expect(activeController()).toBe(a));expect(document.activeElement).not.toBe(document.body);expect(document.activeElement?.isConnected).toBe(true);
  fireEvent.keyDown(document.activeElement!,{key:'Tab',ctrlKey:true});await waitFor(()=>expect(activeController()).toBe(b));expect(document.activeElement).not.toBe(document.body);expect(document.activeElement?.isConnected).toBe(true);expect(screen.getByRole('tab',{selected:true})).toHaveFocus();
});
it('canceled toolbar close retains focus on its connected originating action',async()=>{
  const c=await setup();change('Fret','7');click('Set note');await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(7));const bridge=documentBridges.get(c.getState().documentId)!;vi.mocked(bridge.askUnsaved).mockResolvedValueOnce('cancel');const origin=screen.getByRole('button',{name:'Close score'});origin.focus();fireEvent.click(origin);
  await waitFor(()=>expect(bridge.askUnsaved).toHaveBeenCalledTimes(1));await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(activeController()).toBe(c);expect(origin.isConnected).toBe(true);expect(origin).toHaveFocus();
});
