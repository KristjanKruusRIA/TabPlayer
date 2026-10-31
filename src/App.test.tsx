// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import type { BarDesign } from './ScoreView';
import {importer} from '@coderline/alphatab';
import { WorkspaceApp,type WorkspaceSession } from './workspace/WorkspaceApp';
import { WorkspaceController } from './workspace/WorkspaceController';
import type { DocumentSnapshot,NativeWorkspaceBridge,WorkspaceSnapshot } from './workspace/types';
import type { DocumentCandidate,Protection } from './project';
import type { NativeAudioBridge } from './audio/bridge';
import type { ExportNativeBridge } from './export/bridge';
import { DocumentController } from './controller';
import { EDIT_LOCKED_MESSAGE, FINALIZED_MESSAGE, blankProject, type EditCommand, type Project, type AssetInfo } from './project';
import type { NativeBridge } from './bridge';
import {buildScore,exportGp,effectiveAudioSettings,trackIdentity,type BuiltDocument} from './engine';
import {createHash} from 'node:crypto';
import { defaultMix } from './document-settings';
import { canonicalDrumKitMix, defaultDrumElement } from './audio/drum-kit';
import type { DrumElementMix, DrumKitElement } from './edit-types';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import type { BackingWaveform as WaveformReceipt,BackingWaveformProps,NativeBackingWaveformBridge,WaveformSourceInput } from './audio/backing-waveform-types';
import {getHarmonyChord} from './harmony/chord-source';
import type {HarmonyLibrary,HarmonyLibraryEntry} from './editor/harmony-types';
import type {ReferenceSyncControls} from './audio/reference-sync-types';
const engravingView=vi.hoisted(()=>vi.fn());
const waveform=vi.hoisted(()=>({props:[] as BackingWaveformProps[],read:vi.fn(async(document:BackingWaveformProps['document'],source:WaveformSourceInput,buckets:number,owner:NativeBackingWaveformBridge['owner']):Promise<WaveformReceipt>=>({owner,document,source,durationMs:16000,sampleRate:1000,frameCount:16000,channels:1,bucketCount:buckets,peaks:Array.from({length:buckets},()=>({min:[0,0],max:[0,0]}))})),embedded:vi.fn(async(sourceKey:string,_bytes:Uint8Array):Promise<WaveformSourceInput>=>({kind:'embedded',sourceKey:sourceKey.toLowerCase(),sha256:'e'.repeat(64),bytesBase64:'UklGRg=='}))}));
vi.mock('./audio/BackingWaveform',()=>({BackingWaveform:(props:BackingWaveformProps)=>{waveform.props.push(props);return <section aria-label="Backing waveform"><button onClick={()=>{}}>Waveform probe</button></section>;}}));
vi.mock('./audio/backing-waveform-bridge',()=>({createDocumentBackingWaveformBridge:(owner:NativeBackingWaveformBridge['owner'])=>({owner:Object.freeze({...owner}),read:(document:BackingWaveformProps['document'],source:WaveformSourceInput,buckets:number)=>waveform.read(document,source,buckets,owner)}),makeEmbeddedWaveformSource:waveform.embedded}));
const documentBridges=vi.hoisted(()=>new Map<string,NativeBridge>());
vi.mock('./bridge',async original=>({...await original<typeof import('./bridge')>(),createDocumentBridge:(id:string)=>{const bridge=documentBridges.get(id);if(!bridge)throw new Error('Missing addressed document bridge');return bridge;}}));
const personalLibrary=vi.hoisted(()=>({read:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]})),put:vi.fn(async(entry:HarmonyLibraryEntry):Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[entry]})),remove:vi.fn(async():Promise<HarmonyLibrary>=>({format:'TabPlayerHarmonyLibrary',version:1,entries:[]}))}));
vi.mock('./harmony/library',async original=>({...await original<typeof import('./harmony/library')>(),readHarmonyLibrary:personalLibrary.read,putHarmonyLibraryEntry:personalLibrary.put,removeHarmonyLibraryEntry:personalLibrary.remove}));

const integration=vi.hoisted(()=>({running:false,players:[] as {getState:()=>PlaybackState;publish:(patch:Partial<PlaybackState>)=>void;generation:number;built:BuiltDocument|null}[],seekToMeasure:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),loadDocument:vi.fn(),beforeScoreChange:vi.fn(),destroy:vi.fn(),playerOptions:vi.fn(),stop:vi.fn(),stageBacking:vi.fn<NativeAudioBridge['stageBacking']>(),commits:vi.fn(),audition:vi.fn(),activeNotes:vi.fn((_trackId:string)=>[]),practiceSpeed:100,practiceFixed:false,setPractice:vi.fn(),play:vi.fn(),pause:vi.fn(),playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn(),exportOptions:vi.fn(),exportBusy:false,exportRun:vi.fn(async(_options:unknown,_source?:unknown)=>true),exportCancel:vi.fn(async()=>{})}));
vi.mock('./audio/bridge',()=>({createDocumentAudioBridge:vi.fn(()=>({prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:integration.stageBacking,stageEmbeddedBacking:vi.fn(async()=>null)} satisfies NativeAudioBridge))}));
vi.mock('./export/bridge',()=>({createDocumentExportBridge:vi.fn(()=>({exportPdf:vi.fn(async()=>null),exportMidi:vi.fn(async()=>false),exportMusicXml:vi.fn(async()=>false),exportAsciiTab:vi.fn(async()=>false),exportGp5:vi.fn(async()=>false),exportSvg:vi.fn(async()=>false),exportPng:vi.fn(async()=>false),exportTrackFiles:vi.fn(async()=>false),exportAudio:vi.fn(async()=>null),status:vi.fn(async()=>null),cancel:vi.fn(async()=>{})} satisfies ExportNativeBridge))}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:(options:unknown)=>{integration.exportOptions(options);return {busy:integration.exportBusy,progress:undefined,run:integration.exportRun,cancel:integration.exportCancel};}}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  built:BuiltDocument|null=null;state:PlaybackState={ready:true,playing:integration.running,time:integration.running?1234:0,endTime:4000,measure:integration.running?1:0,speed:integration.practiceSpeed,metronome:false,practice:{settings:{...structuredClone(DEFAULT_PRACTICE),tempo:integration.practiceFixed?{kind:'fixed',bpm:90}:{kind:'relative',ratio:integration.practiceSpeed/100}},phase:integration.running?'playing':'idle',countInRemaining:0,completedPasses:0,effectiveRatio:integration.practiceSpeed/100,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:integration.running?{startTick:0,endTick:3840}:null,error:null};
  constructor(private options:{bridge:NativeAudioBridge;onEdit:(command:EditCommand)=>void|Promise<void>}){integration.playerOptions(options);integration.players.push(this);}
  private listeners=new Set<()=>void>();subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};getState=()=>this.state;
  publish=(patch:Partial<PlaybackState>)=>{this.state={...this.state,...patch};for(const listener of this.listeners)listener();};
  generation=7;cursorPlaybackChoices=(target:{bar:number;beat:number})=>target?[{generation:7,occurrenceIndex:target.bar,startTick:target.bar*3840+target.beat*960}]:[];
  selectionPlaybackChoices=()=>[{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:960}];
  playbackOccurrences=()=>Array.from({length:this.built?.score.masterBars.length??4},(_,bar)=>({bar,occurrence:0,startTick:bar*3840,endTick:(bar+1)*3840,startMs:bar*2000,endMs:(bar+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]}));
  backingTimeline=()=>({generation:7,durationTick:15360,tempos:[{tick:0,bpm:120}],occurrences:this.playbackOccurrences()});
  backingScoreSelection=(target:{bar:number;beat:number})=>({points:[{tick:target.bar*3840+target.beat*960,anchor:{bar:target.bar,occurrence:0,ratio:target.beat/4}}],spans:[]});
  playFromCursor=integration.playFromCursor;playSelection=integration.playSelection;loopSelection=integration.loopSelection;
  activeNotes=(trackId:string)=>integration.activeNotes(trackId);
  focus=()=>null;setFocus=async()=>{};soundPreview=()=>null;previewSound=async()=>{};
  loadDocument=async(project:unknown,built:BuiltDocument,track:number,documentEpoch:number)=>{this.built=built;integration.loadDocument(project,built,track,documentEpoch);};
  audition=integration.audition;
  beforeScoreChange=integration.beforeScoreChange;destroy=integration.destroy;
  play=integration.play;pause=integration.pause;stop=integration.stop;seekToMeasure=integration.seekToMeasure;setSpeed=vi.fn();setLoop=integration.setLoop;clearLoop=integration.clearLoop;setMetronome=vi.fn();
  setPractice=integration.setPractice;exportPracticeRatio=()=>integration.practiceFixed?null:this.state.speed/100;
  devices=async()=>[];deviceId=()=>null;selectDevice=vi.fn();backingDurationMs=()=>undefined;
  mix=(track:{index:number})=>{const value=this.built?.settings.mixes[this.identity(track.index)];return value?{mute:value.mute,solo:value.solo,volume:value.gain,pan:value.pan,...(value.drumKit?{drumKit:value.drumKit}:{})}:undefined;};
  setMix=(track:number,patch:object)=>this.options.onEdit({type:'setTrackMix',trackId:`base/${track}`,mix:{...(this.built?.settings.mixes[`base/${track}`]??defaultMix()),...patch}});
  setMute=(track:number,mute:boolean)=>this.setMix(track,{mute});setSolo=(track:number,solo:boolean)=>this.setMix(track,{solo});setTrackVolume=(track:number,gain:number)=>this.setMix(track,{gain});setPan=(track:number,pan:number)=>this.setMix(track,{pan});
  identity=(track:number)=>{const found=this.built?.score.tracks[track];return found?trackIdentity(found):`base/${track}`;};
  setDrumElement=(track:number,element:DrumKitElement,patch:Partial<DrumElementMix>)=>{const id=this.identity(track),mix=this.built?.settings.mixes[id]??defaultMix(),next=canonicalDrumKitMix({...mix.drumKit,[element]:{...defaultDrumElement(),...mix.drumKit?.[element],...patch}}),{drumKit:_kit,...rest}=mix;return this.options.onEdit({type:'setTrackMix',trackId:id,mix:next?{...rest,drumKit:next}:rest});};previewDrumElement=async()=>{};
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
afterEach(()=>{cleanup();vi.clearAllMocks();waveform.props=[];integration.exportBusy=false;integration.practiceSpeed=100;integration.practiceFixed=false;integration.running=false;integration.players=[];vi.unstubAllGlobals();});

let testWorkspace:WorkspaceController;
let appRender:ReturnType<typeof render>;

it('shows score only when a template baseline removed original embedded backing',async()=>{
  const score=buildScore(blankProject());score.backingTrack={rawAudioFile:new Uint8Array([82,73,70,70])};
  const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockImplementation(()=>score);
  try{
    await setup({...blankProject(),base:{kind:'file',filename:'Original.gp',bytesBase64:'AA==',sha256:'a'.repeat(64)},baselineEdits:[{type:'setBacking',backing:null}]});
    fireEvent.click(within(screen.getByRole('navigation',{name:'Workspace panes'})).getByRole('button',{name:'Backing'}));
    expect(screen.getByText('Score only')).toBeVisible();expect(screen.queryByText('Original embedded audio, if available')).not.toBeInTheDocument();
  }finally{load.mockRestore();}
});
const activeController=()=>testWorkspace.getState().documents.find(entry=>entry.id===testWorkspace.getState().active.documentId)!.controller;
/** The protection the next document set up starts with; the fake bridge keeps its own state from there. */
const startingProtection:{value:Protection|undefined}={value:undefined};
async function setup(initial=blankProject(),openProject?:Project,options:{width?:number;session?:WorkspaceSession;workspaceHeight?:number;instrumentVisible?:boolean}={}) {
  Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:options.width??1280});
  vi.stubGlobal('ResizeObserver',class {
    constructor(private callback:ResizeObserverCallback){}
    observe(target:Element){if(options.workspaceHeight!==undefined&&target.classList.contains('workstation-workspace'))this.callback([{target,contentRect:new DOMRect(0,0,options.width??1280,options.workspaceHeight),borderBoxSize:[],contentBoxSize:[],devicePixelContentBoxSize:[]}],this);}
    unobserve(){}disconnect(){}
  });
  documentBridges.clear();let next=0,activation=0,active={documentId:'',activationId:''};
  const records=new Map<string,DocumentSnapshot>(),staged=new Map<string,DocumentCandidate>();
  const add=(project:Project,path:string|null=null)=>{
    const documentId=`app-document-${++next}`;let protection=startingProtection.value,lock=project.lock,edits:EditCommand[]=[...project.edits],cursor=edits.length,revision=0,assets:Record<string,AssetInfo>={...project.assets},dirty=cursor>0;
    const record=():DocumentSnapshot=>({documentId,revision,snapshot:{project:{...project,assets,edits:edits.slice(0,cursor),...(lock?{lock}:{})},canUndo:cursor>0,canRedo:cursor<edits.length,redoEdit:edits[cursor]??null,dirty,path,...(protection?{protection}:{})}});
    const update=()=>{revision++;const value=record();records.set(documentId,value);return value;};
    const check=(expected:number)=>{if(expected!==revision||!records.has(documentId))throw new Error('Invalid addressed revision');};
    const bridge:NativeBridge={documentId,snapshot:async()=>record(),cancelAsset:vi.fn(async()=>true),
      readBackingAsset:async(_assetId:string,_revision:number):Promise<Uint8Array>=>{throw new Error('Backing asset reads are not implemented.');},
      protect:async(request,expected)=>{check(expected);if(request.kind==='unlockEditing'){if(request.password!=='teacher teacher')throw new Error('That password is not correct.');protection={edit:'unlocked',open:false};}else if(request.kind==='lockEditing')protection={edit:'locked',open:false};return update();},
      setLock:async(next,expected)=>{check(expected);if((lock?.kind??null)===(next?.kind??null))return record();if(next)lock=next;else lock=undefined;dirty=true;return update();},
      applyEdit:async(command,expected,assetToken)=>{check(expected);if(protection?.edit==='locked'&&command.type!=='setTrackMix')throw new Error(EDIT_LOCKED_MESSAGE);if(lock&&command.type!=='setTrackMix')throw new Error(FINALIZED_MESSAGE);integration.commits(command,assetToken);if(assetToken&&command.type==='setBacking'&&command.backing)assets={...assets,[command.backing.assetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20}};edits=edits.slice(0,cursor);edits.push(command);cursor++;dirty=true;return update();},
      undo:async expected=>{check(expected);if(lock)throw new Error(FINALIZED_MESSAGE);cursor--;dirty=true;return update();},redo:async expected=>{check(expected);if(lock)throw new Error(FINALIZED_MESSAGE);cursor++;dirty=true;return update();},saveProject:async()=>null,exportGp:vi.fn(async()=>false),askUnsaved:vi.fn(async()=> 'discard' as const),confirmExport:vi.fn(async()=>false)};
    records.set(documentId,record());documentBridges.set(documentId,bridge);return documentId;
  };
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()],active:{...active}});
  const activate=(id:string)=>{if(id!==active.documentId)active={documentId:id,activationId:`app-activation-${++activation}`};return snapshot();};
  const stage=(project:Project,path:string|null,token:string)=>{const candidate={project,path,token};staged.set(token,candidate);return candidate;};
  activate(add(initial));
  const bridge:NativeWorkspaceBridge={snapshot:async()=>snapshot(),readDocument:async()=>openProject?{kind:'candidate',candidate:stage(openProject,'saved.tabplayer','opened-document')}:null,createBlankDocument:async()=>stage(blankProject(),null,'new-document'),cancelDocument:async token=>staged.delete(token),addDocument:async token=>{const candidate=staged.get(token);if(!candidate)throw new Error('Missing document candidate');staged.delete(token);return activate(add(candidate.project,candidate.path));},activateDocument:async id=>activate(id),closeDocuments:async decisions=>{const order=[...records.keys()],index=order.indexOf(active.documentId);for(const decision of decisions)records.delete(decision.documentId);if(!records.size)add(blankProject());return records.has(active.documentId)?snapshot():activate([...records.keys()][Math.min(index,records.size-1)]);}};
  testWorkspace=await WorkspaceController.create(bridge);if(options.instrumentVisible){const entry=testWorkspace.getState().documents[0];testWorkspace.setView(entry.id,{...entry.view,instrumentVisible:true});}const controller=activeController();appRender=render(<WorkspaceApp workspace={testWorkspace} session={options.session}/>);return controller;
}
function exposeFunctionalControl(element:HTMLElement){
  const panes=screen.queryByRole('navigation',{name:'Workspace panes'});
  const task=element.closest('.inspector')?'Inspector':element.closest('.track-settings')?'Track':element.closest('.sound-panel')?'Sound':element.closest('.backing-panel')?'Backing':null;
  if(task&&panes&&element.closest('[hidden]'))fireEvent.click(within(panes).getByRole('button',{name:task}));
  if(element.closest('.track-mixer')&&element.closest('[hidden]'))fireEvent.click(screen.getByRole('button',{name:'Mixer'}));
  const ancestors:HTMLDetailsElement[]=[];for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)ancestors.unshift(parent);
  for(const details of ancestors)if(!details.open)fireEvent.click(details.querySelector('summary')!);
  return element;
}
function functionalButton(name:string|RegExp){return exposeFunctionalControl(screen.queryByRole('button',{name})??screen.getByRole('button',{name,hidden:true}));}
const change=(label:string,value:string)=>fireEvent.change(exposeFunctionalControl(screen.getByLabelText(label)),{target:{value}});
const click=(name:string)=>{
  // Selecting a track is now reached through Mixer; return to the viewer when that was the active task.
  const restoreInstrument=/^Track \d+:/.test(name)&&screen.queryByRole('button',{name:'Instrument'})?.getAttribute('aria-pressed')==='true';
  fireEvent.click(functionalButton(name));if(restoreInstrument)fireEvent.click(screen.getByRole('button',{name:'Instrument'}));
};
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
  fireEvent.click(exposeFunctionalControl(screen.getByText('Selected playback',{selector:'summary'})));click('Play from cursor');
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

  const contextCard=within(screen.getByRole('region',{name:'Selection context'}));
  fireEvent.click(contextCard.getByRole('button',{name:'Note'}));
  expect(clipboardSummary).not.toBeVisible();
  fireEvent.keyDown(workspace,{key:'v',ctrlKey:true,shiftKey:true});
  expect(clipboardSummary).toBeVisible();
  expect(clipboardSummary).toHaveFocus();
});

