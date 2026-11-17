// @vitest-environment jsdom
import './audio/plugin-test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkspaceApp } from './workspace/WorkspaceApp';
import { WorkspaceController } from './workspace/WorkspaceController';
import type { DocumentSnapshot,NativeWorkspaceBridge,WorkspaceSnapshot } from './workspace/types';
import type { NativeAudioBridge } from './audio/bridge';
import type { ExportNativeBridge } from './export/bridge';
import { DocumentController } from './controller';
import { blankProject, type EditCommand,type Project,type AssetInfo,type DocumentCandidate } from './project';
import type { NativeBridge } from './bridge';
import { DEFAULT_PRACTICE } from './audio/practice-types';

const documentBridges=vi.hoisted(()=>new Map<string,NativeBridge>());
vi.mock('./bridge',async original=>({...await original<typeof import('./bridge')>(),createDocumentBridge:(id:string)=>{const bridge=documentBridges.get(id);if(!bridge)throw new Error('Missing addressed document bridge');return bridge;}}));
vi.mock('./ScoreView',()=>({ScoreView:()=>null}));
vi.mock('./audio/bridge',()=>({createDocumentAudioBridge:vi.fn(()=>({prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)} satisfies NativeAudioBridge))}));
// No MIDI service in jsdom: the inspector's MIDI output panel finds no ports instead of showing a listing error.
vi.mock('./audio/midi-out',async original=>({...await original<typeof import('./audio/midi-out')>(),nativeMidiOut:{ports:async()=>[],setDelay:async()=>{},status:async()=>({ports:[],sent:0,dropped:0,late:0,maxLateMs:0}),testLog:async()=>[]}}));
vi.mock('./audio/midi-in',async original=>({...await original<typeof import('./audio/midi-in')>(),nativeMidiIn:{ports:async()=>[],start:async()=>1,configure:async()=>{},stop:async()=>{},status:async()=>({session:0,state:'stopped' as const,port:'',message:'',chords:0,dropped:0,belowFloor:0}),subscribe:async()=>()=>{}}}));
vi.mock('./export/bridge',()=>({createDocumentExportBridge:vi.fn(()=>({exportPdf:vi.fn(async()=>null),exportMidi:vi.fn(async()=>false),exportMusicXml:vi.fn(async()=>false),exportAsciiTab:vi.fn(async()=>false),exportGp5:vi.fn(async()=>false),exportSvg:vi.fn(async()=>false),exportPng:vi.fn(async()=>false),exportTrackFiles:vi.fn(async()=>false),exportAudio:vi.fn(async()=>null),status:vi.fn(async()=>null),cancel:vi.fn(async()=>{})} satisfies ExportNativeBridge))}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:()=>({busy:false,progress:undefined,run:async()=>true,cancel:async()=>{}})}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  state={ready:true,playing:false,time:0,endTime:4000,measure:0,speed:100,metronome:false,error:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null};
  subscribe=()=>()=>{};getState=()=>this.state;loadDocument=async()=>{};beforeScoreChange=()=>{};destroy=()=>{};
  generation=7;cursorPlaybackChoices=()=>[];selectionPlaybackChoices=()=>[];playbackOccurrences=()=>[];playFromCursor=()=>{};playSelection=()=>{};loopSelection=()=>{};
  backingTimeline=()=>null;backingScoreSelection=()=>({points:[],spans:[]});
  setPractice=()=>{};exportPracticeRatio=()=>1;focus=()=>null;setFocus=async()=>{};
  devices=async()=>[];deviceId=()=>null;backingDurationMs=()=>undefined;mix=()=>undefined;
}}));
const originalViewportWidth=window.innerWidth;
afterEach(()=>{cleanup();Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:originalViewportWidth});});
let workspace:WorkspaceController;
const activeController=()=>workspace.getState().documents.find(entry=>entry.id===workspace.getState().active.documentId)!.controller;
async function setup(initial=blankProject(),openProject:Project=blankProject()) {
  // These exercise tuning/history, with both editing panes visible at the supported desktop width.
  Object.defineProperty(window,'innerWidth',{configurable:true,writable:true,value:1280});
  documentBridges.clear();let next=0,activation=0,active={documentId:'',activationId:''};
  const records=new Map<string,DocumentSnapshot>(),staged=new Map<string,DocumentCandidate>();
  const add=(project:Project,path:string|null=null)=>{
    const documentId=`app-document-${++next}`;let edits:EditCommand[]=[...project.edits],cursor=edits.length,revision=0,assets:Record<string,AssetInfo>={...project.assets},dirty=cursor>0;
    const record=():DocumentSnapshot=>({documentId,revision,snapshot:{project:{...project,assets,edits:edits.slice(0,cursor)},canUndo:cursor>0,canRedo:cursor<edits.length,redoEdit:edits[cursor]??null,dirty,path}});
    const update=()=>{revision++;const value=record();records.set(documentId,value);return value;};
    const check=(expected:number)=>{if(expected!==revision||!records.has(documentId))throw new Error('Invalid addressed revision');};
    const bridge:NativeBridge={documentId,snapshot:async()=>record(),cancelAsset:vi.fn(async()=>true),
      readBackingAsset:async(_assetId:string,_revision:number):Promise<Uint8Array>=>{throw new Error('Backing asset reads are not implemented.');},
      applyEdit:async(command,expected,assetToken)=>{check(expected);if(assetToken&&command.type==='setBacking'&&command.backing)assets={...assets,[command.backing.assetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:20}};edits=edits.slice(0,cursor);edits.push(command);cursor++;dirty=true;return update();},
      undo:async expected=>{check(expected);cursor--;dirty=true;return update();},redo:async expected=>{check(expected);cursor++;dirty=true;return update();},setLock:vi.fn() as never,saveProject:async()=>null,exportGp:vi.fn(async()=>false),askUnsaved:vi.fn(async()=> 'discard' as const),confirmExport:vi.fn(async()=>false)};
    records.set(documentId,record());documentBridges.set(documentId,bridge);return documentId;
  };
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()],active:{...active}});
  const activate=(id:string)=>{if(id!==active.documentId)active={documentId:id,activationId:`app-activation-${++activation}`};return snapshot();};
  const stage=(project:Project,path:string|null,token:string)=>{const candidate={project,path,token};staged.set(token,candidate);return candidate;};
  activate(add(initial));
  const bridge:NativeWorkspaceBridge={snapshot:async()=>snapshot(),readDocument:async()=>openProject?{kind:'candidate',candidate:stage(openProject,'saved.tabplayer','opened-document')}:null,createBlankDocument:async()=>stage(blankProject(),null,'new-document'),cancelDocument:async token=>staged.delete(token),addDocument:async token=>{const candidate=staged.get(token);if(!candidate)throw new Error('Missing document candidate');staged.delete(token);return activate(add(candidate.project,candidate.path));},activateDocument:async id=>activate(id),closeDocuments:async decisions=>{const order=[...records.keys()],index=order.indexOf(active.documentId);for(const decision of decisions)records.delete(decision.documentId);if(!records.size)add(blankProject());return records.has(active.documentId)?snapshot():activate([...records.keys()][Math.min(index,records.size-1)]);}};
  workspace=await WorkspaceController.create(bridge);const controller=activeController();render(<WorkspaceApp workspace={workspace}/>);return controller;
}

