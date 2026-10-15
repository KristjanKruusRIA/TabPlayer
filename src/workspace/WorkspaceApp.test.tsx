// @vitest-environment jsdom
import { useEffect } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AppProps } from '../App';
import type { NativeBridge } from '../bridge';
import type { NativeAudioBridge } from '../audio/bridge';
import type { ExportNativeBridge } from '../export/bridge';
import { blankProject,type EditCommand,type Project,type DocumentCandidate } from '../project';
import type { CloseDocument,DocumentSnapshot,NativeWorkspaceBridge,WorkspaceSnapshot } from './types';
import { WorkspaceController } from './WorkspaceController';
import { WorkspaceApp } from './WorkspaceApp';
import { initialDocumentView } from './view-state';
import type { NativeSessionBridge } from './recovery-types';

const mocks=vi.hoisted(()=>({bridges:new Map<string,NativeBridge>(),audio:new Map<string,NativeAudioBridge>(),exports:new Map<string,ExportNativeBridge>(),props:[] as AppProps[],mounted:0,mounts:0,unmounts:0}));
vi.mock('../bridge',()=>({createDocumentBridge:(id:string)=>{const bridge=mocks.bridges.get(id);if(!bridge)throw new Error('Missing addressed bridge');return bridge;}}));
vi.mock('../audio/bridge',()=>({createDocumentAudioBridge:vi.fn((owner:{documentId:string;activationId:string})=>{const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};mocks.audio.set(owner.activationId,bridge);return bridge;})}));
vi.mock('../export/bridge',()=>({createDocumentExportBridge:vi.fn((id:string)=>{const bridge:ExportNativeBridge={exportPdf:vi.fn(async()=>null),exportMidi:vi.fn(async()=>false),exportAudio:vi.fn(async()=>null),status:vi.fn(async()=>null),cancel:vi.fn(async()=>{})};mocks.exports.set(id,bridge);return bridge;})}));
vi.mock('../App',()=>({App:(props:AppProps)=>{mocks.props.push(props);useEffect(()=>{mocks.mounted++;mocks.mounts++;return()=>{mocks.mounted--;mocks.unmounts++;};},[]);return <main data-testid="active-editor">{props.documentTabs}<button onClick={()=>void props.onNew()}>New probe</button><button onClick={()=>void props.onOpen()}>Open probe</button><button onClick={()=>void props.onClose()}>Close probe</button><button onClick={()=>void props.onCloseAll()}>Close all probe</button><input aria-label="Editor draft" defaultValue=""/>{props.workspaceError&&<p role="alert">{props.workspaceError}</p>}</main>;}}));
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});mocks.bridges.clear();mocks.audio.clear();mocks.exports.clear();mocks.props=[];mocks.mounted=0;mocks.mounts=0;mocks.unmounts=0;});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const note:Extract<EditCommand,{type:'setNote'}>={type:'setNote',target,string:6,fret:7};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function fixture(){
  let next=0,activation=0,active={documentId:'',activationId:''};
  const records=new Map<string,DocumentSnapshot>(),redo=new Map<string,EditCommand[]>(),staged=new Map<string,DocumentCandidate>();
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()].map(r=>structuredClone(r)),active:{...active}});
  const activate=(id:string)=>{if(!records.has(id))throw new Error('Closed document');if(active.documentId!==id)active={documentId:id,activationId:`activation-${++activation}`};return snapshot();};
  const add=(project=blankProject(),path:string|null=null)=>{
    const documentId=`document / ${++next}`;let record:DocumentSnapshot={documentId,revision:0,snapshot:{project,canUndo:project.edits.length>0,canRedo:false,dirty:false,path}};
    records.set(documentId,record);redo.set(documentId,[]);
    const update=(project:Project,dirty=true)=>{record={...record,revision:record.revision+1,snapshot:{...record.snapshot,project,dirty,canUndo:project.edits.length>0,canRedo:redo.get(documentId)!.length>0,redoEdit:redo.get(documentId)!.at(-1)??null}};records.set(documentId,record);return structuredClone(record);};
    const check=(revision:number)=>{if(!records.has(documentId)||revision!==record.revision)throw new Error('Invalid addressed revision');};
    const bridge:NativeBridge={documentId,snapshot:vi.fn(async()=>structuredClone(record)),cancelAsset:vi.fn(async()=>true),
      applyEdit:vi.fn(async(command,revision)=>{check(revision);redo.set(documentId,[]);return update({...record.snapshot.project,edits:[...record.snapshot.project.edits,command]});}),
      undo:vi.fn(async revision=>{check(revision);const edits=[...record.snapshot.project.edits];redo.get(documentId)!.push(edits.pop()!);return update({...record.snapshot.project,edits});}),
      redo:vi.fn(async revision=>{check(revision);return update({...record.snapshot.project,edits:[...record.snapshot.project.edits,redo.get(documentId)!.pop()!]});}),
      saveProject:vi.fn(async(_saveAs,revision)=>{check(revision);return update(record.snapshot.project,false);}),
      askUnsaved:vi.fn(async()=> 'discard' as const),exportGp:vi.fn(async()=>true),confirmExport:async()=>true};
    mocks.bridges.set(documentId,bridge);return documentId;
  };
  const first=add();activate(first);
  const stage=(project=blankProject(),token='candidate-token')=>{const candidate={project,path:null,token};staged.set(token,candidate);return candidate;};
  const bridge:NativeWorkspaceBridge={snapshot:vi.fn(async()=>snapshot()),readDocument:vi.fn(async()=>null),createBlankDocument:vi.fn(async()=>stage()),cancelDocument:vi.fn(async token=>staged.delete(token)),
    addDocument:vi.fn(async token=>{const candidate=staged.get(token);if(!candidate)throw new Error('Missing token');const id=add(candidate.project,candidate.path);staged.delete(token);return activate(id);}),
    activateDocument:vi.fn(async id=>activate(id)),closeDocuments:vi.fn(async entries=>{for(const entry of entries){const r=records.get(entry.documentId);if(!r||r.revision!==entry.revision||r.snapshot.dirty&&!entry.discard)throw new Error('Invalid close');}const order=[...records.keys()],index=order.indexOf(active.documentId);for(const e of entries)records.delete(e.documentId);if(!records.size)add();if(!records.has(active.documentId))activate([...records.keys()][Math.min(index,records.size-1)]);return snapshot();})};
  return {bridge,first,stage,records,staged,snapshot};
}