it('leaves the score alone from the Sound view: no cut, paste or select-all, while undo, palette and play still work',async()=>{
  const c=await setup(),workspace=screen.getByRole('region',{name:'Score workspace'});
  click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  click('Select bar');fireEvent.keyDown(workspace,{key:'c',ctrlKey:true});
  const edits=()=>c.getState().snapshot.project.edits.length,view=screen.getByRole('radiogroup',{name:'View'});
  fireEvent.click(within(view).getByRole('radio',{name:'Sound'}));
  const rig=await screen.findByRole('region',{name:'Sound rig'}),at=edits(),selection=c.getState().snapshot;
  for(const init of [{key:'x',ctrlKey:true},{key:'v',ctrlKey:true},{key:'v',ctrlKey:true,shiftKey:true},{key:'a',ctrlKey:true},{key:'Escape'},{key:'x',metaKey:true},{key:'v',metaKey:true}])fireEvent.keyDown(within(rig).getByRole('tab',{name:/^Amp, /}),init);
  fireEvent.keyDown(rig,{key:'p',ctrlKey:true,shiftKey:true});
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(edits()).toBe(at);expect(c.getState().snapshot).toBe(selection);
  expect(screen.getByRole('dialog',{name:/command/i})).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('combobox',{name:/command/i}),{key:'Escape'});
  expect(screen.queryByRole('dialog',{name:/command/i})).not.toBeInTheDocument();
  // Undo is a document command, so it still works from here, and Space still plays.
  fireEvent.keyDown(rig,{key:'z',ctrlKey:true});await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  // Back in the score the same keys act on it again.
  fireEvent.click(within(view).getByRole('radio',{name:'Score'}));
  click('Select bar');fireEvent.keyDown(workspace,{key:'x',ctrlKey:true});
  // The undo left one edit fewer; a cut in the score is a new edit again.
  await waitFor(()=>expect(edits()).toBe(at));
});

it.each(['Add pitched track','Add percussion track'])('omits string caret context for %s',async action=>{
  const c=await setup();click(action);await waitFor(()=>expect(c.getState().score.tracks).toHaveLength(2));
  fireEvent.click(functionalButton(/^Track 2:/));
  expect(engravingView.mock.lastCall?.[0]).toMatchObject({editTarget:{track:1,staff:0,bar:0,voice:0,beat:0},editNoteIndex:null});
  expect(engravingView.mock.lastCall?.[0].editString).toBeUndefined();
});

