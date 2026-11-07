// @vitest-environment jsdom
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
vi.mock('./export/bridge',()=>({createDocumentExportBridge:vi.fn(()=>({exportPdf:vi.fn(async()=>null),exportMidi:vi.fn(async()=>false),exportMusicXml:vi.fn(async()=>false),exportAsciiTab:vi.fn(async()=>false),exportGp5:vi.fn(async()=>false),exportSvg:vi.fn(async()=>false),exportPng:vi.fn(async()=>false),exportTrackFiles:vi.fn(async()=>false),exportAudio:vi.fn(async()=>null),status:vi.fn(async()=>null),cancel:vi.fn(async()=>{})} satisfies ExportNativeBridge))}));
vi.mock('./export/useExportCoordinator',()=>({useExportCoordinator:()=>({busy:false,progress:undefined,run:async()=>true,cancel:async()=>{}})}));
vi.mock('./audio/NativePlaybackController',()=>({NativePlaybackController:class {
  state={ready:true,playing:false,time:0,endTime:4000,measure:0,speed:100,metronome:false,error:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null};
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
function exposeControl(element:HTMLElement){
  const panel=element.closest<HTMLElement>('.inspector-tabpanel');
  if(panel?.hidden)fireEvent.click(document.getElementById(panel.getAttribute('aria-labelledby')!)!);
  const ancestors:HTMLDetailsElement[]=[];for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)ancestors.unshift(parent);
  for(const disclosure of ancestors)if(!disclosure.open)fireEvent.click(disclosure.querySelector('summary')!);
  expect(element).toBeVisible();return element;
}
const change=(label:string,value:string)=>fireEvent.change(exposeControl(screen.getByLabelText(label)),{target:{value}});
// One role query per click: each getByRole walks the whole workspace, and a second visible-only query doubled the cost under load.
const click=(name:string)=>{
  if(/^Track \d+:/.test(name))fireEvent.click(screen.getByRole('button',{name:'Mixer',hidden:true}));
  const button=screen.getByRole('button',{name,hidden:true});
  fireEvent.click(/^Track \d+:/.test(name)?(expect(button).toBeVisible(),button):exposeControl(button));
};
// These are behaviour tests, not budgets: each mounts the whole workspace in jsdom, where one role query costs about 300 ms.
// The limit is a hang guard sized for loaded CI runners (Windows took 16.9 s for a test that takes 4 to 6 s here); see docs/validation/2026-11-06-ci-failures.md.
const APP_TEST_TIMEOUT=30000;
const trackLabel='Tuning (notes, high to low)',staffLabel='Staff tuning (notes, high to low)';
it('App retunes from note names and refreshes both fields and string labels through undo redo',async()=>{
  const controller=await setup();expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');
  expect(within(exposeControl(screen.getByLabelText('String'))).getByRole('option',{name:'6 · E4'})).toHaveValue('6');
  change(trackLabel,'Eb4 B3 G3 D3 A2 E2');click('Apply tuning');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning[0]).toBe(63));
  expect(screen.getByLabelText(trackLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2');expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2');expect(within(exposeControl(screen.getByLabelText('String'))).getByRole('option',{name:'6 · D#4'})).toHaveValue('6');
  click('Undo');await waitFor(()=>expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2'));expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');
  click('Redo');await waitFor(()=>expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2'));
  change(staffLabel,'E4 B3 G3 D3 A2 Db2');click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning.at(-1)).toBe(37));
  expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 C#2');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 C#2');expect(within(exposeControl(screen.getByLabelText('String'))).getByRole('option',{name:'1 · C#2'})).toHaveValue('1');
  click('Undo');await waitFor(()=>expect(screen.getByLabelText(staffLabel)).toHaveValue('D#4 B3 G3 D3 A2 E2'));
},APP_TEST_TIMEOUT);
it('App invalid tuning notes leave music history and selection unchanged',async()=>{
  const controller=await setup(),before=controller.getState().snapshot.project,score=controller.getState().score;
  for(const [label,button,text] of [[trackLabel,'Apply tuning','E4 bad'],[staffLabel,'Apply staff settings','C-2']]) {
    change(label,text);click(button);expect(screen.getByLabelText(label)).toHaveValue(text);expect(screen.getByRole('alert')).toHaveTextContent(/note|C-1|G9/);expect(controller.getState().snapshot.project).toEqual(before);expect(controller.getState().score).toBe(score);expect(screen.getByLabelText('String')).toHaveValue('6');change(label,'E4 B3 G3 D3 A2 E2');
  }
},APP_TEST_TIMEOUT);
it('App presets fill drafts only and rejected string counts preserve the draft, notes and history',async()=>{
  const controller=await setup();await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3});
  const before=controller.getState().snapshot.project;change('Tuning preset','bass-6-standard-b');expect(screen.getByLabelText(trackLabel)).toHaveValue('C3 G2 D2 A1 E1 B0');expect(screen.getByLabelText(staffLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(controller.getState().snapshot.project).toBe(before);
  click('Apply tuning');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning).toEqual([48,43,38,33,28,23]));expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('bass-6-standard-b');
  const applied=controller.getState(),note=applied.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(note.string).toBe(6);expect(note.fret).toBe(3);
  change(trackLabel,'E5 E5 E5 E5 E5 E5 E5');click('Change string count');await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('no playable string'));expect(controller.getState().score).toBe(applied.score);expect(controller.getState().snapshot.project).toBe(applied.snapshot.project);expect(screen.getByLabelText(trackLabel)).toHaveValue('E5 E5 E5 E5 E5 E5 E5');
  change('Staff tuning preset','bass-4-standard-e');click('Apply staff settings');await waitFor(()=>expect(controller.getState().busy).toBe(false));expect(controller.getState().score).toBe(applied.score);expect(screen.getByLabelText(staffLabel)).toHaveValue('G2 D2 A1 E1');
  // A preset with another string count changes it explicitly; the note keeps its pitch on a playable string.
  change('Tuning preset','guitar-9-standard-csharp');click('Change string count');await waitFor(()=>expect(controller.getState().score.tracks[0].staves[0].tuning).toHaveLength(9));
  const moved=controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect([moved.string,moved.fret,moved.realValue]).toEqual([6,1,note.realValue]);expect(controller.getState().snapshot.project.edits.at(-1)).toEqual({type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35,30,25],keep:'high',tuningName:'Standard C#',crossVoice:true});
},APP_TEST_TIMEOUT);
it('App new-track presets distinguish six-string bass from guitar and refresh across selection and Open',async()=>{
  const controller=await setup(),before=controller.getState().snapshot.project;fireEvent.click(screen.getByText('Add instrument'));change('New track name','Bass six');change('New track tuning preset','bass-6-standard-b');expect(controller.getState().snapshot.project).toBe(before);expect(screen.getByLabelText('New track tuning')).toHaveValue('C3 G2 D2 A1 E1 B0');change('MIDI instrument','25');expect(screen.getByLabelText('New track tuning')).toHaveValue('C3 G2 D2 A1 E1 B0');change('MIDI instrument','33');click('Add track');await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(2));click('Track 2: Bass six');expect(screen.getByLabelText('Tuning preset')).toHaveValue('bass-6-standard-b');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('bass-6-standard-b');
  change('Tuning preset','custom');expect(screen.getByLabelText('Tuning preset')).toHaveValue('custom');click('Track 1: Guitar');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-6-standard-e');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');click('Track 2: Bass six');expect(screen.getByLabelText('Tuning preset')).toHaveValue('bass-6-standard-b');
  const retained=controller.getState();click('Open');await waitFor(()=>expect(activeController()).not.toBe(controller));expect(activeController().getState().score.tracks).toHaveLength(1);expect(controller.getState()).toBe(retained);expect(workspace.getState().documents).toHaveLength(2);expect(screen.getByLabelText(trackLabel)).toHaveValue('E4 B3 G3 D3 A2 E2');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-6-standard-e');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-6-standard-e');
},APP_TEST_TIMEOUT);
it('App nine-string guitar presets commit through staff history and Custom stays editable',async()=>{
  const controller=await setup();fireEvent.click(screen.getByText('Add instrument'));change('New track name','Guitar nine');change('New track tuning preset','guitar-9-standard-csharp');change('MIDI instrument','25');click('Add track');await waitFor(()=>expect(controller.getState().score.tracks).toHaveLength(2));click('Track 2: Guitar nine');expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-standard-csharp');
  change('Staff tuning preset','guitar-9-drop-b');expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(25);click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(23));expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-drop-b');click('Undo');await waitFor(()=>expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('guitar-9-standard-csharp'));click('Redo');await waitFor(()=>expect(screen.getByLabelText('Tuning preset')).toHaveValue('guitar-9-drop-b'));
  change('Staff tuning preset','custom');expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');change(staffLabel,'E4 B3 G3 D3 A2 E2 B1 F#1 D1');click('Apply staff settings');await waitFor(()=>expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(26));expect(screen.getByLabelText('Staff tuning preset')).toHaveValue('custom');
  change('Staff tuning preset','guitar-9-standard-csharp');click('Add staff');await waitFor(()=>expect(controller.getState().score.tracks[1].staves).toHaveLength(2));expect(controller.getState().score.tracks[1].staves[1].tuning).toEqual([64,59,55,50,45,40,35,30,25]);expect(controller.getState().score.tracks[1].staves[0].tuning.at(-1)).toBe(26);
},APP_TEST_TIMEOUT);