async function setup(){const f=fixture(),workspace=await WorkspaceController.create(f.bridge);render(<WorkspaceApp workspace={workspace}/>);return {...f,workspace};}
const current=(workspace:WorkspaceController)=>workspace.getState().documents.find(entry=>entry.id===workspace.getState().active.documentId)!;
const props=()=>mocks.props.at(-1)!;
it('switching preserves independent views and histories and mounts one keyed active editor with bound bridges',async()=>{
  const {workspace:w,first}=await setup(),a=current(w);expect(screen.getAllByTestId('active-editor')).toHaveLength(1);expect(mocks.mounted).toBe(1);
  expect(props().controller).toBe(a.controller);expect(props().audioBridge).toBe(mocks.audio.get(w.getState().active.activationId));expect(props().exportBridge).toBe(mocks.exports.get(first));
  expect(props().documentBridge).toMatchObject({confirmExport:mocks.bridges.get(first)!.confirmExport,exportGp:mocks.bridges.get(first)!.exportGp});
  await act(async()=>{await a.controller.edit(note);await a.controller.undo();});const history=a.controller.getState();
  act(()=>props().onViewChange({...initialDocumentView(),zoom:127.5,instrumentVisible:true,target:{...target,bar:2},trackView:{kind:'all'}}));
  const clip=await a.controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');w.clipboard.set(clip);
  fireEvent.change(screen.getByLabelText('Editor draft'),{target:{value:'unfinished'}});
  fireEvent.click(screen.getByRole('button',{name:'New probe'}));await waitFor(()=>expect(w.getState().documents).toHaveLength(2));
  const b=current(w);expect(props().controller).toBe(b.controller);expect(props().clipboard).toBe(w.clipboard);expect(props().clipboard.get()).toEqual(clip);expect(props().documentView).toEqual(initialDocumentView());expect(screen.getByLabelText('Editor draft')).toHaveValue('');
  await act(async()=>{await b.controller.edit({...note,fret:11});await w.activate(first);});
  expect(props().controller).toBe(a.controller);expect(a.controller.getState().snapshot).toBe(history.snapshot);expect(a.controller.getState().score).toBe(history.score);expect(a.controller.getState().settings).toBe(history.settings);expect(b.controller.getState().snapshot.project.edits).toEqual([{...note,fret:11}]);expect(props().documentView).toMatchObject({zoom:127.5,instrumentVisible:true,target:{bar:2},trackView:{kind:'all'}});
  expect(mocks.mounted).toBe(1);expect(mocks.mounts).toBe(3);expect(mocks.unmounts).toBe(2);expect(screen.getAllByTestId('active-editor')).toHaveLength(1);
  expect(props().audioBridge).toBe(mocks.audio.get(w.getState().active.activationId));for(const audio of mocks.audio.values()){expect(audio.prepare).not.toHaveBeenCalled();expect(audio.command).not.toHaveBeenCalled();}
});
it('connects the active tab and panel with encoded IDs and keeps focus meaningful across switching',async()=>{
  const {workspace:w,first}=await setup();await act(async()=>{await w.newDocument();});const b=current(w);const tab=screen.getAllByRole('tab')[0];tab.focus();fireEvent.click(tab);await waitFor(()=>expect(w.getState().active.documentId).toBe(first));
  const selected=screen.getByRole('tab',{selected:true}),panel=screen.getByRole('tabpanel');expect(panel).toHaveAttribute('id',`document-panel-${encodeURIComponent(first)}`);expect(panel).toHaveAttribute('aria-labelledby',`document-tab-${encodeURIComponent(first)}`);expect(selected).toHaveAttribute('aria-controls',panel.id);expect(selected).toHaveFocus();
  await act(async()=>{await w.close(first);});expect(w.getState().active.documentId).toBe(b.id);expect(screen.getByRole('tab',{selected:true})).toHaveFocus();
});
it('close buttons close inactive scores without activation and active close selects its neighbor',async()=>{
  const {workspace:w,bridge,first}=await setup();await act(async()=>{await w.newDocument();});const b=current(w),owner=w.getState().active;vi.mocked(bridge.activateDocument).mockClear();
  fireEvent.click(screen.getByRole('button',{name:/Close Score 1 of 2:/}));await waitFor(()=>expect(w.getState().documents).toHaveLength(1));expect(w.getState().active).toEqual(owner);expect(bridge.activateDocument).not.toHaveBeenCalled();expect(bridge.closeDocuments).toHaveBeenLastCalledWith([{documentId:first,revision:0,discard:false}]);
  fireEvent.click(screen.getByRole('button',{name:'Close probe'}));await waitFor(()=>expect(current(w).id).not.toBe(b.id));expect(w.getState().documents).toHaveLength(1);
});
it('editor operation leases disable all tabs and close controls until one idempotent release',async()=>{
  const {workspace:w}=await setup();await act(async()=>{await w.newDocument();});let release!:()=>void;act(()=>{release=props().beginEditorOperation();});expect(props().workspaceBusy).toBe(true);for(const tab of screen.getAllByRole('tab'))expect(tab).toBeDisabled();for(const close of screen.getAllByRole('button',{name:/Close Score/}))expect(close).toBeDisabled();
  const owner=w.getState().active;fireEvent.click(screen.getAllByRole('tab')[0]);expect(w.getState().active).toBe(owner);await act(async()=>{expect(await w.requestWindowClose()).toBe(false);});expect(screen.getByRole('alert')).toHaveTextContent('Finish or cancel the current operation before closing.');
  act(()=>{release();release();});expect(props().workspaceBusy).toBe(false);for(const tab of screen.getAllByRole('tab'))expect(tab).toBeEnabled();
});
it('canceled and reentrant close keep all editors live until every native decision succeeds',async()=>{
  const {workspace:w,bridge,first}=await setup();await act(async()=>{await current(w).controller.edit(note);await w.newDocument();await current(w).controller.edit({...note,fret:11});});const b=current(w),before=w.getState().documents.map(entry=>entry.controller.getState()),decision=deferred<'cancel'>();vi.mocked(mocks.bridges.get(first)!.askUnsaved).mockReturnValueOnce(decision.promise);
  fireEvent.click(screen.getByRole('button',{name:'Close all probe'}));expect(props().workspaceBusy).toBe(true);await act(async()=>{expect(await w.requestWindowClose()).toBe(false);});expect(mocks.bridges.get(first)!.askUnsaved).toHaveBeenCalledOnce();await act(async()=>decision.resolve('cancel'));await waitFor(()=>expect(props().workspaceBusy).toBe(false));expect(w.getState().documents).toHaveLength(2);expect(w.getState().active.documentId).toBe(b.id);expect(bridge.closeDocuments).not.toHaveBeenCalled();w.getState().documents.forEach((entry,index)=>{const state=entry.controller.getState();expect(state.snapshot).toBe(before[index].snapshot);expect(state.score).toBe(before[index].score);expect(state.settings).toBe(before[index].settings);});
});
it('Open adds and activates its candidate and duplicate Open activates the existing document without reset',async()=>{
  const {workspace:w,bridge,stage,first}=await setup();await act(async()=>{await current(w).controller.edit(note);});const original=current(w).controller.getState();vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'candidate',candidate:stage(blankProject(),'opened')});fireEvent.click(screen.getByRole('button',{name:'Open probe'}));await waitFor(()=>expect(w.getState().documents).toHaveLength(2));expect(current(w).id).not.toBe(first);expect(w.getState().documents[0].controller.getState()).toBe(original);
  vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'existing',documentId:first});fireEvent.click(screen.getByRole('button',{name:'Open probe'}));await waitFor(()=>expect(w.getState().active.documentId).toBe(first));expect(w.getState().documents).toHaveLength(2);expect(props().controller.getState()).toBe(original);expect(bridge.addDocument).toHaveBeenCalledOnce();
});