it('starts Harmony at its heading during initial library loading and focuses name when ready',async()=>{
  let finish!:(library:HarmonyLibrary)=>void;personalLibrary.read.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  await setup();click('Edit chord diagram');const dialog=screen.getByRole('dialog',{name:'Harmony chord'});
  const initialFocus=document.activeElement;await act(async()=>finish({format:'TabPlayerHarmonyLibrary',version:1,entries:[]}));
  await waitFor(()=>expect(within(dialog).getByLabelText('Chord name').closest('fieldset')).not.toHaveAttribute('aria-disabled'));
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
it('keeps untouched old score preferences omitted and derived status out of persisted view',async()=>{
  const c=await setup(),before=c.getState(),setView=vi.spyOn(testWorkspace,'setView');
  const rendered=engravingView.mock.lastCall![0],onDisplayStatus=rendered.onDisplayStatus;
  expect(rendered).toMatchObject({display:{layout:'parchment',zoomMode:'manual'},page:expect.objectContaining({scale:expect.any(Number)})});
  expect(testWorkspace.getState().documents[0].view).not.toHaveProperty('scoreDisplay');
  act(()=>onDisplayStatus({zoomPercent:63.25,fitLimited:false,pageError:null}));
  act(()=>onDisplayStatus({zoomPercent:63.25,fitLimited:false,pageError:null}));
  expect(setView).not.toHaveBeenCalled();
  expect(engravingView.mock.lastCall![0].display).toBe(rendered.display);expect(engravingView.mock.lastCall![0].onDisplayStatus).toBe(onDisplayStatus);
  change('Displayed tracks','all');change('Zoom (%)','137.5');
  expect(testWorkspace.getState().documents[0].view).not.toHaveProperty('scoreDisplay');
  expect(c.getState()).toBe(before);expect(c.getState().snapshot.dirty).toBe(false);
});
it('persists layout and fit choices, retains manual percent and restores them across documents without edits',async()=>{
  const c=await setup(),before=c.getState(),id=testWorkspace.getState().active.documentId;
  const loads=integration.loadDocument.mock.calls.length,beforeChanges=integration.beforeScoreChange.mock.calls.length;
  change('Zoom (%)','137.5');change('Display mode','grid');click('Fit page');
  expect(testWorkspace.getState().documents[0].view).toMatchObject({zoom:137.5,scoreDisplay:{layout:'grid',zoomMode:'fitPage'}});
  const setView=vi.spyOn(testWorkspace,'setView');
  act(()=>engravingView.mock.lastCall![0].onDisplayStatus({zoomPercent:72.5,fitLimited:false,pageError:null}));
  expect(screen.getByLabelText('Actual zoom')).toHaveTextContent('72.5%');expect(screen.getByLabelText('Zoom (%)')).toHaveValue(137.5);expect(setView).not.toHaveBeenCalled();
  change('Display mode','verticalScreen');expect(screen.getByRole('button',{name:'Fit width'})).toHaveAttribute('aria-pressed','true');
  expect(testWorkspace.getState().documents[0].view.scoreDisplay).toEqual({layout:'verticalScreen',zoomMode:'fitWidth'});
  change('Zoom (%)','142.75');expect(testWorkspace.getState().documents[0].view).toMatchObject({zoom:142.75,scoreDisplay:{layout:'verticalScreen',zoomMode:'manual'}});
  expect(screen.queryByLabelText('Actual zoom')).not.toBeInTheDocument();
  change('Display mode','horizontalPage');click('Fit width');
  expect(c.getState()).toBe(before);expect(c.getState().snapshot).toMatchObject({dirty:false,canUndo:false,canRedo:false});
  expect(integration.loadDocument).toHaveBeenCalledTimes(loads);expect(integration.beforeScoreChange).toHaveBeenCalledTimes(beforeChanges);
  click('New');await waitFor(()=>expect(activeController()).not.toBe(c));
  expect(screen.getByLabelText('Display mode')).toHaveValue('parchment');expect(screen.getByLabelText('Zoom (%)')).toHaveValue(100);
  await act(async()=>{await testWorkspace.activate(id);});
  expect(screen.getByLabelText('Display mode')).toHaveValue('horizontalPage');expect(screen.getByLabelText('Zoom (%)')).toHaveValue(142.75);
  expect(screen.getByRole('button',{name:'Fit width'})).toHaveAttribute('aria-pressed','true');expect(c.getState()).toBe(before);
});
it('wires Design mode bar widths: handles only while on, one edit per width, imported weights as the base, restore clears, busy refuses',async()=>{
  const c=await setup(),original=c.getState().score,last=()=>engravingView.mock.lastCall![0] as {barDesign:BarDesign|null};
  expect(last().barDesign).toBeNull();c.getState().score.tracks[0].staves[0].bars[2].displayScale=2;c.getState().score.masterBars[1].displayScale=3;
  fireEvent.click(screen.getByRole('checkbox',{name:/Design mode/}));
  const design=()=>last().barDesign!;expect(design()).not.toBeNull();
  expect(design().scaleOf(1)).toBe(1);expect(design().defaultOf(1)).toBe(1);expect(design().defaultOf(2)).toBe(2);expect(design().scaleOf(2)).toBe(2);expect(design().defaultOf(1)).toBe(1);
  act(()=>design().onScale(1,1.5));await waitFor(()=>expect(c.getState().settings.engraving.barWidths).toEqual([{bar:1,scale:1.5}]));
  expect(c.getState().snapshot.project.edits).toHaveLength(1);expect(c.getState().score).toBe(original);expect(design().scaleOf(1)).toBe(1.5);
  // The current value records nothing.
  act(()=>design().onScale(1,1.5));expect(c.getState().snapshot.project.edits).toHaveLength(1);
  act(()=>design().onScale(1,1));await waitFor(()=>expect(c.getState().settings.engraving.barWidths).toBeUndefined());expect(c.getState().snapshot.project.edits).toHaveLength(2);
  act(()=>design().onScale(0,2));await waitFor(()=>expect(c.getState().settings.engraving.barWidths).toHaveLength(1));
  click('Restore default widths');await waitFor(()=>expect(c.getState().settings.engraving.barWidths).toBeUndefined());expect(c.getState().snapshot.project.edits).toHaveLength(4);
  fireEvent.click(screen.getByRole('checkbox',{name:/Design mode/}));expect(last().barDesign).toBeNull();
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
  await waitFor(()=>{expect(screen.getByLabelText('Destination track for copied track 1')).toHaveValue('0');expect(screen.getByLabelText('Paste repetitions')).toBeEnabled();});
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
  click('Export score');change('Export format','wav');expect(screen.getByRole('radio',{name:'Current speed coefficient'})).toHaveAttribute('aria-disabled','true');
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
  fireEvent.click(exposeFunctionalControl(screen.getByLabelText('Mute')));await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));expect(c.getState().score).toBe(score);
  expect(integration.beforeScoreChange).not.toHaveBeenCalled();expect(integration.loadDocument).toHaveBeenLastCalledWith(c.getState().snapshot.project,expect.objectContaining({score,settings:c.getState().settings}),0,0);
});
it('shows the Sound rig over the whole workspace while the transport stays, and edits through the same undoable history',async()=>{
  const c=await setup(),score=c.getState().score,before=c.getState().snapshot.project.edits.length;
  const view=screen.getByRole('radiogroup',{name:'View'});expect(within(view).getByRole('radio',{name:'Score'})).toBeChecked();
  expect(screen.queryByRole('region',{name:'Sound rig'})).not.toBeInTheDocument();
  fireEvent.click(within(view).getByRole('radio',{name:'Sound'}));
  const rig=await screen.findByRole('region',{name:'Sound rig'});
  // The transport is still there to play and loop while the sound changes, and the inspector's panel gives way to the rig.
  expect(document.querySelector('[aria-keyshortcuts="Space"]')).toBeInTheDocument();
  expect(screen.getAllByLabelText('Sound source')).toHaveLength(1);expect(rig).toContainElement(screen.getByLabelText('Sound source'));
  expect(within(rig).getAllByRole('tab')).toHaveLength(18);
  // One knob drag is one edit in the document's history, and undo takes it back.
  fireEvent.click(within(rig).getByRole('tab',{name:'Drive, bypassed'}));
  const drive=within(rig).getByRole('slider',{name:'drive Drive'});
  fireEvent.pointerDown(drive,{clientY:300,pointerId:1});for(const y of [290,270,240])fireEvent.pointerMove(drive,{clientY:y,pointerId:1});fireEvent.pointerUp(drive,{clientY:240,pointerId:1});
  await waitFor(()=>expect(c.getState().settings.sounds['base/0'].effects.drive.drive).toBe(.88));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+1);expect(c.getState().score).toBe(score);
  fireEvent.click(within(rig).getByRole('switch',{name:'Enable drive'}));
  await waitFor(()=>expect(c.getState().settings.sounds['base/0'].effects.drive.enabled).toBe(true));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+2);
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  await waitFor(()=>expect(c.getState().settings.sounds['base/0'].effects.drive.enabled).toBe(false));
  expect(c.getState().settings.sounds['base/0'].effects.drive.drive).toBe(.88);
  // Back to the score: the rig is gone and the inspector's Sound panel is back, unchanged.
  fireEvent.click(within(view).getByRole('radio',{name:'Score'}));
  expect(screen.queryByRole('region',{name:'Sound rig'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sound source')).toBeInTheDocument();
  expect(c.getState().settings.sounds['base/0'].effects.drive.drive).toBe(.88);
});
it('shows the Mixer view as the third View option while the transport stays, and edits mix through the same undoable history',async()=>{
  const c=await setup({...blankProject(),edits:[{type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,28]}]});
  change('Sound source','green-guitar');await waitFor(()=>expect(c.getState().settings.sounds['base/0'].voiceId).toBe('green-guitar'));
  const score=c.getState().score,before=c.getState().snapshot.project.edits.length;
  const view=screen.getByRole('radiogroup',{name:'View'});
  expect(within(view).getAllByRole('radio').map(r=>r.textContent)).toEqual(['Score','Sound','Mixer']);
  fireEvent.click(within(view).getByRole('radio',{name:'Mixer'}));
  expect(document.querySelector('.workstation-workspace')).toHaveAttribute('data-view','mixer');
  expect(document.querySelector('[aria-keyshortcuts="Space"]')).toBeInTheDocument();
  const mixer=screen.getByRole('region',{name:'Mixer'});
  expect(within(mixer).getByRole('region',{name:'Focus'})).toBeInTheDocument();
  const strip1=within(mixer).getByRole('region',{name:'Channel 1: Guitar'});
  expect(within(strip1).getByText('Green Guitar')).toBeInTheDocument();
  expect(within(strip1).getByText('Bypass')).toBeInTheDocument();
  const volume=within(strip1).getByRole('slider',{name:'Volume Guitar'});
  expect(volume).toHaveAttribute('aria-orientation','vertical');
  fireEvent.keyDown(volume,{key:'ArrowDown'});
  await waitFor(()=>expect(c.getState().settings.mixes['base/0'].gain).toBe(.95));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+1);expect(c.getState().score).toBe(score);
  const pan=within(strip1).getByRole('slider',{name:'Pan Guitar'});
  fireEvent.keyDown(pan,{key:'ArrowRight'});
  await waitFor(()=>expect(c.getState().settings.mixes['base/0'].pan).toBe(.05));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+2);
  fireEvent.click(within(strip1).getByLabelText('Mute'));
  await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(false));
  const strip2=within(mixer).getByRole('region',{name:'Channel 2: Bass'});
  fireEvent.click(within(strip2).getByRole('button',{name:'Track 2: Bass'}));
  expect(within(strip2).getByRole('button',{name:'Track 2: Bass'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(within(view).getByRole('radio',{name:'Score'}));
  expect(document.querySelector('.workstation-workspace')).toHaveAttribute('data-view','score');
  expect(c.getState().settings.mixes['base/0'].gain).toBe(.95);
  expect(c.getState().settings.mixes['base/0'].pan).toBe(.05);
});
it('reaches the drum kit mix from the Mixer view of a percussion track, saves one undoable edit per change, and has no other kit panel',async()=>{
  const c=await setup({...blankProject(),edits:[{type:'addPercussionTrack',name:'Drums',program:0}]});
  const before=c.getState().snapshot.project.edits.length;
  // Neither the Sound pane nor the Mixer shows a kit for the guitar track.
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'View'})).getByRole('radio',{name:'Mixer'}));
  const mixer=screen.getByRole('region',{name:'Mixer'});
  expect(within(mixer).queryByRole('region',{name:/Drum kit/})).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Drum kit mix'})).not.toBeInTheDocument();
  fireEvent.click(within(within(mixer).getByRole('region',{name:'Channel 2: Drums'})).getByRole('button',{name:'Track 2: Drums'}));
  const kit=await within(mixer).findByRole('region',{name:'Drum kit Drums'});
  expect(screen.queryByRole('region',{name:'Drum kit mix'})).not.toBeInTheDocument();
  const mixOf=()=>Object.values(c.getState().settings.mixes).find(mix=>mix.drumKit);
  fireEvent.keyDown(within(kit).getByRole('slider',{name:'Volume Cymbals'}),{key:'ArrowDown'});
  await waitFor(()=>expect(mixOf()?.drumKit).toEqual({cymbals:{gain:.95,pan:0,mute:false,solo:false}}));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+1);
  fireEvent.click(within(kit).getByLabelText('Mute Kick'));
  await waitFor(()=>expect(mixOf()?.drumKit?.kick?.mute).toBe(true));
  expect(c.getState().snapshot.project.edits).toHaveLength(before+2);
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  await waitFor(()=>expect(mixOf()?.drumKit?.kick).toBeUndefined());
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  await waitFor(()=>expect(mixOf()).toBeUndefined());
});
it('opens command palette in Sound view for non-score commands and refuses score-editing commands',async()=>{
  const c=await setup();
  const view=screen.getByRole('radiogroup',{name:'View'});
  fireEvent.click(within(view).getByRole('radio',{name:'Sound'}));
  await screen.findByRole('region',{name:'Sound rig'});
  const shell=document.querySelector('.app-shell')!;
  const event=new KeyboardEvent('keydown',{key:'P',code:'KeyP',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});
  shell.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const palette=await screen.findByRole('dialog',{name:'Commands'});
  const input=within(palette).getByRole('combobox',{name:'Command'});
  fireEvent.change(input,{target:{value:'append measure'}});
  const before=c.getState().score.masterBars.length;
  expect(within(palette).getAllByRole('option')[0]).toHaveTextContent('Score editing is unavailable while the score is hidden.');
  fireEvent.keyDown(input,{key:'Enter'});
  expect(c.getState().score.masterBars.length).toBe(before);
  fireEvent.change(input,{target:{value:'play'}});
  fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Commands'})).not.toBeInTheDocument());
  const aEvent=new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});
  shell.dispatchEvent(aEvent);
  expect(aEvent.defaultPrevented).toBe(true);
});
it('loads documents into native playback and opening does not reset saved mix',async()=>{
  const c=await setup();await waitFor(()=>expect(integration.loadDocument).toHaveBeenCalled());fireEvent.click(exposeFunctionalControl(screen.getByLabelText('Mute')));await waitFor(()=>expect(c.getState().settings.mixes['base/0'].mute).toBe(true));
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
  expect(functionalButton('Apply score info')).toBeDisabled();change('Zoom (%)','125');click('Cancel export');await waitFor(()=>expect(integration.exportCancel).toHaveBeenCalled());expect(testWorkspace.getState().busy).toBe(true);await act(async()=>{finish(false);});await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());
});
it('shows native export failure inside the open modal without a duplicate background alert',async()=>{
  integration.exportRun.mockRejectedValueOnce(new Error('Native export failed.'));await setup();click('Export score');click('Export');const dialog=screen.getByRole('dialog',{name:'Export score'});
  await waitFor(()=>expect(within(dialog).getByRole('alert')).toHaveTextContent('Native export failed.'));expect(screen.getAllByRole('alert')).toHaveLength(1);expect(within(dialog).getByRole('button',{name:'Export'})).toBeEnabled();
});
it('focuses export options and Escape restores the toolbar opener',async()=>{
  await setup();const opener=functionalButton('Export score');opener.focus();fireEvent.click(opener);const format=screen.getByLabelText('Export format');expect(format).toHaveFocus();fireEvent.keyDown(format,{key:'Escape'});await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Export score'})).not.toBeInTheDocument());const trigger=screen.getByText('File',{selector:'summary'});expect(trigger).toBeVisible();expect(trigger).toHaveFocus();
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
  expect(functionalButton('Track 1: Guitar')).toHaveAttribute('aria-pressed','true');
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
  await setup();const begin=vi.spyOn(testWorkspace,'beginEditorOperation');click(open);expect(screen.getByRole('dialog',{name:dialog})).toBeInTheDocument();expect(begin).toHaveBeenCalledTimes(1);expect(testWorkspace.getState().busy).toBe(true);expect(screen.getByRole('tab')).toBeDisabled();expect(functionalButton('New')).toBeDisabled();expect(functionalButton('Apply score info')).toBeDisabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
  click(close);await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(begin).toHaveBeenCalledTimes(1);expect(screen.getByRole('tab')).toBeEnabled();expect(functionalButton('Apply score info')).toBeEnabled();
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
  const a=await setup();click('New');await waitFor(()=>expect(activeController()).not.toBe(a));const origin=functionalButton('Close score');origin.focus();fireEvent.click(origin);await waitFor(()=>expect(activeController()).toBe(a));
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
  const c=await setup();change('Fret','7');click('Set note');await waitFor(()=>expect(currentBeat(c).notes[0]?.fret).toBe(7));const bridge=documentBridges.get(c.getState().documentId)!;vi.mocked(bridge.askUnsaved).mockResolvedValueOnce('cancel');const origin=functionalButton('Close score');origin.focus();fireEvent.click(origin);
  await waitFor(()=>expect(bridge.askUnsaved).toHaveBeenCalledTimes(1));await waitFor(()=>expect(testWorkspace.getState().busy).toBe(false));expect(activeController()).toBe(c);expect(origin.isConnected).toBe(true);const trigger=screen.getByText('File',{selector:'summary'});expect(trigger).toBeVisible();expect(trigger).toHaveFocus();
});


