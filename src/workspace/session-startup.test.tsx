// @vitest-environment jsdom
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act,fireEvent,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { blankProject } from '../project';
import type { AppProps } from '../App';
import type { DocumentSnapshot } from './types';
import type { RecoveryPreview,RecoveryStatus,SessionPreferences,SessionResolution,SessionStartup } from './recovery-types';
import { initialDocumentView } from './view-state';

const boundary=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),snapshot:vi.fn(),audio:vi.fn(),props:[] as (AppProps&{sessionMenu?:ReactNode;recoveryStatus?:ReactNode})[],onClose:null as null|((event:{preventDefault:()=>void})=>Promise<void>),destroy:vi.fn(),root:null as Root|null,creates:0}));
vi.mock('@tauri-apps/api/core',()=>({invoke:boundary.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:boundary.listen}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async(callback:NonNullable<typeof boundary.onClose>)=>{boundary.onClose=callback;return()=>{};},destroy:boundary.destroy})}));
vi.mock('react-dom/client',async()=>{const actual=await vi.importActual<typeof import('react-dom/client')>('react-dom/client');return {...actual,createRoot:(container:Element)=>{boundary.creates++;boundary.root=actual.createRoot(container);return boundary.root;}};});
vi.mock('../bridge',()=>({nativeWorkspaceBridge:{snapshot:boundary.snapshot},createDocumentBridge:(documentId:string)=>({documentId,confirmExport:async()=>true,exportGp:async()=>true})}));
vi.mock('../audio/bridge',()=>({createDocumentAudioBridge:boundary.audio}));
vi.mock('../export/bridge',()=>({createDocumentExportBridge:()=>({})}));
vi.mock('../App',()=>({App:(props:AppProps&{sessionMenu?:ReactNode;recoveryStatus?:ReactNode})=>{boundary.props.push(props);return <main aria-label="Score editor">{props.documentTabs}{props.sessionMenu}{props.recoveryStatus}<p aria-label="Restored score">{props.controller.getState().score.title}</p></main>;}}));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function record(id:string,title=id):DocumentSnapshot {const project=blankProject();if(project.base.kind==='blank')project.base.title=title;return {documentId:id,revision:3,snapshot:{project,canUndo:false,canRedo:false,dirty:true,path:null}};}
const ready:RecoveryStatus={state:'ready',capturedAtUnixMs:1792050000000,generation:7,error:null};
function preview(reason:RecoveryPreview['reason']='crash',documents=[record('second'),record('first')]):RecoveryPreview{return {token:'opaque-native-token',reason,documents,views:Object.fromEntries(documents.map(d=>[d.documentId,{...initialDocumentView(),zoom:125}])),activeDocumentId:documents.at(-1)?.documentId??null,issues:[],capturedAtUnixMs:1792050000000};}
let startup:SessionStartup,resolution:SessionResolution,handlers:Record<string,(args:unknown)=>unknown>,root:HTMLDivElement;
beforeEach(()=>{
  vi.resetModules();boundary.invoke.mockReset();boundary.listen.mockReset().mockResolvedValue(()=>{});boundary.snapshot.mockReset();boundary.audio.mockReset().mockReturnValue({});boundary.destroy.mockReset().mockResolvedValue(undefined);boundary.props=[];boundary.onClose=null;boundary.root=null;boundary.creates=0;
  startup={preferences:{version:1,restorePreviousSession:true},preview:null};const blank=record('new-blank','Untitled');resolution={workspace:{documents:[blank],active:{documentId:blank.documentId,activationId:'fresh-owner'}},views:{},issues:[]};
  handlers={session_startup:()=>startup,session_resolve:()=>resolution,recovery_status:()=>ready,workspace_set_view:()=>undefined,session_preferences_set:args=>({version:1,restorePreviousSession:(args as {restorePreviousSession:boolean}).restorePreviousSession}),recovery_retry:()=>ready};
  boundary.invoke.mockImplementation(async(command:string,args:unknown)=>{if(!(command in handlers))throw new Error(`Unexpected IPC: ${command}`);return handlers[command](args);});boundary.snapshot.mockImplementation(async()=>resolution.workspace);
  root=document.createElement('div');root.id='root';document.body.append(root);
});
afterEach(async()=>{await act(async()=>{boundary.root?.unmount();});root.remove();vi.clearAllMocks();});
async function boot(){await act(async()=>{await import('../main');});}
function restoreResolution(value:RecoveryPreview){resolution={workspace:{documents:value.documents,active:{documentId:value.activeDocumentId!,activationId:'fresh-owner'}},views:value.views,issues:[]};}
const resolveCalls=()=>boundary.invoke.mock.calls.filter(call=>call[0]==='session_resolve');
it('registers close protection before startup and mounts no editor or audio before durable first-run resolution',async()=>{
  const starting=deferred<SessionStartup>(),commit=deferred<SessionResolution>();handlers.session_startup=()=>starting.promise;handlers.session_resolve=()=>commit.promise;
  await boot();expect(boundary.onClose).toBeTypeOf('function');expect(boundary.invoke).toHaveBeenCalledWith('session_startup');expect(boundary.props).toHaveLength(0);expect(boundary.audio).not.toHaveBeenCalled();expect(boundary.snapshot).not.toHaveBeenCalled();
  await act(async()=>starting.resolve(startup));expect(resolveCalls()).toEqual([['session_resolve',{token:null,documentIds:[]}]]);expect(boundary.props).toHaveLength(0);expect(boundary.audio).not.toHaveBeenCalled();
  await act(async()=>commit.resolve(resolution));expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument();expect(boundary.creates).toBe(1);expect(boundary.snapshot).not.toHaveBeenCalled();
});
it.each([true,false])('crash recovery requires an explicit choice even when restore preference is %s',async preference=>{
  const value=preview();startup={preferences:{version:1,restorePreviousSession:preference},preview:value};restoreResolution(value);await boot();expect(screen.getByRole('dialog')).toHaveTextContent('Recover unsaved work?');expect(resolveCalls()).toEqual([]);expect(boundary.props).toHaveLength(0);expect(boundary.audio).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(resolveCalls()).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Restore'}));await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(resolveCalls()).toEqual([['session_resolve',{token:'opaque-native-token',documentIds:['second','first']}] ]);expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['second','first']);expect(boundary.props.at(-1)!.documentView.zoom).toBe(125);expect(boundary.snapshot).not.toHaveBeenCalled();
});
it.each([true,false])('clean session follows preference %s without prompting',async preference=>{
  const value=preview('clean');startup={preferences:{version:1,restorePreviousSession:preference},preview:value};if(preference)restoreResolution(value);await boot();await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(resolveCalls()).toEqual([['session_resolve',{token:value.token,documentIds:preference?['second','first']:[]}]]);
});
it('discard resolves only the opaque token and empty IDs after an explicit choice',async()=>{
  startup.preview=preview();await boot();expect(resolveCalls()).toEqual([]);fireEvent.click(screen.getByRole('button',{name:'Discard recovery'}));await waitFor(()=>expect(resolveCalls()).toHaveLength(1));expect(resolveCalls()).toEqual([['session_resolve',{token:'opaque-native-token',documentIds:[]}]]);await waitFor(()=>expect(screen.getByLabelText('Restored score')).toHaveTextContent('Untitled'));
});
it.each(['unavailable','all-invalid'] as const)('%s recovery requires explicit Start new session and keeps evidence untouched before choice',async kind=>{
  const invalid=record('invalid');invalid.snapshot.project.engineVersion='future' as '1.8.4';startup.preview=kind==='unavailable'?{...preview('unavailable',[]),issues:[{documentId:null,message:'Checkpoint is corrupt'}]}:preview('crash',[invalid]);await boot();expect(screen.getByRole('button',{name:'Start new session'})).toBeEnabled();expect(resolveCalls()).toEqual([]);expect(boundary.props).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'Start new session'}));await waitFor(()=>expect(resolveCalls()).toHaveLength(1));expect(resolveCalls()).toEqual([['session_resolve',{token:'opaque-native-token',documentIds:[]}]]);
});
it('builds every applied preview score and excludes only the invalid middle document, preserving order',async()=>{
  const first=record('z','Applied title'),bad=record('bad'),last=record('a');first.snapshot.project.edits=[{type:'setScoreInfo',title:'Edited recovered title',artist:'Author',tempo:120}];bad.snapshot.project.engineVersion='future' as '1.8.4';const value=preview('crash',[first,bad,last]);value.issues=[{documentId:null,message:'Older checkpoint used'}];startup.preview=value;restoreResolution({...value,documents:[first,last]});await boot();expect(screen.getByRole('dialog')).toHaveTextContent(/bad|engine|version/i);expect(screen.getByRole('dialog')).toHaveTextContent('Older checkpoint used');expect(resolveCalls()).toEqual([]);fireEvent.click(screen.getByRole('button',{name:'Restore'}));await waitFor(()=>expect(resolveCalls()).toHaveLength(1));expect(resolveCalls()).toEqual([['session_resolve',{token:'opaque-native-token',documentIds:['z','a']}]]);await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));expect(screen.getAllByRole('tab')[0]).toHaveTextContent('Edited recovered title');
});
it('failed durable resolution retains the prompt and permits retry without mounting an editor',async()=>{
  startup.preview=preview();handlers.session_resolve=()=>{throw new Error('manifest write denied');};await boot();fireEvent.click(screen.getByRole('button',{name:'Restore'}));await waitFor(()=>expect(screen.getByText(/manifest write denied/)).toBeInTheDocument());expect(screen.getByRole('dialog')).toBeInTheDocument();expect(boundary.props).toHaveLength(0);expect(boundary.audio).not.toHaveBeenCalled();restoreResolution(startup.preview);handlers.session_resolve=()=>resolution;fireEvent.click(screen.getByRole('button',{name:'Restore'}));await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(resolveCalls()).toHaveLength(2);
});
it('preference checkbox changes only after native acknowledgement and retains the last value on failure',async()=>{
  const setting=deferred<SessionPreferences>();handlers.session_preferences_set=()=>setting.promise;await boot();const file=screen.queryByText('File',{selector:'summary'});if(file)fireEvent.click(file);const checkbox=await screen.findByRole('checkbox',{name:'Restore previous session'});expect(checkbox).toBeChecked();fireEvent.click(checkbox);expect(checkbox).toBeChecked();expect(boundary.invoke).toHaveBeenCalledWith('session_preferences_set',{restorePreviousSession:false});await act(async()=>setting.resolve({version:1,restorePreviousSession:false}));expect(checkbox).not.toBeChecked();handlers.session_preferences_set=()=>{throw new Error('preferences write denied');};fireEvent.click(checkbox);await waitFor(()=>expect(screen.getByText(/preferences write denied/)).toBeInTheDocument());expect(checkbox).not.toBeChecked();
});
it('failed backup stays distinct from file saving and Retry flushes the latest native view before checkpoint retry',async()=>{
  handlers.recovery_status=()=>({...ready,state:'failed',error:'backup write denied'});await boot();expect(await screen.findByText(/backup write denied/)).toBeInTheDocument();expect(screen.queryByText(/^Saved$/)).not.toBeInTheDocument();const view=deferred<void>();handlers.workspace_set_view=()=>view.promise;act(()=>boundary.props.at(-1)!.onViewChange({...initialDocumentView(),zoom:150}));fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(boundary.invoke.mock.calls.filter(call=>call[0]==='recovery_retry')).toEqual([]);await act(async()=>view.resolve());await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('recovery_retry'));const retry=boundary.invoke.mock.calls.findIndex(call=>call[0]==='recovery_retry');const sent=boundary.invoke.mock.calls.findIndex(call=>call[0]==='workspace_set_view'&&(call[1] as {view:{zoom:number}}).view.zoom===150);expect(sent).toBeGreaterThanOrEqual(0);expect(sent).toBeLessThan(retry);expect(boundary.invoke.mock.calls[retry]).toEqual(['recovery_retry']);
});