function fileButton(name:string){
  const summary=screen.queryByText('File',{selector:'summary'});if(summary&&!summary.closest('details')!.open)fireEvent.click(summary);
  return screen.getByRole('button',{name});
}

function closeSession(f:ReturnType<typeof fixture>):NativeSessionBridge {
  let lifecycle:'running'|'clean'='running';
  const session:NativeSessionBridge={startup:vi.fn(async()=>({preferences:{version:1 as const,restorePreviousSession:true},preview:null})),
    resolve:vi.fn(async()=>({workspace:f.snapshot(),views:{},issues:[]})),setView:vi.fn(async()=>{}),
    setPreferences:vi.fn(async (restorePreviousSession:boolean)=>({version:1 as const,restorePreviousSession})),
    status:vi.fn(async()=>({state:'ready' as const,capturedAtUnixMs:1792050000000,generation:1,error:null})),
    retry:vi.fn(async()=>({state:'ready' as const,capturedAtUnixMs:1792050000000,generation:2,error:null})),
    shutdown:vi.fn(async documents=>{expect(documents).toHaveLength(f.records.size);for(const entry of documents){const record=f.records.get(entry.documentId)!;expect(entry.revision).toBe(record.revision);expect(entry.discard).toBe(record.snapshot.dirty);}lifecycle='clean';}),
    resume:vi.fn(async()=>{lifecycle='running';})};
  const snapshot=vi.mocked(f.bridge.snapshot).getMockImplementation()!;vi.mocked(f.bridge.snapshot).mockImplementation(async()=>{expect(lifecycle).toBe('running');return snapshot();});
  vi.doMock('./session-bridge',()=>({nativeSessionBridge:session}));vi.doMock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));return session;
}