// Workstation regressions use the real mounted workspace and panel composition.
const commandDisclosure=(label:string)=>screen.getByText(label,{selector:'summary'}).closest('details')!;
const paneButton=(name:string)=>within(screen.getByRole('navigation',{name:'Workspace panes'})).getByRole('button',{name});
function openCommand(label:string){const disclosure=commandDisclosure(label);if(!disclosure.open)fireEvent.click(disclosure.querySelector('summary')!);return disclosure;}
function viewToggle(label:string){const menu=openCommand('View');fireEvent.click(within(menu).getByRole('checkbox',{name:label}));fireEvent.keyDown(menu,{key:'Escape'});}
function revealDetails(element:HTMLElement){for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor instanceof HTMLDetailsElement)ancestor.open=true;}
function expectSilentNavigation(){for(const action of [integration.commits,integration.play,integration.pause,integration.stop,integration.playFromCursor,integration.playSelection,integration.loopSelection,integration.seekToMeasure,integration.setLoop,integration.clearLoop])expect(action).not.toHaveBeenCalled();}
it('workstation File View Help are single disclosures with exclusive open state, local Escape and outside dismissal',async()=>{
  const c=await setup(),before=c.getState();for(const name of ['File','View','Help'])expect(screen.getAllByText(name,{selector:'summary'})).toHaveLength(1);
  const file=openCommand('File');for(const name of ['New','Open','Save','Save As','Close score','Close all scores','Export score','Export GP'])expect(within(file).getByRole('button',{name})).toBeVisible();
  const view=openCommand('View');await waitFor(()=>expect(file).not.toHaveAttribute('open'));expect(view).toHaveAttribute('open');for(const name of ['Track panel','Inspector','Bottom dock'])expect(within(view).getByRole('checkbox',{name})).toBeChecked();
  fireEvent.keyDown(view,{key:'Escape'});expect(view).not.toHaveAttribute('open');expect(view.querySelector('summary')).toHaveFocus();
  const help=openCommand('Help');fireEvent.pointerDown(screen.getByRole('region',{name:'Score workspace'}));await waitFor(()=>expect(help).not.toHaveAttribute('open'));expect(c.getState()).toBe(before);expectSilentNavigation();
  openCommand('File');within(file).getByRole('button',{name:'New'}).focus();fireEvent.pointerDown(screen.getByRole('region',{name:'Score workspace'}));expect(file).not.toHaveAttribute('open');expect(file.querySelector('summary')).toHaveFocus();
});
it('Space still plays from the focused scrubber, a number field still counts as typing, and Undo and Redo keep names and tooltips',async()=>{
  await setup();const scrub=await screen.findByRole('slider',{name:'Playback position'});scrub.focus();
  const before=integration.play.mock.calls.length;fireEvent.keyDown(scrub,{key:' '});expect(integration.play.mock.calls.length).toBe(before+1);
  const arrow=fireEvent.keyDown(scrub,{key:'ArrowRight'});expect(arrow).toBe(true);
  const field=screen.getByLabelText('Loop start');field.focus();fireEvent.keyDown(field,{key:' '});expect(integration.play.mock.calls.length).toBe(before+1);
  expect(screen.getByRole('button',{name:'Undo'})).toHaveAttribute('title',expect.stringContaining('Undo'));expect(screen.getByRole('button',{name:'Redo'})).toHaveAttribute('title',expect.stringContaining('Redo'));
});
it('top-bar panel toggles show and hide the track panel, inspector and dock, and mirror the View menu',async()=>{
  const c=await setup(),before=c.getState(),toggle=(name:string)=>screen.getByRole('button',{name:`Toggle ${name}`}),pane=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
  for(const [name,selector] of [['track panel','.workstation-left'],['inspector','.workstation-inspector'],['bottom dock','.workstation-dock']] as const){
    expect(toggle(name)).toHaveAttribute('aria-pressed','true');expect(pane(selector)).toBeVisible();
    fireEvent.click(toggle(name));expect(toggle(name)).toHaveAttribute('aria-pressed','false');expect(pane(selector)).not.toBeVisible();
    const menu=openCommand('View'),box=within(menu).getByRole('checkbox',{name:name==='track panel'?'Track panel':name==='inspector'?'Inspector':'Bottom dock'});expect(box).not.toBeChecked();fireEvent.keyDown(menu,{key:'Escape'});
    fireEvent.click(toggle(name));expect(toggle(name)).toHaveAttribute('aria-pressed','true');expect(pane(selector)).toBeVisible();
  }
  expect(c.getState()).toBe(before);expectSilentNavigation();
});
it('workstation hidden panes retain their mounted tuning rhythm and text drafts without score changes',async()=>{
  const c=await setup(),before=c.getState();fireEvent.click(paneButton('Track'));const tuning=screen.getByLabelText('Tuning (notes, high to low)');fireEvent.change(tuning,{target:{value:'E4 B3 G3 D3 A2 D2'}});
  const duration=screen.getByLabelText('Duration'),text=screen.getByLabelText('Beat text');revealDetails(text);fireEvent.change(duration,{target:{value:'8'}});fireEvent.change(text,{target:{value:'Unapplied passage note'}});
  viewToggle('Track panel');expect(tuning).not.toBeVisible();viewToggle('Inspector');expect(duration).not.toBeVisible();viewToggle('Track panel');viewToggle('Inspector');
  expect(screen.getByLabelText('Tuning (notes, high to low)')).toBe(tuning);expect(tuning).toHaveValue('E4 B3 G3 D3 A2 D2');expect(screen.getByLabelText('Duration')).toBe(duration);expect(duration).toHaveValue('8');expect(screen.getByLabelText('Beat text')).toBe(text);expect(text).toHaveValue('Unapplied passage note');expect(c.getState()).toBe(before);expectSilentNavigation();
});
it.each(['hidden-inspector','narrow-sound'] as const)('workstation paste-options shortcut reveals and focuses the existing Inspector from %s',async mode=>{
  const c=await setup(blankProject(),undefined,{width:mode==='narrow-sound'?960:1280});fireEvent.click(paneButton('Track'));const tuning=screen.getByLabelText('Tuning (notes, high to low)');fireEvent.change(tuning,{target:{value:'E4 B3 G3 D3 A2 D2'}});
  fireEvent.click(paneButton('Inspector'));const duration=screen.getByLabelText('Duration'),text=screen.getByLabelText('Beat text');revealDetails(text);fireEvent.change(duration,{target:{value:'8'}});fireEvent.change(text,{target:{value:'Draft survives reveal'}});click('Select bar');const score=screen.getByRole('region',{name:'Score workspace'});fireEvent.keyDown(score,{key:'c',ctrlKey:true});await waitFor(()=>expect(screen.getByLabelText('Paste repetitions')).toBeInTheDocument());
  const editTask=document.querySelector<HTMLDetailsElement>('.inspector-task[id$="-edit"]')!;editTask.open=false;const summary=screen.getByText('Musical clipboard',{selector:'summary'}),scroll=vi.fn();summary.parentElement!.scrollIntoView=scroll;const selection=engravingView.mock.lastCall?.[0].editorSelection,before=c.getState();
  if(mode==='hidden-inspector')viewToggle('Inspector');else fireEvent.click(paneButton('Sound'));expect(duration).not.toBeVisible();
  fireEvent.keyDown(score,{key:'v',ctrlKey:true,shiftKey:true});await waitFor(()=>expect(summary).toHaveFocus());expect(summary).toBeVisible();expect(editTask.open).toBe(true);expect(scroll).toHaveBeenCalledWith({block:'nearest'});expect(duration).toBeVisible();expect(duration).toHaveValue('8');expect(text).toHaveValue('Draft survives reveal');expect(tuning).toHaveValue('E4 B3 G3 D3 A2 D2');expect(c.getState()).toBe(before);expect(engravingView.mock.lastCall?.[0].editorSelection).toBe(selection);expectSilentNavigation();
});
it('workstation 960px task pane replaces Inspector and resize restores simultaneous wide panes',async()=>{
  await setup(blankProject(),undefined,{width:960});const shell=document.querySelector('.app-shell')!;expect(shell).toHaveAttribute('data-narrow','true');const location=screen.getByLabelText('Editing location');expect(location).toBeVisible();fireEvent.click(paneButton('Sound'));expect(location).not.toBeVisible();expect(screen.getByLabelText('Sound source')).toBeVisible();fireEvent.click(paneButton('Inspector'));expect(location).toBeVisible();expect(screen.getByLabelText('Sound source')).not.toBeVisible();
  Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:1280});fireEvent(window,new Event('resize'));await waitFor(()=>expect(shell).toHaveAttribute('data-narrow','false'));expect(location).toBeVisible();expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();
});
it('workstation dock Instrument follows per-document visibility while Overview and Mixer stay view-only',async()=>{
  const a=await setup(),first=a.getState().documentId,before=a.getState();fireEvent.click(screen.getByRole('button',{name:'Instrument'}));expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();expect(testWorkspace.getState().documents[0].view.instrumentVisible).toBe(true);viewToggle('Bottom dock');expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();viewToggle('Bottom dock');expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();
  const hide=screen.getByRole('button',{name:'Hide bottom dock'});hide.focus();fireEvent.click(hide);expect(screen.queryByRole('region',{name:'Bottom dock'})).not.toBeInTheDocument();const viewTrigger=screen.getByText('View',{selector:'summary'});expect(viewTrigger).toBeVisible();expect(viewTrigger).toHaveFocus();viewToggle('Bottom dock');
  fireEvent.click(screen.getByRole('button',{name:'Mixer'}));expect(screen.getByRole('region',{name:'Mixer'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Overview'}));expect(screen.getByRole('grid',{name:'Written measure overview'})).toBeVisible();expect(a.getState()).toBe(before);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Instrument'}));
  fireEvent.click(within(openCommand('File')).getByRole('button',{name:'New'}));await waitFor(()=>expect(activeController()).not.toBe(a));expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();await act(async()=>{await testWorkspace.activate(first);});expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();expect(a.getState()).toBe(before);expectSilentNavigation();
});
it.each([{width:1280,height:620},{width:960,height:720}])('short Backing dock at $width×$height reserves the reference plot budget without resizing other dock views',async({width,height})=>{
  const previousHeight=window.innerHeight;Object.defineProperty(window,'innerHeight',{configurable:true,writable:true,value:height});
  try{
    const c=await setup(blankProject(),undefined,{width,workspaceHeight:height-132}),before=c.getState(),workspace=document.querySelector<HTMLElement>('.workstation-workspace')!;
    expect(workspace).toHaveStyle({'--dock-height':'144px'});const dock=within(screen.getByRole('region',{name:'Bottom dock'}));fireEvent.click(dock.getByRole('button',{name:'Backing'}));
    const referencePlotHeight=Number.parseFloat(workspace.style.getPropertyValue('--dock-height'))-31-33-34;
    expect(referencePlotHeight).toBeGreaterThanOrEqual(56);expect(workspace).toHaveAttribute('data-dock-collapsed','false');expect(screen.getByRole('region',{name:'Backing waveform'})).toBeVisible();
    fireEvent.click(dock.getByRole('button',{name:'Instrument'}));expect(workspace).toHaveStyle({'--dock-height':'160px'});fireEvent.click(dock.getByRole('button',{name:'Overview'}));expect(workspace).toHaveStyle({'--dock-height':'144px'});expect(c.getState()).toBe(before);expectSilentNavigation();
  }finally{Object.defineProperty(window,'innerHeight',{configurable:true,writable:true,value:previousHeight});}
});
it.each([960,1280,1600])('Backing waveform reveals the existing dock at %ipx and preserves drafts and history',async width=>{
  const c=await setup(blankProject(),undefined,{width}),before=c.getState();
  fireEvent.click(paneButton('Track'));const tuning=screen.getByLabelText('Tuning (notes, high to low)');fireEvent.change(tuning,{target:{value:'E4 B3 G3 D3 A2 D2'}});
  fireEvent.click(paneButton('Backing'));viewToggle('Bottom dock');click('Show waveform');
  expect(screen.getByRole('region',{name:'Backing waveform'})).toBeVisible();
  const dock=screen.getByRole('region',{name:'Bottom dock'});expect(within(dock).getByRole('button',{name:'Backing'})).toHaveAttribute('aria-pressed','true');
  expect(document.querySelector('.workstation-workspace')).toHaveStyle({'--dock-height':`${window.innerHeight<800?176:width>=1440?192:176}px`});
  fireEvent.click(within(dock).getByRole('button',{name:'Overview'}));expect(screen.getByRole('grid',{name:'Written measure overview'})).toBeVisible();
  fireEvent.click(paneButton('Track'));expect(tuning).toHaveValue('E4 B3 G3 D3 A2 D2');expect(c.getState()).toBe(before);expectSilentNavigation();
});
const waveformProps=()=>waveform.props.at(-1)!;
const referenceAsset='f'.repeat(64);
const referenceProject=(backing:Partial<NonNullable<BackingWaveformProps['settings']>>={},edits:EditCommand[]=[]):Project=>({...blankProject(),assets:{[referenceAsset]:{filename:'reference.wav',mediaType:'audio/wav',byteLength:52}},edits:[...edits,{type:'setBacking',backing:{assetId:referenceAsset,offsetMs:120,anchors:[],mix:defaultMix(),...backing}}]});
const referenceMode=async()=>{fireEvent.click(paneButton('Backing'));await waitFor(()=>expect(screen.getByLabelText('Timing')).toBeEnabled());};
function deferReferenceRead(){
  let finish!:(durationMs:number)=>void;
  waveform.read.mockImplementationOnce((document,source,_buckets,owner)=>new Promise(resolve=>{finish=durationMs=>resolve({owner,document,source,durationMs,sampleRate:1000,frameCount:durationMs,channels:1,bucketCount:1,peaks:[{min:[0,0],max:[0,0]}]});}));
  return (durationMs=6000)=>finish(durationMs);
}
const repeatMeasure=(bar:number,repeatStart:boolean,repeatCount:number):EditCommand=>({type:'setMeasureSettings',bar,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart,repeatCount,endings:[],section:'',tempos:[]});
it('reference controls wait for verified source metadata without opening the waveform or an output device',async()=>{
  let finish!:(receipt:WaveformReceipt)=>void,args!:Parameters<typeof waveform.read>;
  waveform.read.mockImplementationOnce((...input)=>{args=input;return new Promise(resolve=>{finish=resolve;});});
  const c=await setup(referenceProject());expect(waveform.read).not.toHaveBeenCalled();fireEvent.click(paneButton('Backing'));
  expect(screen.getByLabelText('Timing')).toBeDisabled();await waitFor(()=>expect(waveform.read).toHaveBeenCalledOnce());expect(args[2]).toBe(1);
  await act(async()=>finish({owner:args[3],document:args[0],source:args[1],durationMs:6000,sampleRate:1000,frameCount:6000,channels:1,bucketCount:1,peaks:[{min:[0,0],max:[0,0]}]}));
  expect(screen.getByLabelText('Timing')).toBeEnabled();expect(screen.getByText('reference.wav · 6.0 s')).toBeVisible();
  change('Timing','reference');await waitFor(()=>expect(c.getState().settings.backing?.referenceSync).toEqual({entryAudioMs:120,exitAudioMs:6120}));
  expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().score.tempo).toBe(120);
  change('Timing','score');await waitFor(()=>expect(c.getState().settings.backing?.referenceSync).toBeUndefined());expect(integration.commits).toHaveBeenCalledTimes(2);expect(c.getState().score.tempo).toBe(120);click('Undo');await waitFor(()=>expect(c.getState().settings.backing?.referenceSync).toEqual({entryAudioMs:120,exitAudioMs:6120}));
});
it('reference numeric preview shares the waveform binding and commits one captured revision only on Enter',async()=>{
  const c=await setup(referenceProject());await referenceMode();change('Timing','reference');await waitFor(()=>expect(c.getState().settings.backing?.referenceSync).toEqual({entryAudioMs:120,exitAudioMs:16120}));integration.commits.mockClear();const before=c.getState(),committed=waveformProps().settings;
  const entry=screen.getByLabelText('Entry (ms)');fireEvent.focus(entry);fireEvent.change(entry,{target:{value:'1250.5'}});
  expect(waveformProps().reference?.edit.preview?.referenceSync?.entryAudioMs).toBe(1370.5);expect(waveformProps().settings).toBe(committed);expect(c.getState().snapshot).toBe(before.snapshot);expect(integration.commits).not.toHaveBeenCalled();expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','true');expect(entry).toBeEnabled();
  fireEvent.keyDown(entry,{key:'Enter'});await waitFor(()=>expect(c.getState().settings.backing?.referenceSync?.entryAudioMs).toBe(1370.5));fireEvent.blur(entry);
  expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().revision).toBe(before.revision+1);await waitFor(()=>expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false'));
});
it('reference waveform follows committed idle seek time and excludes count-in and ended time',async()=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}));await referenceMode();click('Show waveform');const player=integration.players[0],before=c.getState().snapshot,practice=player.getState().practice;
  act(()=>player.publish({time:2500,practice:{...practice,phase:'idle'}}));expect(waveformProps().scoreTimeMs).toBe(2500);
  const entry=screen.getByLabelText('Entry (ms)');fireEvent.change(entry,{target:{value:'1200'}});expect(waveformProps().reference?.edit.preview?.referenceSync?.entryAudioMs).toBe(1320);expect(waveformProps().scoreTimeMs).toBe(2500);expect(waveformProps().settings?.referenceSync?.entryAudioMs).toBe(1120);fireEvent.keyDown(entry,{key:'Escape'});
  act(()=>player.publish({practice:{...practice,phase:'countIn'}}));expect(waveformProps().scoreTimeMs).toBeNull();act(()=>player.publish({practice:{...practice,phase:'ended'}}));expect(waveformProps().scoreTimeMs).toBeNull();expect(c.getState().snapshot).toBe(before);expect(integration.commits).not.toHaveBeenCalled();
});
it('reference From score uses authored fractional tempos and emits one backing command for replace and add',async()=>{
  const tempos:EditCommand={type:'replaceTempoAutomations',points:[{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:.5,bpm:60,linear:false}]};
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:10120}},[tempos]));await referenceMode();click('Replace sync points');
  await waitFor(()=>expect(c.getState().settings.backing?.anchors).toEqual([{bar:0,occurrence:0,ratio:.5,audioMs:2120}]));expect(c.getState().settings.backing?.referenceSync).toEqual({entryAudioMs:1120,exitAudioMs:16120});expect(integration.commits).toHaveBeenCalledTimes(1);
  click('Add sync points');await waitFor(()=>expect(c.getState().busy).toBe(false));expect(integration.commits).toHaveBeenCalledTimes(1);
});
it('reference Write score tempos replaces authored events with one atomic score command',async()=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:7120},anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}]}));await referenceMode();const before=c.getState();click('Write score tempos');
  await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(before.snapshot.project.edits.length+1));expect(c.getState().snapshot.project.edits.at(-1)).toEqual({type:'replaceTempoAutomations',points:[{bar:0,ratio:0,bpm:120,linear:false},{bar:1,ratio:0,bpm:180,linear:false},{bar:2,ratio:0,bpm:180,linear:false},{bar:3,ratio:0,bpm:180,linear:false}]});expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().settings.backing).toEqual(before.settings.backing);
});
it.each(['revision','source','activation'] as const)('reference metadata discards a late result after %s changes',async kind=>{
  const finishOld=deferReferenceRead(),finishNew=deferReferenceRead(),c=await setup(referenceProject());fireEvent.click(paneButton('Backing'));await waitFor(()=>expect(waveform.read).toHaveBeenCalledOnce());
  if(kind==='activation'){
    await act(async()=>{await testWorkspace.newDocument();await testWorkspace.activate(c.getState().documentId);});fireEvent.click(paneButton('Backing'));
  }else await act(async()=>{await c.edit(kind==='source'?{type:'setBacking',backing:null}:{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3});});
  if(kind==='source'){
    await act(async()=>finishOld());expect(screen.getByLabelText('Timing')).toBeDisabled();expect(waveformProps().reference?.timing).toBeNull();
    await act(async()=>{await c.edit({type:'setBacking',backing:{assetId:referenceAsset,offsetMs:120,anchors:[],mix:defaultMix()}});});
  }
  await waitFor(()=>expect(waveform.read).toHaveBeenCalledTimes(2));await act(async()=>finishOld(6000));expect(screen.getByLabelText('Timing')).toBeDisabled();
  await act(async()=>finishNew(10000));expect(screen.getByLabelText('Timing')).toBeEnabled();expect(screen.getByText('reference.wav · 10.0 s')).toBeVisible();
});
it('reference metadata decode failure exposes Retry while the waveform owns the visible source',async()=>{
  waveform.read.mockRejectedValueOnce(new Error('Backing decoder failed.'));
  await setup(referenceProject());fireEvent.click(within(screen.getByRole('region',{name:'Bottom dock'})).getByRole('button',{name:'Backing'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Backing decoder failed.'));fireEvent.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(waveformProps().reference?.timing).toBeNull());fireEvent.click(paneButton('Backing'));await waitFor(()=>expect(screen.getByLabelText('Timing')).toBeEnabled());expect(waveform.read).toHaveBeenCalledTimes(2);
});
it.each(['pane','narrow','dock'] as const)('reference endpoint preview cancels when its %s surface becomes hidden',async surface=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}));await referenceMode();const before=c.getState().snapshot;
  if(surface==='dock'){
    click('Show waveform');act(()=>{expect(waveformProps().reference?.edit.begin('entry','waveform')).toBe(true);waveformProps().reference!.edit.update(1200);});fireEvent.click(screen.getByRole('button',{name:'Hide bottom dock'}));
  }else{
    fireEvent.change(screen.getByLabelText('Entry (ms)'),{target:{value:'1200'}});
    if(surface==='pane')fireEvent.click(paneButton('Track'));
    else {Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:960});fireEvent(window,new Event('resize'));fireEvent.click(paneButton('Inspector'));}
  }
  expect(waveformProps().reference?.edit.active).toBeNull();expect(waveformProps().reference?.edit.preview).toBeNull();expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false');expect(c.getState().snapshot).toBe(before);expect(integration.commits).not.toHaveBeenCalled();
});
it('reference numeric preview survives hiding the other waveform surface and rejects an intervening revision',async()=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}));await referenceMode();click('Show waveform');const entry=screen.getByLabelText('Entry (ms)');fireEvent.change(entry,{target:{value:'1200'}});fireEvent.click(screen.getByRole('button',{name:'Hide bottom dock'}));expect(waveformProps().reference?.edit.active).toEqual({endpoint:'entry',surface:'number'});
  await act(async()=>{await c.edit({type:'setBacking',backing:{...c.getState().settings.backing!,mix:{...defaultMix(),gain:.5}}});});expect(waveformProps().reference?.edit.active).toBeNull();fireEvent.keyDown(entry,{key:'Enter'});expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().settings.backing?.referenceSync?.entryAudioMs).toBe(1120);expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false');
});
it('reference mode rejects an old source action while the replacement metadata is pending',async()=>{
  const other='b'.repeat(64),project=referenceProject();project.assets[other]={filename:'replacement.wav',mediaType:'audio/wav',byteLength:52};const c=await setup(project);await referenceMode();const oldAction=(waveformProps().reference as ReferenceSyncControls).onModeChange,finish=deferReferenceRead();
  await act(async()=>{await c.edit({type:'setBacking',backing:{assetId:other,offsetMs:120,anchors:[],mix:defaultMix()}});});expect(screen.getByLabelText('Timing')).toBeDisabled();const before=c.getState().snapshot;
  await act(async()=>{await expect(oldAction('reference')).rejects.toThrow(/changed|load/);});expect(c.getState().snapshot).toBe(before);expect(integration.commits).toHaveBeenCalledTimes(1);await act(async()=>finish());
});
it.each(['resolve','reject'] as const)('reference pending Enter keeps its operation lease until native %s after hiding',async result=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}));await referenceMode();const bridge=documentBridges.get(c.getState().documentId)!,original=bridge.applyEdit;let finish!:()=>void;
  const apply=vi.spyOn(bridge,'applyEdit').mockImplementationOnce((...args)=>new Promise((resolve,reject)=>{finish=()=>result==='resolve'?void original(...args).then(resolve,reject):reject(new Error('Reference commit failed.'));}));
  const entry=screen.getByLabelText('Entry (ms)');fireEvent.change(entry,{target:{value:'1200'}});fireEvent.keyDown(entry,{key:'Enter'});await waitFor(()=>expect(apply).toHaveBeenCalledOnce());fireEvent.click(paneButton('Track'));expect(waveformProps().reference?.edit.active).toBeNull();expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','true');
  await act(async()=>finish());await waitFor(()=>expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false'));expect(waveformProps().reference?.edit.error).toBeNull();expect(integration.commits).toHaveBeenCalledTimes(result==='resolve'?1:0);
});
it('reference conversion rejects an intervening queued edit at the captured revision',async()=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}));await referenceMode();const actions=waveformProps().reference as ReferenceSyncControls,begin=vi.spyOn(testWorkspace,'beginEditorOperation');
  const commit=c.editAtRevision.bind(c);vi.spyOn(c,'editAtRevision').mockImplementationOnce((command,expected)=>{void c.edit({type:'setBacking',backing:{...c.getState().settings.backing!,mix:{...defaultMix(),gain:.5}}});return commit(command,expected);});
  await act(async()=>{await expect(actions.onModeChange('score')).rejects.toThrow(/revision changed/);});expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().settings.backing?.referenceSync).toEqual({entryAudioMs:1120,exitAudioMs:9120});expect(begin).toHaveBeenCalledOnce();expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false');
});
it('reference Write score tempos rejects incompatible repeated passes without changing history',async()=>{
  const c=await setup(referenceProject({referenceSync:{entryAudioMs:1120,exitAudioMs:7120},anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}]},[repeatMeasure(0,true,0),repeatMeasure(1,false,2)]));await referenceMode();const before=c.getState().snapshot;click('Write score tempos');
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/incompatible tempos/));expect(c.getState().snapshot).toBe(before);expect(integration.commits).not.toHaveBeenCalled();expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy','false');
});
it('reference GP preflight blocks an ambiguous backing selection and omission publishes selected notation',async()=>{
  const c=await setup(referenceProject({},[repeatMeasure(0,true,0),repeatMeasure(1,false,2)])),before=c.getState().snapshot;click('Export score');const dialog=within(screen.getByRole('dialog',{name:'Export score'}));fireEvent.click(dialog.getByLabelText('Measure range'));fireEvent.change(dialog.getByLabelText('Last measure'),{target:{value:'1'}});
  expect(dialog.getByRole('button',{name:'Export'})).toHaveAttribute('aria-disabled','true');fireEvent.click(dialog.getByRole('button',{name:'Export'}));expect(integration.exportRun).not.toHaveBeenCalled();expect(dialog.getByRole('alert')).toHaveTextContent(/more than once|unique|ambiguous/i);expect(dialog.getByLabelText('Include backing audio')).toHaveAttribute('aria-describedby');expect(waveform.read).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByLabelText('Include backing audio'));expect(dialog.getByRole('button',{name:'Export'})).not.toHaveAttribute('aria-disabled');fireEvent.click(dialog.getByRole('button',{name:'Export'}));await waitFor(()=>expect(integration.exportRun).toHaveBeenCalledWith({format:'gp',selection:{tracks:[0],range:{first:0,last:0}},backing:false},expect.objectContaining({revision:0})));expect(c.getState().snapshot).toBe(before);
});
it('joins exact asset, revision and live backing checks while its operation lease is busy',async()=>{
  const id='a'.repeat(64),backing={assetId:id,offsetMs:120,anchors:[],mix:defaultMix()};
  const c=await setup({...blankProject(),assets:{[id]:{filename:'authored.wav',mediaType:'audio/wav',byteLength:52}},edits:[{type:'setBacking',backing}]});
  const p=waveformProps(),before=c.getState();expect(p.source).toEqual({kind:'asset',assetId:id});expect(p.document).toEqual({documentId:before.documentId,revision:before.revision});expect(p.filename).toBe('authored.wav');expect(p.settings).toEqual(backing);
  let release!:()=>void;act(()=>{release=p.beginOperation();});expect(waveformProps().busy).toBe(true);expect(waveformProps().isCurrent(p.document,backing)).toBe(true);
  await act(async()=>{await p.onEdit({type:'setBacking',backing:{...backing,offsetMs:240}});});expect(waveformProps().isCurrent(p.document,backing)).toBe(false);expect(integration.commits).toHaveBeenCalledTimes(1);
  act(()=>release());expect(waveformProps().busy).toBe(false);expect(waveformProps().document.revision).toBe(before.revision+1);
  click('Undo');await waitFor(()=>expect(c.getState().settings.backing).toEqual(backing));expect(waveformProps().source).toEqual({kind:'asset',assetId:id});
});
it('extracts original embedded source once and never resurrects it after explicit score-only',async()=>{
  const bytes=new Uint8Array([82,73,70,70]),score=buildScore(blankProject());score.backingTrack={rawAudioFile:bytes};
  const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockImplementation(()=>score);
  try{
    const c=await setup({...blankProject(),base:{kind:'file',filename:'Original.gp',bytesBase64:'AA==',sha256:'A'.repeat(64)}}),before=c.getState();
    expect(waveform.embedded).not.toHaveBeenCalled();fireEvent.click(paneButton('Backing'));click('Show waveform');
    await waitFor(()=>expect(waveformProps().source?.kind).toBe('embedded'));expect(waveform.embedded).toHaveBeenCalledOnce();expect(waveform.embedded).toHaveBeenCalledWith('A'.repeat(64),before.embeddedBacking);
    expect(waveformProps().settings).toBeNull();expect(waveformProps().effectiveBacking).toEqual(effectiveAudioSettings(before.snapshot.project,before).backing);
    fireEvent.click(within(screen.getByRole('region',{name:'Bottom dock'})).getByRole('button',{name:'Overview'}));click('Show waveform');expect(waveform.embedded).toHaveBeenCalledOnce();expect(c.getState()).toBe(before);expect(integration.commits).not.toHaveBeenCalled();
    await act(async()=>{await c.edit({type:'setBacking',backing:null});});expect(waveformProps().source).toBeNull();expect(waveformProps().settings).toBeNull();expect(waveformProps().effectiveBacking).toBeNull();expect(waveform.embedded).toHaveBeenCalledOnce();
  }finally{load.mockRestore();}
});
it('discards an embedded source prepared after its backing was removed',async()=>{
  const score=buildScore(blankProject());score.backingTrack={rawAudioFile:new Uint8Array([82,73,70,70])};
  const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockImplementation(()=>score);
  let finish!:(source:WaveformSourceInput)=>void;waveform.embedded.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  try{
    const c=await setup({...blankProject(),base:{kind:'file',filename:'Original.gp',bytesBase64:'AA==',sha256:'a'.repeat(64)}});
    fireEvent.click(paneButton('Backing'));click('Show waveform');await waitFor(()=>expect(waveform.embedded).toHaveBeenCalledOnce());
    await act(async()=>{await c.edit({type:'setBacking',backing:null});});const before=c.getState();
    await act(async()=>finish({kind:'embedded',sourceKey:'a'.repeat(64),sha256:'e'.repeat(64),bytesBase64:'UklGRg=='}));
    expect(waveformProps().source).toBeNull();expect(waveformProps().effectiveBacking).toBeNull();expect(c.getState()).toBe(before);expect(integration.commits).toHaveBeenCalledTimes(1);
  }finally{load.mockRestore();}
});
it('workstation Overview click Space and Escape preserve running playback history and musical range',async()=>{
  integration.running=true;const c=await setup({...blankProject(),edits:[{type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,28]}]});click('Select bar');const before=c.getState(),range=engravingView.mock.lastCall?.[0].editorSelection,player=integration.players[0],native=player.getState(),prepared=player.built,generation=player.generation;expect(native.playing).toBe(true);const grid=screen.getByRole('grid',{name:'Written measure overview'}),cell=within(grid).getByRole('gridcell',{name:'Bass, measure 2, rest'});fireEvent.click(cell);expect(engravingView.mock.lastCall?.[0].editTarget).toEqual({track:1,staff:0,bar:1,voice:0,beat:0});expect(cell).toHaveFocus();
  expect(fireEvent.keyDown(cell,{key:'ArrowRight'})).toBe(false);const focused=document.activeElement!;expect(engravingView.mock.lastCall?.[0].editTarget).toEqual({track:1,staff:0,bar:1,voice:0,beat:0});const selectView=vi.spyOn(testWorkspace,'setView');selectView.mockClear();expect(fireEvent.keyDown(focused,{key:' '})).toBe(false);expect(engravingView.mock.lastCall?.[0].editTarget).toEqual({track:1,staff:0,bar:2,voice:0,beat:0});expect(selectView).toHaveBeenCalledTimes(1);expect(fireEvent.keyDown(focused,{key:'Escape'})).toBe(false);expect(screen.getByRole('region',{name:'Score workspace'})).toHaveFocus();expect(engravingView.mock.lastCall?.[0].editorSelection).toBe(range);expect(c.getState()).toBe(before);expect(player.getState()).toBe(native);expect(player.built).toBe(prepared);expect(player.generation).toBe(generation);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();expectSilentNavigation();
});
it('workstation marks actual editor operation busy without disabling permitted Stop',async()=>{
  await setup();const shell=document.querySelector('.app-shell')!;expect(shell).toHaveAttribute('aria-busy','false');let release!:()=>void;act(()=>{release=testWorkspace.beginEditorOperation(testWorkspace.getState().active.documentId);});expect(shell).toHaveAttribute('aria-busy','true');expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();act(()=>release());expect(shell).toHaveAttribute('aria-busy','false');
});