it('closing an unresolved recovery prompt destroys the window without discarding or committing recovery',async()=>{
  startup.preview=preview();await boot();expect(screen.getByRole('dialog')).toBeInTheDocument();const event={preventDefault:vi.fn()};await act(async()=>{await boundary.onClose!(event);});expect(event.preventDefault).toHaveBeenCalledOnce();expect(boundary.destroy).toHaveBeenCalledOnce();expect(resolveCalls()).toEqual([]);expect(boundary.invoke.mock.calls.filter(call=>call[0]==='session_shutdown')).toEqual([]);expect(boundary.props).toHaveLength(0);expect(boundary.audio).not.toHaveBeenCalled();
});
it.each(['pending','writing'] as const)('%s backup never claims the ordinary project file was saved',async state=>{
  handlers.recovery_status=()=>({...ready,state});await boot();await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(screen.getByRole('status')).toHaveTextContent(/backup|checkpoint/i);expect(screen.getByRole('status')).not.toHaveTextContent(/saved/i);expect(boundary.props.at(-1)!.controller.getState().snapshot.dirty).toBe(true);
});

it('native recovery status events report failed backup without changing the score or its acknowledged snapshot',async()=>{
  await boot();const before=boundary.props.at(-1)!.controller.getState();const subscription=boundary.listen.mock.calls.find(call=>call[0]==='recovery-status');expect(subscription).toBeDefined();await act(async()=>{subscription![1]({payload:{...ready,state:'failed',error:'backup disk full'}});});expect(screen.getByText(/backup disk full/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Retry'})).toBeEnabled();expect(boundary.props.at(-1)!.controller.getState()).toBe(before);
});
it('first-run resolve failure retries with the original null token rather than a fabricated preview token',async()=>{
  handlers.session_resolve=()=>{throw new Error('initial manifest write failed');};await boot();expect(screen.getByRole('dialog')).toHaveTextContent('initial manifest write failed');expect(boundary.props).toHaveLength(0);expect(resolveCalls()).toEqual([['session_resolve',{token:null,documentIds:[]}]]);handlers.session_resolve=()=>resolution;fireEvent.click(screen.getByRole('button',{name:'Start new session'}));await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(resolveCalls()).toEqual([['session_resolve',{token:null,documentIds:[]}],['session_resolve',{token:null,documentIds:[]}]]);
});
it('clean automatic restore failure exposes Restore so the same ordered recovery can be retried',async()=>{
  const value=preview('clean');startup.preview=value;restoreResolution(value);handlers.session_resolve=()=>{throw new Error('clean manifest write failed');};await boot();expect(screen.getByRole('dialog')).toHaveTextContent('clean manifest write failed');expect(screen.getByRole('button',{name:'Restore'})).toBeEnabled();expect(boundary.props).toHaveLength(0);expect(resolveCalls()).toEqual([['session_resolve',{token:value.token,documentIds:['second','first']}]]);handlers.session_resolve=()=>resolution;fireEvent.click(screen.getByRole('button',{name:'Restore'}));await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());expect(resolveCalls()).toEqual([['session_resolve',{token:value.token,documentIds:['second','first']}],['session_resolve',{token:value.token,documentIds:['second','first']}]]);
});
it('a delayed initial status query cannot replace a newer failed recovery-status event',async()=>{
  const query=deferred<RecoveryStatus>();handlers.recovery_status=()=>query.promise;await boot();expect(boundary.invoke).toHaveBeenCalledWith('recovery_status');const subscription=boundary.listen.mock.calls.find(call=>call[0]==='recovery-status')!;await act(async()=>{subscription[1]({payload:{...ready,state:'failed',generation:8,error:'new backup failure'}});});expect(screen.getByText(/new backup failure/)).toBeInTheDocument();await act(async()=>query.resolve(ready));expect(screen.getByText(/new backup failure/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Retry'})).toBeEnabled();expect(screen.queryByText(/Recovery backup complete/)).not.toBeInTheDocument();
});
it('a committed ready status with cleanup warning shows backup completion and its acknowledged time',async()=>{
  handlers.recovery_status=()=>({...ready,error:'Old checkpoint cleanup failed'});await boot();expect(screen.getByRole('status')).toHaveTextContent('Recovery backup complete.');expect(screen.getByText(/Old checkpoint cleanup failed/)).toBeInTheDocument();expect(screen.queryByText(/Recovery backup failed/)).not.toBeInTheDocument();expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime','2026-10-15T07:40:00.000Z');expect(boundary.props.at(-1)!.controller.getState().snapshot.dirty).toBe(true);
});
it('Retry treats ready with cleanup warning as a committed backup and advances the acknowledged time',async()=>{
  handlers.recovery_status=()=>({...ready,state:'failed',error:'backup write denied'});handlers.recovery_retry=()=>({...ready,generation:8,capturedAtUnixMs:1792050060000,error:'Old checkpoint cleanup failed'});await boot();expect(screen.getByRole('status')).toHaveTextContent('Recovery backup failed: backup write denied');fireEvent.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('recovery_retry'));await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Recovery backup complete.'));expect(screen.getByText(/Old checkpoint cleanup failed/)).toBeInTheDocument();expect(screen.queryByText(/Recovery backup failed/)).not.toBeInTheDocument();expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime','2026-10-15T07:41:00.000Z');expect(boundary.props.at(-1)!.controller.getState().snapshot.dirty).toBe(true);
});
it.each([
  {state:'failed' as const,error:'newer backup failure',text:'Recovery backup failed: newer backup failure'},
  {state:'pending' as const,error:null,text:'Recovery backup pending.'},
])('a delayed Retry acknowledgement cannot replace a newer $state recovery-status event',async({state,error,text})=>{
  const response=deferred<RecoveryStatus>();handlers.recovery_status=()=>({...ready,state:'failed',error:'initial backup failure'});handlers.recovery_retry=()=>response.promise;
  await boot();const controller=boundary.props.at(-1)!.controller,before=controller.getState();fireEvent.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('recovery_retry'));
  const subscription=boundary.listen.mock.calls.find(call=>call[0]==='recovery-status')!;
  await act(async()=>{subscription[1]({payload:{state,error,generation:9,capturedAtUnixMs:1792050120000}});});expect(screen.getByRole('status')).toHaveTextContent(text);expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime','2026-10-15T07:42:00.000Z');expect(controller.getState()).toBe(before);
  await act(async()=>response.resolve({...ready,generation:8,capturedAtUnixMs:1792050060000}));expect(screen.getByRole('status')).toHaveTextContent(text);expect(screen.getByRole('status')).not.toHaveTextContent('Recovery backup complete.');expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime','2026-10-15T07:42:00.000Z');if(state==='failed')expect(screen.getByRole('button',{name:'Retry'})).toBeEnabled();else expect(screen.queryByRole('button',{name:'Retry'})).not.toBeInTheDocument();expect(boundary.props.at(-1)!.controller).toBe(controller);expect(controller.getState()).toBe(before);
});