it.each(['cancel','native-failure','success'] as const)('native close bootstrap prevents default, uses workspace decisions and destroys only after %s',async result=>{
  const f=fixture(),session=closeSession(f),workspace=await WorkspaceController.create(f.bridge);workspace.setSessionBridge(session);await current(workspace).controller.edit(note);const decision=deferred<'discard'|'cancel'>();vi.mocked(mocks.bridges.get(f.first)!.askUnsaved).mockReturnValueOnce(decision.promise);if(result==='native-failure')vi.mocked(session.shutdown).mockRejectedValueOnce(new Error('native close rejected'));
  type CloseEvent={preventDefault:()=>void};let onClose!: (event:CloseEvent)=>Promise<void>;const destroy=vi.fn(async()=>{}),rootRender=vi.fn(),request=vi.spyOn(workspace,'requestWindowClose');
  vi.resetModules();vi.doMock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:vi.fn(async(callback:typeof onClose)=>{onClose=callback;return()=>{};}),destroy})}));
  vi.doMock('react-dom/client',()=>({createRoot:vi.fn(()=>({render:rootRender}))}));vi.doMock('./WorkspaceController',()=>({WorkspaceController:{create:vi.fn(async()=>workspace)}}));vi.doMock('../bridge',()=>({nativeWorkspaceBridge:f.bridge,createDocumentBridge:(id:string)=>mocks.bridges.get(id)!}));
  const root=document.createElement('div');root.id='root';document.body.append(root);
  try{
    await import('../main');await waitFor(()=>expect(rootRender.mock.calls.at(-1)?.[0].props.workspace).toBe(workspace));expect((await import('react-dom/client')).createRoot).toHaveBeenCalledOnce();
    const event={preventDefault:vi.fn()},closing=onClose(event);expect(event.preventDefault).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(1);expect(destroy).not.toHaveBeenCalled();expect(f.bridge.closeDocuments).not.toHaveBeenCalled();
    await waitFor(()=>expect(mocks.bridges.get(f.first)!.askUnsaved).toHaveBeenCalledOnce());const repeated={preventDefault:vi.fn()};await onClose(repeated);expect(repeated.preventDefault).toHaveBeenCalledTimes(1);expect(destroy).not.toHaveBeenCalled();expect(mocks.bridges.get(f.first)!.askUnsaved).toHaveBeenCalledTimes(1);
    decision.resolve(result==='cancel'?'cancel':'discard');await closing;expect(destroy).toHaveBeenCalledTimes(result==='success'?1:0);expect(rootRender).toHaveBeenCalled();expect(workspace.getState().documents[0].id).toBe(f.first);expect(workspace.getState().busy).toBe(result==='success');
  }finally{root.remove();vi.doUnmock('./session-bridge');vi.doUnmock('@tauri-apps/api/event');vi.doUnmock('@tauri-apps/api/window');vi.doUnmock('react-dom/client');vi.doUnmock('./WorkspaceController');vi.doUnmock('../bridge');vi.resetModules();}
});