it.each(['percussion','empty-voice'] as const)('workstation Overview selects and repairs %s without a musical edit',async kind=>{
  const edits:EditCommand[]=kind==='percussion'?[{type:'addPercussionTrack',name:'Drums',program:0}]:[0,1,2,3].map(()=>({type:'deleteBeat',target:{track:0,staff:0,bar:0,voice:0,beat:0}}));const c=await setup({...blankProject(),edits}),before=c.getState(),grid=screen.getByRole('grid',{name:'Written measure overview'});const cell=within(grid).getByRole('gridcell',{name:kind==='percussion'?'Drums, measure 1, rest':'Guitar, measure 1, empty'});fireEvent.click(cell);expect(engravingView.mock.lastCall?.[0].editTarget).toEqual({track:kind==='percussion'?1:0,staff:0,bar:0,voice:0,beat:0});if(kind==='percussion')expect(engravingView.mock.lastCall?.[0].editString).toBeUndefined();expect(cell).toHaveFocus();expect(c.getState()).toBe(before);expectSilentNavigation();
});
it('workstation paste-options shortcut keeps input and dialog keyboard exclusions',async()=>{
  const c=await setup(),before=c.getState(),summary=screen.getByText('Musical clipboard',{selector:'summary'}),scroll=vi.fn();summary.parentElement!.scrollIntoView=scroll;viewToggle('Inspector');const tuning=screen.getByLabelText('Tuning (notes, high to low)');tuning.focus();fireEvent.keyDown(tuning,{key:'v',ctrlKey:true,shiftKey:true});expect(tuning).toHaveFocus();expect(screen.getByLabelText('Editing location')).not.toBeVisible();expect(scroll).not.toHaveBeenCalled();
  click('Browse scales');const dialog=screen.getByRole('dialog',{name:'Scale browser'}),focus=document.activeElement;fireEvent.keyDown(dialog,{key:'v',ctrlKey:true,shiftKey:true});expect(document.activeElement).toBe(focus);expect(summary.closest('details')).not.toHaveAttribute('open');expect(scroll).not.toHaveBeenCalled();expect(c.getState()).toBe(before);expectSilentNavigation();
});