const twoTracks=():Project=>({...blankProject(),edits:[{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}]});
const edits=()=>activeController().getState().snapshot.project.edits;
const trackName=()=>(screen.getByLabelText('Track name',{selector:'input'}) as HTMLInputElement).value;
const named=(name:string|RegExp)=>screen.getByRole('button',{name,hidden:true});
// One role query per click: each getByRole walks the whole workspace.
const APP_TEST_TIMEOUT=30000;
it('adds a track from a dialog opened by the dock + and by Track > Add track…, in one undo step, and the sidebar has no Add instrument',async()=>{
  const controller=await setup();expect(document.querySelector('.workstation-inspector details.track-add')).toBeNull();expect(screen.queryByText('Add instrument')).toBeNull();
  const before=controller.getState().snapshot.project;
  fireEvent.click(named('Add a track'));const dialog=within(screen.getByRole('dialog',{name:'Add track'}));
  expect(dialog.getByLabelText('New track name')).toHaveFocus();
  // Cancel adds nothing and records nothing.
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('dialog',{name:'Add track'})).toBeNull();expect(controller.getState().snapshot.project).toBe(before);
  // The menu item opens the same dialog; Escape leaves it with nothing added.
  fireEvent.click(named('Add track…'));expect(screen.getByRole('dialog',{name:'Add track'})).toBeInTheDocument();fireEvent.keyDown(document.activeElement!,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'Add track'})).toBeNull();expect(controller.getState().snapshot.project).toBe(before);
  fireEvent.click(named('Add track…'));fireEvent.change(screen.getByLabelText('New track name'),{target:{value:'Fretless'}});fireEvent.keyDown(screen.getByLabelText('New track name'),{key:'Enter'});
  await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(2));
  expect(screen.queryByRole('dialog',{name:'Add track'})).toBeNull();expect(edits()).toHaveLength(1);expect(edits()[0]).toMatchObject({type:'addTrack',name:'Fretless'});
  // The new track is the selected one.
  await waitFor(()=>expect(trackName()).toBe('Fretless'));
  fireEvent.click(screen.getAllByRole('button',{name:/^Undo/,hidden:true})[0]);await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(1));expect(edits()).toHaveLength(0);
},APP_TEST_TIMEOUT);
it('the arrows in the Information row select the previous and next track and record nothing; Track > Move track up and down reorder in one undo step each',async()=>{
  const controller=await setup(twoTracks());expect(controller.getState().score.tracks).toHaveLength(2);
  const first=trackName(),count=edits().length;
  expect(named('Previous track')).toHaveAttribute('aria-disabled','true');
  fireEvent.click(named('Next track'));await waitFor(()=>expect(trackName()).not.toBe(first));const second=trackName();expect(edits()).toHaveLength(count);
  expect(named('Next track')).toHaveAttribute('aria-disabled','true');fireEvent.click(named('Next track'));expect(trackName()).toBe(second);
  fireEvent.click(named('Previous track'));await waitFor(()=>expect(trackName()).toBe(first));expect(edits()).toHaveLength(count);
  // Moving the selected (first) track down is one edit, and the selection follows it.
  expect(named('Move track up')).toHaveAttribute('aria-disabled','true');
  fireEvent.click(named('Move track down'));await waitFor(()=>expect(edits()).toHaveLength(count+1));expect(edits().at(-1)).toEqual({type:'moveTrack',track:0,to:1});
  await waitFor(()=>expect(controller.getState().score.tracks[1].name).toBe(first));expect(trackName()).toBe(first);
  expect(named('Move track down')).toHaveAttribute('aria-disabled','true');
  fireEvent.click(named('Move track up'));await waitFor(()=>expect(edits()).toHaveLength(count+2));expect(edits().at(-1)).toEqual({type:'moveTrack',track:1,to:0});
  fireEvent.click(screen.getAllByRole('button',{name:/^Undo/,hidden:true})[0]);await waitFor(()=>expect(edits()).toHaveLength(count+1));
},APP_TEST_TIMEOUT);