it('native close ignores a second request while successful window destruction is pending',async()=>{
  const f=fixture(),session=closeSession(f),workspace=await WorkspaceController.create(f.bridge),destruction=deferred<void>();workspace.setSessionBridge(session);
  type CloseEvent={preventDefault:()=>void};let onClose!:(event:CloseEvent)=>Promise<void>;
  const destroy=vi.fn(()=>destruction.promise),request=vi.spyOn(workspace,'requestWindowClose'),rootRender=vi.fn();
  vi.resetModules();vi.doMock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:vi.fn(async(callback:typeof onClose)=>{onClose=callback;return()=>{};}),destroy})}));
  vi.doMock('react-dom/client',()=>({createRoot:vi.fn(()=>({render:rootRender}))}));vi.doMock('./WorkspaceController',()=>({WorkspaceController:{create:vi.fn(async()=>workspace)}}));vi.doMock('../bridge',()=>({nativeWorkspaceBridge:f.bridge,createDocumentBridge:(id:string)=>mocks.bridges.get(id)!}));
  const root=document.createElement('div');root.id='root';document.body.append(root);let closing:Promise<void>|undefined,repeated:Promise<void>|undefined;
  try{
    await import('../main');await waitFor(()=>expect(rootRender.mock.calls.at(-1)?.[0].props.workspace).toBe(workspace));expect((await import('react-dom/client')).createRoot).toHaveBeenCalledOnce();
    const first={preventDefault:vi.fn()};closing=onClose(first);await waitFor(()=>expect(destroy).toHaveBeenCalledTimes(1));expect(first.preventDefault).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(1);expect(session.shutdown).toHaveBeenCalledTimes(1);expect(f.bridge.closeDocuments).not.toHaveBeenCalled();
    const replacement=workspace.getState().active,second={preventDefault:vi.fn()};repeated=onClose(second);expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);expect(session.shutdown).toHaveBeenCalledTimes(1);expect(f.bridge.closeDocuments).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledTimes(1);expect(workspace.getState().active).toBe(replacement);expect(rootRender).toHaveBeenCalled();
    destruction.resolve();await Promise.all([closing,repeated]);expect(destroy).toHaveBeenCalledTimes(1);
  }finally{destruction.resolve();await Promise.all([closing,repeated]);root.remove();vi.doUnmock('./session-bridge');vi.doUnmock('@tauri-apps/api/event');vi.doUnmock('@tauri-apps/api/window');vi.doUnmock('react-dom/client');vi.doUnmock('./WorkspaceController');vi.doUnmock('../bridge');vi.resetModules();}
});