it('workstation single File integrates real session controls and footer notices without replacing the editor player',async()=>{
  const onPreferencesChange=vi.fn(),onRetry=vi.fn(),session:WorkspaceSession={preferences:{version:1,restorePreviousSession:true},status:{state:'failed',capturedAtUnixMs:1792050000000,generation:7,error:'Backup destination is unavailable. Keep this score open and retry.'},error:null,issues:[{documentId:null,message:'Recovered score destination changed; Save As keeps the current score safe.'}],pending:false,onPreferencesChange,onRetry};
  const c=await setup(blankProject(),undefined,{session}),before=c.getState(),editor=screen.getByRole('region',{name:'Score workspace'}),player=integration.players[0];const file=openCommand('File');expect(screen.getAllByText('File',{selector:'summary'})).toHaveLength(1);expect(within(file).queryByText('File',{selector:'section summary'})).not.toBeInTheDocument();const preference=within(file).getByRole('checkbox',{name:'Restore previous session'});expect(preference).toBeChecked();fireEvent.click(preference);expect(onPreferencesChange).toHaveBeenCalledWith(false);expect(preference).toBeChecked();fireEvent.keyDown(file,{key:'Escape'});
  expect(screen.getByText(/Backup destination is unavailable/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(onRetry).toHaveBeenCalledOnce();fireEvent.click(screen.getByText('Session details (1)',{selector:'summary'}));expect(screen.getByText('Recovered score destination changed; Save As keeps the current score safe.')).toBeVisible();
  appRender.rerender(<WorkspaceApp workspace={testWorkspace} session={{...session,status:{state:'ready',capturedAtUnixMs:1792050060000,generation:8,error:null}}}/>);expect(screen.getByRole('region',{name:'Score workspace'})).toBe(editor);expect(screen.getByText(/Recovery backup complete/)).toBeVisible();expect(integration.players[0]).toBe(player);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();expect(c.getState()).toBe(before);expectSilentNavigation();
});


// Independent-review regressions: pane focus ownership and the actual visible instrument dock.
it.each([
  {task:'Track',selector:'.track-settings'},
  {task:'Sound',selector:'.sound-panel'},
  {task:'Backing',selector:'.backing-panel'},
  {task:'Inspector',selector:'.inspector'},
])('review pane keyboard activation enters the visible $task controls',async({task,selector})=>{
  const c=await setup(blankProject(),undefined,{width:960}),before=c.getState(),user=userEvent.setup(),trigger=paneButton(task);trigger.focus();await user.keyboard('{Enter}');const pane=document.querySelector(selector)!;expect(pane).toBeVisible();expect(pane).toContainElement(document.activeElement as HTMLElement);expect(document.activeElement).not.toBe(trigger);expect(document.activeElement).toBeVisible();expect((document.activeElement as HTMLElement).matches('button,input,select,textarea,summary,[tabindex],h1,h2,h3')).toBe(true);expect(c.getState()).toBe(before);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();expectSilentNavigation();
});
it.each(['Track','Inspector'] as const)('review responsive pane focus moves to the visible %s rail trigger when its field is hidden',async hidden=>{
  const c=await setup(),before=c.getState();if(hidden==='Inspector')fireEvent.click(paneButton('Sound'));const field=screen.getByLabelText(hidden==='Track'?'Tuning (notes, high to low)':'Duration');field.focus();expect(field).toHaveFocus();Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:960});fireEvent(window,new Event('resize'));await waitFor(()=>expect(field).not.toBeVisible());expect(paneButton(hidden)).toBeVisible();expect(paneButton(hidden)).toHaveFocus();expect(c.getState()).toBe(before);expectSilentNavigation();
});
it('review responsive pane focus leaves an unrelated score focus in place',async()=>{
  const c=await setup(),before=c.getState(),score=screen.getByRole('region',{name:'Score workspace'});score.focus();Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:960});fireEvent(window,new Event('resize'));expect(screen.getByLabelText('Tuning (notes, high to low)')).not.toBeVisible();expect(score).toHaveFocus();expect(c.getState()).toBe(before);expectSilentNavigation();
});
it('review responsive pane focus preserves the actual dialog owner',async()=>{
  const c=await setup(),before=c.getState();fireEvent.click(paneButton('Sound'));click('Browse scales');const dialog=screen.getByRole('dialog',{name:'Scale browser'}),owner=document.activeElement;expect(dialog).toContainElement(owner as HTMLElement);Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:960});fireEvent(window,new Event('resize'));expect(screen.getByLabelText('Duration')).not.toBeVisible();expect(document.activeElement).toBe(owner);expect(owner).toBeVisible();expect(c.getState()).toBe(before);expectSilentNavigation();
});
it.each(['View','dock button'] as const)('review instrument toggle shows the actual hidden dock in one click after hiding with %s',async source=>{
  const c=await setup(),before=c.getState();fireEvent.click(screen.getByRole('button',{name:'Instrument'}));expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();expect(screen.getByRole('button',{name:'Hide instrument'})).toHaveAttribute('aria-pressed','true');if(source==='View')viewToggle('Bottom dock');else fireEvent.click(screen.getByRole('button',{name:'Hide bottom dock'}));expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();expect(testWorkspace.getState().documents[0].view.instrumentVisible).toBe(true);const show=screen.getByRole('button',{name:'Show instrument'});expect(show).toHaveAttribute('aria-pressed','false');fireEvent.click(show);expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();expect(screen.getByRole('button',{name:'Hide instrument'})).toHaveAttribute('aria-pressed','true');expect(testWorkspace.getState().documents[0].view.instrumentVisible).toBe(true);expect(c.getState()).toBe(before);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();expectSilentNavigation();
});
it('review instrument toggle expands an automatically collapsed retained instrument in one click',async()=>{
  const c=await setup(blankProject(),undefined,{workspaceHeight:300,instrumentVisible:true}),before=c.getState();expect(document.querySelector('.workstation-workspace')).toHaveAttribute('data-dock-collapsed','true');expect(screen.queryByRole('region',{name:'Instrument view'})).not.toBeInTheDocument();expect(testWorkspace.getState().documents[0].view.instrumentVisible).toBe(true);const show=screen.getByRole('button',{name:'Show instrument'});expect(show).toHaveAttribute('aria-pressed','false');fireEvent.click(show);expect(document.querySelector('.workstation-workspace')).toHaveAttribute('data-dock-collapsed','false');expect(screen.getByRole('region',{name:'Instrument view'})).toBeVisible();expect(screen.getByRole('button',{name:'Hide instrument'})).toHaveAttribute('aria-pressed','true');expect(c.getState()).toBe(before);expect(integration.playerOptions).toHaveBeenCalledOnce();expect(integration.destroy).not.toHaveBeenCalled();expectSilentNavigation();
});