it('an actually restored clean pathless baseline score suppresses first-run Library welcome',async()=>{
  const restored=record('restored-template');restored.snapshot.dirty=false;restored.snapshot.project.baselineEdits=[{type:'setScoreInfo',title:'Restored ensemble',artist:'Composer',tempo:110}];const value=preview('clean',[restored]);startup.preview=value;restoreResolution(value);
  handlers.file_library_snapshot=()=>({version:1,revision:0,welcomeSeen:false,recents:[],roots:[],templates:[],examples:[],warning:null});
  await boot();await waitFor(()=>expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument());await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('file_library_snapshot'));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByLabelText('Restored score')).toHaveTextContent('Restored ensemble');expect(boundary.invoke.mock.calls.filter(call=>call[0]==='file_library_change')).toEqual([]);
});
it('welcome opens only after recovery discard resolves and acknowledges only after its actual dialog is shown',async()=>{
  startup.preview=preview();const catalog={version:1,revision:0,welcomeSeen:false,recents:[],roots:[],templates:[],examples:[],warning:null};handlers.file_library_snapshot=()=>catalog;handlers.file_library_change=args=>{expect(document.querySelector('.library-dialog[open]')).not.toBeNull();expect(args).toEqual({expectedRevision:0,change:{kind:'welcomeSeen'}});return {...catalog,revision:1,welcomeSeen:true};};
  await boot();expect(screen.getByRole('dialog')).toHaveTextContent('Recover unsaved work?');expect(boundary.invoke.mock.calls.filter(call=>String(call[0]).startsWith('file_library'))).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Discard recovery'}));await waitFor(()=>expect(screen.getByRole('dialog')).toHaveClass('library-dialog'));await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('file_library_change',{expectedRevision:0,change:{kind:'welcomeSeen'}}));expect(screen.getByRole('main',{name:'Score editor'})).toBeInTheDocument();expect(boundary.creates).toBe(1);expect(boundary.audio).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'Close'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('Library event warnings stay visible while the catalog is closed without changing music or recovery feedback',async()=>{
  handlers.file_library_snapshot=()=>({version:1,revision:0,welcomeSeen:true,recents:[],roots:[],templates:[],examples:[],warning:null});await boot();await waitFor(()=>expect(boundary.invoke).toHaveBeenCalledWith('file_library_snapshot'));const before=boundary.props.at(-1)!.controller.getState(),event=boundary.listen.mock.calls.find(call=>call[0]==='file-library-changed')!;
  await act(async()=>event[1]({payload:{revision:1,warning:'History could not be written. Retry in Library.'}}));expect(screen.getByRole('alert')).toHaveTextContent('History could not be written. Retry in Library.');expect(screen.getByRole('status')).toHaveTextContent('Recovery backup complete.');expect(boundary.props.at(-1)!.controller.getState()).toBe(before);expect(boundary.audio).toHaveBeenCalledOnce();
});