it.each(['success','destroy-failure','resync-failure','resume-failure','cancel','native-failure'] as const)('mounted native window close keeps the existing editor reserved until destruction: %s',async result=>{
  const f=fixture(),session=closeSession(f),workspace=await WorkspaceController.create(f.bridge),original=workspace.getState().active,destruction=deferred<void>(),refresh=deferred<WorkspaceSnapshot>(),resuming=deferred<void>();workspace.setSessionBridge(session);
  if(result==='cancel'){await current(workspace).controller.edit(note);vi.mocked(mocks.bridges.get(f.first)!.askUnsaved).mockResolvedValueOnce('cancel');}
  if(result==='native-failure')vi.mocked(session.shutdown).mockRejectedValueOnce(new Error('native close rejected'));
  type CloseEvent={preventDefault:()=>void};let onClose!:(event:CloseEvent)=>Promise<void>,reactRoot:Root|undefined;
  const destroy=vi.fn(()=>destruction.promise);
  vi.resetModules();vi.doMock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:vi.fn(async(callback:typeof onClose)=>{onClose=callback;return()=>{};}),destroy})}));
  vi.doMock('react-dom/client',async()=>{const actual=await vi.importActual<typeof import('react-dom/client')>('react-dom/client');return {...actual,createRoot:(container:Element)=>{reactRoot=actual.createRoot(container);return reactRoot;}};});
  vi.doMock('./WorkspaceController',()=>({WorkspaceController:{create:vi.fn(async()=>workspace)}}));vi.doMock('../bridge',()=>({nativeWorkspaceBridge:f.bridge,createDocumentBridge:(id:string)=>mocks.bridges.get(id)!}));
  vi.doMock('../App',()=>vi.importActual('../App'));vi.doMock('../ScoreView',()=>({ScoreView:()=>null}));
  const root=document.createElement('div');root.id='root';document.body.append(root);let closing:Promise<void>|undefined;
  try{
    await act(async()=>{await import('../main');});await waitFor(()=>expect(onClose).toBeTypeOf('function'));
    const editor=root.querySelector('.app-shell'),audio=mocks.audio.get(original.activationId)!;expect(editor).not.toBeNull();await waitFor(()=>expect(audio.prepare).toHaveBeenCalledOnce());expect(audio.subscribe).toHaveBeenCalledOnce();
    await act(async()=>{closing=onClose({preventDefault:vi.fn()});});
    if(result==='cancel'||result==='native-failure'){
      await closing;expect(destroy).not.toHaveBeenCalled();expect(workspace.getState().active).toBe(original);expect(root.querySelector('.app-shell')).toBe(editor);expect(workspace.getState().busy).toBe(false);expect(fileButton('New')).toBeEnabled();
      await act(async()=>{await current(workspace).controller.edit({...note,fret:9});});expect(current(workspace).controller.getState().snapshot.project.edits.at(-1)).toEqual({...note,fret:9});return;
    }
    await waitFor(()=>expect(destroy).toHaveBeenCalledOnce());expect(f.snapshot().active.documentId).toBe(f.first);
    expect.soft(root.querySelector('.app-shell')===editor).toBe(true);expect.soft(mocks.audio.size).toBe(1);expect.soft(audio.subscribe).toHaveBeenCalledOnce();expect.soft(audio.prepare).toHaveBeenCalledOnce();expect.soft(workspace.getState().active).toBe(original);expect.soft(workspace.getState().busy).toBe(true);
    for(const name of ['New','Open','Close score','Close all scores'])expect.soft(fileButton(name)).toBeDisabled();
    await act(async()=>{await expect(workspace.newDocument()).rejects.toThrow(/transition/i);await expect(workspace.openDocument()).rejects.toThrow(/transition/i);await expect(workspace.activate(f.first)).rejects.toThrow(/transition/i);expect(await workspace.closeAll()).toBe(false);await expect(current(workspace).controller.edit(note)).rejects.toThrow(/transition/i);await onClose({preventDefault:vi.fn()});});
    expect(f.bridge.createBlankDocument).not.toHaveBeenCalled();expect(f.bridge.readDocument).not.toHaveBeenCalled();expect(session.shutdown).toHaveBeenCalledOnce();expect(f.bridge.closeDocuments).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce();
    if(result==='success'){
      await act(async()=>{destruction.resolve();await closing;});expect(workspace.getState().busy).toBe(true);expect(root.querySelector('.app-shell')).toBe(editor);expect(mocks.audio.size).toBe(1);return;
    }
    const snapshots=vi.mocked(f.bridge.snapshot).mock.calls.length;
    const resume=vi.mocked(session.resume).getMockImplementation()!;vi.mocked(session.resume).mockImplementationOnce(()=>resuming.promise.then(resume));
    vi.mocked(f.bridge.snapshot).mockReturnValueOnce(refresh.promise);
    await act(async()=>{destruction.reject(new Error('window destruction failed'));});await waitFor(()=>expect(session.resume).toHaveBeenCalledOnce());
    expect(f.bridge.snapshot).toHaveBeenCalledTimes(snapshots);expect(workspace.getState().busy).toBe(true);expect(root.querySelector('.app-shell')).toBe(editor);expect(mocks.audio.size).toBe(1);expect(fileButton('New')).toBeDisabled();
    if(result==='resume-failure'){
      await act(async()=>{resuming.reject(new Error('Running manifest write failed'));await closing;});expect(f.bridge.snapshot).toHaveBeenCalledTimes(snapshots);expect(workspace.getState().busy).toBe(true);expect(root.querySelector('.app-shell')).toBe(editor);expect(mocks.audio.size).toBe(1);expect(screen.getByRole('alert')).toHaveTextContent('Running manifest write failed');expect(fileButton('New')).toBeDisabled();return;
    }
    await act(async()=>resuming.resolve());await waitFor(()=>expect(f.bridge.snapshot).toHaveBeenCalledTimes(snapshots+1));
    expect(workspace.getState().busy).toBe(true);expect(root.querySelector('.app-shell')).toBe(editor);expect(mocks.audio.size).toBe(1);expect(fileButton('New')).toBeDisabled();
    if(result==='resync-failure'){
      await act(async()=>{refresh.reject(new Error('workspace refresh failed'));await closing;});expect(workspace.getState().busy).toBe(true);expect(root.querySelector('.app-shell')).toBe(editor);expect(mocks.audio.size).toBe(1);expect(screen.getByRole('alert')).toHaveTextContent('window destruction failed');expect(screen.getByRole('alert')).toHaveTextContent('workspace refresh failed');return;
    }
    await act(async()=>{refresh.resolve(f.snapshot());await closing;});expect(workspace.getState().active).toEqual(f.snapshot().active);expect(root.querySelector('.app-shell')).toBe(editor);expect(workspace.getState().busy).toBe(false);expect(mocks.audio.size).toBe(1);expect(screen.getByRole('alert')).toHaveTextContent('window destruction failed');expect(fileButton('New')).toBeEnabled();await waitFor(()=>expect(mocks.audio.get(workspace.getState().active.activationId)!.prepare).toHaveBeenCalledOnce());
    await act(async()=>{await current(workspace).controller.edit({...note,fret:9});});expect(current(workspace).controller.getState().snapshot.project.edits.at(-1)).toEqual({...note,fret:9});
  }finally{
    destruction.resolve();resuming.resolve();refresh.resolve(f.snapshot());await closing?.catch(()=>{});await act(async()=>{reactRoot?.unmount();});root.remove();vi.doUnmock('./session-bridge');vi.doUnmock('@tauri-apps/api/event');vi.doUnmock('@tauri-apps/api/window');vi.doUnmock('react-dom/client');vi.doUnmock('./WorkspaceController');vi.doUnmock('../bridge');vi.doUnmock('../App');vi.doUnmock('../ScoreView');vi.resetModules();
  }
});