const auditionKey='tabplayer.audition.whileEditing';
it('plays an entered note through the addressed track at its sounding key, including capo and transposition',async()=>{
  window.localStorage.removeItem(auditionKey);
  const clef=buildScore(blankProject()).tracks[0].staves[0].bars[0].clef;
  const c=await setup({...blankProject(),edits:[{type:'setStaffSettings',track:0,staff:0,settings:{tuning:[64,59,55,50,45,40],capo:2,transposition:3,displayTransposition:0,clef,showTab:true,showNotation:true}}]});
  change('String','6');change('Fret','5');click('Set note');
  await waitFor(()=>expect(integration.audition).toHaveBeenCalledTimes(1));
  expect(integration.audition).toHaveBeenLastCalledWith({trackId:'base/0'},[{key:64+5+2-3,startMs:0,velocity:96}],800,expect.objectContaining({project:c.getState().snapshot.project,built:c.getState()}));
});
it('stays silent for rests, deletions, undo, redo and while playing',async()=>{
  window.localStorage.removeItem(auditionKey);
  const c=await setup();change('String','6');change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));expect(integration.audition).toHaveBeenCalledTimes(1);
  click('Make rest');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  click('Undo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  click('Redo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  change('Fret','7');click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));expect(integration.audition).toHaveBeenCalledTimes(2);
  click('Remove note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));click('Insert beat');click('Delete beat');
  await new Promise(resolve=>setTimeout(resolve,20));expect(integration.audition).toHaveBeenCalledTimes(2);
});
it('does not audition an entered note while playback is running',async()=>{
  window.localStorage.removeItem(auditionKey);integration.running=true;
  const c=await setup();change('String','6');change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  await new Promise(resolve=>setTimeout(resolve,20));expect(integration.audition).not.toHaveBeenCalled();
});
it('keeps Play notes while editing in the View menu, on by default and remembered',async()=>{
  window.localStorage.removeItem(auditionKey);
  const c=await setup(),toggle=()=>within(screen.getByRole('region',{name:'Workspace view'})).getByLabelText('Play notes while editing') as HTMLInputElement;
  expect(toggle()).toBeChecked();fireEvent.click(toggle());expect(toggle()).not.toBeChecked();expect(window.localStorage.getItem(auditionKey)).toBe('off');
  change('String','6');change('Fret','5');click('Set note');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  await new Promise(resolve=>setTimeout(resolve,20));expect(integration.audition).not.toHaveBeenCalled();
  cleanup();await setup();expect(toggle()).not.toBeChecked();fireEvent.click(toggle());expect(window.localStorage.getItem(auditionKey)).toBe('on');
  window.localStorage.removeItem(auditionKey);
});

const inputKey='tabplayer.input.preferences';
const keypad=(code:string,key=code==='NumpadDecimal'?'.':code.replace('Numpad',''))=>fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key,code});
const keypadOn=JSON.stringify({autoDuration:true,numpadDurations:true,pasteDiagrams:true});
it('keeps the keypad typing frets until the Keypad sets duration preference is on',async()=>{
  window.localStorage.removeItem(inputKey);
  const c=await setup();keypad('Numpad5');
  expect(screen.getByLabelText('Fret')).toHaveValue(5);expect(c.getState().snapshot.project.edits).toEqual([]);
  cleanup();window.localStorage.setItem(inputKey,JSON.stringify({autoDuration:false,numpadDurations:true,pasteDiagrams:true}));
  const d=await setup();keypad('Numpad5');
  await waitFor(()=>expect(currentBeat(d).duration).toBe(16));expect(d.getState().snapshot.project.edits).toEqual([{type:'setDuration',target:{track:0,staff:0,bar:0,voice:0,beat:0},duration:16,dots:0}]);
  expect(screen.getByLabelText('Fret')).toHaveValue(0);
  keypad('NumpadDecimal');await waitFor(()=>expect(currentBeat(d).dots).toBe(1));
  click('Undo');await waitFor(()=>expect(currentBeat(d).dots).toBe(0));
  window.localStorage.removeItem(inputKey);
});
it('does not edit a finalized document from the keypad',async()=>{
  window.localStorage.setItem(inputKey,JSON.stringify({autoDuration:false,numpadDurations:true,pasteDiagrams:true}));
  const c=await setup();await act(async()=>{await c.setLock({kind:'finalized'});});
  const before=c.getState().snapshot.project.edits.length;keypad('Numpad5');await new Promise(resolve=>setTimeout(resolve,20));
  expect(c.getState().snapshot.project.edits).toHaveLength(before);window.localStorage.removeItem(inputKey);
});
it('auto-duration gives a written rest the last keypad duration, and the preference is remembered',async()=>{
  window.localStorage.removeItem(inputKey);
  const c=await setup();
  fireEvent.click(within(openCommand('View')).getByLabelText(/^Auto-duration/));fireEvent.click(within(openCommand('View')).getByLabelText(/^Keypad sets duration/));
  expect(JSON.parse(window.localStorage.getItem(inputKey)!)).toMatchObject({autoDuration:true,numpadDurations:true});
  keypad('Numpad4');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'ArrowRight'});
  fireEvent.keyDown(screen.getByRole('region',{name:'Score workspace'}),{key:'Enter'});
  await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(1));expect(currentBeat(c,1).duration).toBe(8);
  window.localStorage.removeItem(inputKey);
});

it('leaves NumLock-off keypad keys to navigation and ignores a keypad duration that changes nothing',async()=>{
  window.localStorage.setItem(inputKey,keypadOn);
  const c=await setup();keypad('Numpad2','ArrowDown');
  expect(screen.getByLabelText('String')).toHaveValue('5');expect(c.getState().snapshot.project.edits).toEqual([]);
  keypad('Numpad3');await new Promise(resolve=>setTimeout(resolve,20));
  expect(c.getState().snapshot.project.edits).toEqual([]);expect(c.getState().snapshot.canUndo).toBe(false);
  window.localStorage.removeItem(inputKey);
});
it('does not remember a refused keypad duration as the entry duration',async()=>{
  window.localStorage.setItem(inputKey,keypadOn);
  const c=await setup(),workspace=screen.getByRole('region',{name:'Score workspace'});
  keypad('Numpad1');await new Promise(resolve=>setTimeout(resolve,50));
  expect(c.getState().snapshot.project.edits).toEqual([]);
  fireEvent.keyDown(workspace,{key:'ArrowRight'});fireEvent.keyDown(workspace,{key:'Enter'});
  await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(1));
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setNote']);expect(currentBeat(c,1).duration).toBe(4);
  window.localStorage.removeItem(inputKey);
});
it('does not remember a refused note as the entry duration, and never leaves a rhythm change without its note',async()=>{
  window.localStorage.setItem(inputKey,keypadOn);
  const c=await setup(),workspace=screen.getByRole('region',{name:'Score workspace'});
  keypad('Numpad4');await waitFor(()=>expect(currentBeat(c).duration).toBe(8));
  fireEvent.keyDown(workspace,{key:'ArrowRight'});
  fireEvent.keyDown(workspace,{key:'9'});fireEvent.keyDown(workspace,{key:'9'});expect(screen.getByLabelText('Fret')).toHaveValue(99);
  fireEvent.keyDown(workspace,{key:'Enter'});await new Promise(resolve=>setTimeout(resolve,50));
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setDuration']);expect(currentBeat(c,1).duration).toBe(4);
  change('Fret','5');fireEvent.keyDown(workspace,{key:'Enter'});
  await waitFor(()=>expect(currentBeat(c,1).notes).toHaveLength(1));
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setDuration','setDuration','setNote']);expect(currentBeat(c,1).duration).toBe(8);
  window.localStorage.removeItem(inputKey);
});

const origin={track:0,staff:0,bar:0,voice:0,beat:0};
const instrumentEditKey='tabplayer.instrument.editNotes';
const seededProject=():Project=>({...blankProject(),edits:[{type:'setNote',target:origin,string:6,fret:5}]});
async function editingInstrument(){
  window.localStorage.removeItem(auditionKey);window.localStorage.removeItem(instrumentEditKey);
  const c=await setup(seededProject(),undefined,{instrumentVisible:true});
  expect(screen.getByRole('img',{name:'Guitar fretboard'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox',{name:'Click to edit notes'}));
  expect(screen.getByRole('group',{name:'Guitar fretboard'})).toBeInTheDocument();
  return c;
}
it('turns an instrument click into one native edit that undo and redo restore',async()=>{
  const c=await editingInstrument();
  expect(screen.getByLabelText('Show')).toBeDisabled();expect(window.localStorage.getItem(instrumentEditKey)).toBe('on');
  fireEvent.click(screen.getByRole('button',{name:/^String 5, fret 2 /}));
  await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(2));
  expect(integration.commits).toHaveBeenCalledTimes(1);expect(c.getState().snapshot.project.edits.at(-1)).toEqual({type:'setNote',target:origin,string:5,fret:2});
  // The clicked string and fret become the entry position.
  await waitFor(()=>expect(screen.getByLabelText('Fret')).toHaveValue(2));
  fireEvent.click(screen.getByRole('button',{name:/^Remove string 5, fret 2 /}));
  await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  expect(integration.commits).toHaveBeenCalledTimes(2);expect(c.getState().snapshot.project.edits.at(-1)).toEqual({type:'removeNote',target:origin,string:5});
  await waitFor(()=>expect(screen.getByLabelText('Fret')).toHaveValue(2));
  click('Undo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(2));
  click('Undo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  click('Redo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(2));
  expect(integration.commits).toHaveBeenCalledTimes(2);
});
it('shows a refused instrument edit as an alert without adding history',async()=>{
  const c=await editingInstrument(),before=c.getState().snapshot;
  vi.spyOn(documentBridges.get(c.getState().documentId)!,'applyEdit').mockRejectedValueOnce(new Error('The edit was refused.'));
  fireEvent.click(screen.getByRole('button',{name:/^String 4, fret 1 /}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('refused'));
  expect(c.getState().snapshot.project.edits).toEqual(before.project.edits);expect(currentBeat(c).notes).toHaveLength(1);expect(integration.commits).not.toHaveBeenCalled();
});
it('auditions a note written from the instrument view and stays silent for a removal',async()=>{
  const c=await editingInstrument();
  fireEvent.click(screen.getByRole('button',{name:/^String 5, fret 2 /}));
  await waitFor(()=>expect(integration.audition).toHaveBeenCalledTimes(1));
  expect(integration.audition).toHaveBeenLastCalledWith({trackId:'base/0'},[{key:59+2,startMs:0,velocity:96}],800,expect.anything());
  fireEvent.click(screen.getByRole('button',{name:/^Remove string 5, fret 2 /}));
  await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  await new Promise(resolve=>setTimeout(resolve,20));expect(integration.audition).toHaveBeenCalledTimes(1);
});

const menuButton=(name:string)=>screen.queryByRole('button',{name,hidden:true});
it('offers Finalize for an open document and Unfinalize once it is finalized, without a history entry',async()=>{
  const c=await setup();
  expect(menuButton('Finalize document')).toBeInTheDocument();expect(menuButton('Unfinalize document')).not.toBeInTheDocument();
  expect(screen.queryByText('Finalized: editing is locked.')).not.toBeInTheDocument();
  click('Finalize document');
  await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  expect(menuButton('Unfinalize document')).toBeInTheDocument();expect(menuButton('Finalize document')).not.toBeInTheDocument();
  expect(screen.getByText('Finalized: editing is locked.')).toBeInTheDocument();
  expect(c.getState().snapshot.project.edits).toHaveLength(0);expect(c.getState().snapshot.dirty).toBe(true);expect(integration.commits).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Unfinalize'}));
  await waitFor(()=>expect(c.getState().snapshot.project.lock).toBeUndefined());
  expect(screen.queryByText('Finalized: editing is locked.')).not.toBeInTheDocument();expect(menuButton('Finalize document')).toBeInTheDocument();
});
it('disables editing surfaces of a finalized document while transport, mixer, save and export stay usable',async()=>{
  const c=await setup();
  click('Append measure');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(1));
  expect(screen.getByRole('button',{name:'Undo'})).toBeEnabled();
  click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  const disabled=(name:string|RegExp)=>expect(functionalButton(name)).toBeDisabled();
  expect(screen.getByRole('button',{name:'Undo'})).toBeDisabled();expect(screen.getByRole('button',{name:'Redo'})).toBeDisabled();
  disabled('Append measure');disabled('Set note');disabled('Import backing');disabled('Paste music');disabled('Cut music');
  // Keyboard shortcuts do not reach the native edit path.
  const before=c.getState().snapshot.project.edits;
  fireEvent.keyDown(screen.getByLabelText('Score workspace'),{key:'z',ctrlKey:true});
  fireEvent.keyDown(screen.getByLabelText('Score workspace'),{key:'Enter'});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(c.getState().snapshot.project.edits).toEqual(before);expect(integration.commits).toHaveBeenCalledTimes(1);
  // Transport, save, export and the mixer are untouched.
  expect(document.querySelector('[aria-keyshortcuts="Space"]')).toBeEnabled();
  expect(functionalButton('Save')).toBeEnabled();expect(functionalButton('Export score')).toBeEnabled();
  expect(functionalButton('Copy music')).toBeDefined();
  const mute=exposeFunctionalControl(screen.getByLabelText('Mute')) as HTMLInputElement;expect(mute).toBeEnabled();
  fireEvent.click(mute);
  await waitFor(()=>expect(c.getState().snapshot.project.edits.at(-1)).toEqual(expect.objectContaining({type:'setTrackMix'})));
  expect(integration.commits).toHaveBeenCalledTimes(2);
});
it('disables the instrument view entry mode of a finalized document',async()=>{
  const c=await editingInstrument();
  expect(screen.getByLabelText('Click to edit notes')).toBeEnabled();
  click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  expect(screen.getByLabelText('Click to edit notes')).toBeDisabled();
  expect(screen.queryByRole('button',{name:/^String 4, fret 1 /})).not.toBeInTheDocument();
});
it('exports a finalized document with its current layout and sends no layout edit',async()=>{
  const c=await setup();click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  click('Export score');change('Export format','pdf');
  const dialog=within(screen.getByRole('dialog',{name:'Export score'}));
  expect(dialog.getByLabelText('Width (mm)').closest('fieldset')).toHaveAttribute('aria-disabled','true');
  fireEvent.change(dialog.getByLabelText('Width (mm)'),{target:{value:'300'}});expect(dialog.getByLabelText('Width (mm)')).toHaveValue(210);
  click('Export');await waitFor(()=>expect(integration.exportRun).toHaveBeenCalled());
  expect(integration.commits).not.toHaveBeenCalled();expect(c.getState().snapshot.project.edits).toHaveLength(0);
});
it('shows the usual alert when a finalized document refuses an edit that was already on its way',async()=>{
  const c=await setup();click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  const before=c.getState().snapshot.project.edits;
  await act(async()=>{await c.edit({type:'appendMeasure'}).catch(()=>{});});
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(FINALIZED_MESSAGE));
  expect(c.getState().snapshot.project.edits).toEqual(before);
});
it('keeps selection, scales, tuning audition and Copy music usable while finalized',async()=>{
  const c=await setup();
  click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  for(const name of ['Select bar','Select track','Select all','Browse scales'])expect(functionalButton(name)).toBeEnabled();
  for(const label of ['Measure','Beat','Staff','Voice','String'])expect(exposeFunctionalControl(screen.getByLabelText(label))).toBeEnabled();
  fireEvent.click(functionalButton('Select bar'));
  await waitFor(()=>expect(functionalButton('Copy music')).toBeEnabled());
  expect(functionalButton('Clear selection')).toBeEnabled();expect(functionalButton('Erase selected notes')).toBeDisabled();
  expect(functionalButton('Remove track')).toBeDisabled();expect(functionalButton('Apply tuning')).toBeDisabled();
  expect(functionalButton('Set note')).toBeDisabled();expect(functionalButton('Append measure')).toBeDisabled();
  expect(integration.commits).not.toHaveBeenCalled();
});
it('treats a mixer move on a finalized document like any edit for redo',async()=>{
  const c=await setup();
  click('Append measure');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(1));
  click('Undo');await waitFor(()=>expect(c.getState().snapshot.canRedo).toBe(true));
  click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toEqual({kind:'finalized'}));
  expect(c.getState().snapshot.canRedo).toBe(true);
  fireEvent.click(exposeFunctionalControl(screen.getByLabelText('Mute')));
  await waitFor(()=>expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setTrackMix']));
  expect(c.getState().snapshot.canRedo).toBe(false);expect(c.getState().snapshot.redoEdit ?? null).toBeNull();
  click('Unfinalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toBeUndefined());
  expect(screen.getByRole('button',{name:'Redo'})).toBeDisabled();
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setTrackMix']);
});

it('enters a note from the notation staff as one undoable edit and refuses it on a finalized document',async()=>{
  const c=await setup();
  const staff=screen.getByRole('group',{name:'Pitch entry staff'});
  fireEvent.click(within(staff).getByRole('button',{name:'G4'}));
  await waitFor(()=>expect(currentBeat(c).notes.map(n=>[n.string,n.fret])).toEqual([[6,3]]));
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setNote']);
  click('Undo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(0));
  click('Redo');await waitFor(()=>expect(currentBeat(c).notes).toHaveLength(1));
  click('Finalize document');await waitFor(()=>expect(c.getState().snapshot.project.lock).toBeDefined());
  fireEvent.click(within(staff).getByRole('button',{name:'A4'}));fireEvent.keyDown(staff,{key:'c'});
  await act(async()=>{await Promise.resolve();});
  expect(c.getState().snapshot.project.edits.map(edit=>edit.type)).toEqual(['setNote']);
});

it('a drum kit change is a sound edit that keeps the music selection',async()=>{
  const c=await setup({...blankProject(),edits:[{type:'addPercussionTrack',name:'Drums',program:0}]});
  fireEvent.click(within(screen.getByRole('grid',{name:'Written measure overview'})).getByRole('gridcell',{name:'Drums, measure 1, rest'}));
  click('Select bar');
  fireEvent.click(within(screen.getByRole('navigation',{name:'Track tools'})).getByRole('button',{name:'Sound'}));
  const kit=await screen.findByLabelText('Drum kit'),before=c.getState().snapshot.project.edits.length;
  fireEvent.change(kit,{target:{value:'32'}});
  await waitFor(()=>expect(c.getState().snapshot.project.edits.length).toBe(before+1));
  expect(c.getState().snapshot.project.edits.at(-1)).toMatchObject({type:'setTrackSound',sound:{drumKit:32}});
  fireEvent.click(exposeFunctionalControl(screen.getByText('Selected playback',{selector:'summary'})));click('Play selection');
  expect(integration.playSelection).toHaveBeenCalledWith({kind:'bars',tracks:[1],firstBar:0,lastBar:0},expect.anything());
},60000);

it('a score locked for editing says so, refuses edits and unlocks with its password without touching the history',async()=>{
  startingProtection.value={edit:'locked',open:false};
  const c=await setup();startingProtection.value=undefined;
  expect(screen.getByText(/Locked for editing: you can play and read this score/)).toBeInTheDocument();
  // It is not finalized: finalizing is offered, and unfinalizing is not.
  expect(menuButton('Finalize document')).toBeInTheDocument();expect(menuButton('Unfinalize document')).not.toBeInTheDocument();
  expect(screen.queryByText('Finalized: editing is locked.')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Undo'})).toBeDisabled();expect(functionalButton('Append measure')).toBeDisabled();
  expect(document.querySelector('[aria-keyshortcuts="Space"]')).toBeEnabled();expect(functionalButton('Save')).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Unlock editing…'}));
  const dialog=await screen.findByRole('dialog',{name:'Unlock editing'});
  const field=within(dialog).getByLabelText('Password to edit');expect(field).toHaveFocus();
  fireEvent.change(field,{target:{value:'student student'}});fireEvent.click(within(dialog).getByRole('button',{name:'Unlock editing'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('That password is not correct.');
  expect(c.getState().snapshot.protection?.edit).toBe('locked');expect(c.getState().error).toBeNull();
  expect(screen.getByText(/Locked for editing/)).toBeInTheDocument();
  fireEvent.change(field,{target:{value:'teacher teacher'}});fireEvent.click(within(dialog).getByRole('button',{name:'Unlock editing'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Unlock editing'})).toBeNull());
  expect(c.getState().snapshot.protection?.edit).toBe('unlocked');
  expect(screen.queryByText(/Locked for editing/)).not.toBeInTheDocument();
  expect(c.getState().snapshot.project.edits).toHaveLength(0);expect(integration.commits).not.toHaveBeenCalled();
  expect(functionalButton('Append measure')).toBeEnabled();
  click('Append measure');await waitFor(()=>expect(c.getState().snapshot.project.edits).toHaveLength(1));
});
it('opens the password protection dialog from the File menu and shows where each password stands',async()=>{
  startingProtection.value={edit:'unlocked',open:true};
  await setup();startingProtection.value=undefined;
  click('Password protection…');
  const dialog=await screen.findByRole('dialog',{name:'Password protection'});
  expect(within(dialog).getByRole('region',{name:'Password to edit'})).toHaveTextContent('Editing is unlocked for now.');
  expect(within(dialog).getByRole('region',{name:'Password to open'})).toHaveTextContent('A password to open is set.');
  fireEvent.click(within(dialog).getByRole('button',{name:'Done'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Password protection'})).toBeNull());
});
