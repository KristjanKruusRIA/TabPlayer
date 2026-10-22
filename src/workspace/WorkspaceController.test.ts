import { beforeEach,expect,it,vi } from 'vitest';
import { blankProject,type EditCommand,type Project,type DocumentCandidate } from '../project';
import type { NativeBridge } from '../bridge';
import type { CloseDocument,DocumentSnapshot,NativeWorkspaceBridge,WorkspaceSnapshot } from './types';
import type { NativeSessionBridge } from './recovery-types';
import type { SyncAnchor } from '../edit-types';
import { WorkspaceController } from './WorkspaceController';
import { initialDocumentView } from './view-state';
import { forgetSessionViewDefaults,writeViewDefaults } from './view-defaults';

const mocks=vi.hoisted(()=>({bridges:new Map<string,NativeBridge>()}));
vi.mock('../bridge',()=>({createDocumentBridge:(id:string)=>{const bridge=mocks.bridges.get(id);if(!bridge)throw new Error('Missing addressed bridge');return bridge;}}));
beforeEach(()=>mocks.bridges.clear());
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const note:Extract<EditCommand,{type:'setNote'}>={type:'setNote',target,string:6,fret:7};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function fixture(){
  let next=0,activation=0,active={documentId:'',activationId:''};
  const records=new Map<string,DocumentSnapshot>(),redo=new Map<string,EditCommand[]>(),staged=new Map<string,DocumentCandidate>();
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()].map(r=>structuredClone(r)),active:{...active}});
  const activate=(id:string)=>{if(!records.has(id))throw new Error('Closed document');if(active.documentId!==id)active={documentId:id,activationId:`activation-${++activation}`};return snapshot();};
  const add=(project=blankProject(),path:string|null=null)=>{
    const documentId=`document-${++next}`;let record:DocumentSnapshot={documentId,revision:0,snapshot:{project,canUndo:project.edits.length>0,canRedo:false,dirty:false,path}};
    records.set(documentId,record);redo.set(documentId,[]);
    const update=(project:Project,dirty=true)=>{record={...record,revision:record.revision+1,snapshot:{...record.snapshot,project,dirty,canUndo:project.edits.length>0,canRedo:redo.get(documentId)!.length>0,redoEdit:redo.get(documentId)!.at(-1)??null}};records.set(documentId,record);return structuredClone(record);};
    const check=(revision:number)=>{if(!records.has(documentId)||revision!==record.revision)throw new Error('Invalid addressed revision');};
    const bridge:NativeBridge={documentId,snapshot:vi.fn(async()=>structuredClone(record)),cancelAsset:vi.fn(async()=>true),
      readBackingAsset:async(_assetId:string,_revision:number):Promise<Uint8Array>=>{throw new Error('Backing asset reads are not implemented.');},
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
async function setup(){const f=fixture();const workspace=await WorkspaceController.create(f.bridge);return {...f,workspace};}
const current=(w:WorkspaceController)=>w.getState().documents.find(d=>d.id===w.getState().active.documentId)!;
function preserve(w:WorkspaceController){const entry=current(w),state=entry.controller.getState(),owner=w.getState().active,beforeChange=vi.fn();entry.controller.setBeforeChange(beforeChange);return ()=>{expect(current(w).controller).toBe(entry.controller);expect(entry.controller.getState().snapshot).toBe(state.snapshot);expect(entry.controller.getState().score).toBe(state.score);expect(entry.controller.getState().settings).toBe(state.settings);expect(w.getState().active).toEqual(owner);expect(beforeChange).not.toHaveBeenCalled();};}

it('new_open_and_duplicates_never_replace_dirty_tabs',async()=>{
  const {workspace:w,bridge,first}=await setup();const a=current(w).controller;await a.edit(note);await a.undo();const history=a.getState();
  await w.newDocument();const b=current(w).controller;await b.edit({...note,fret:11});await w.activate(first);
  expect(current(w).controller).toBe(a);expect(a.getState()).toBe(history);await a.redo();expect(a.getState().snapshot.project.edits).toEqual([note]);expect(b.getState().snapshot.project.edits).toEqual([{...note,fret:11}]);
  vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'existing',documentId:first});const addCalls=vi.mocked(bridge.addDocument).mock.calls.length;
  await w.openDocument();expect(current(w).controller).toBe(a);expect(bridge.addDocument).toHaveBeenCalledTimes(addCalls);expect(mocks.bridges.get(first)!.askUnsaved).not.toHaveBeenCalled();expect(mocks.bridges.get(first)!.snapshot).not.toHaveBeenCalled();
});
it.each(['newDocument','openDocument'] as const)('native %s rejection preserves playback, score, settings, snapshot and history',async operation=>{
  const {workspace:w,bridge,stage}=await setup();await current(w).controller.edit(note);await current(w).controller.undo();const unchanged=preserve(w);vi.mocked(bridge.readDocument).mockResolvedValue({kind:'candidate',candidate:stage()});vi.mocked(bridge.addDocument).mockRejectedValue(new Error('native commit rejected'));
  await expect(w[operation]()).rejects.toThrow('native commit rejected');unchanged();expect(bridge.cancelDocument).toHaveBeenCalledWith('candidate-token');
});
it('canceled Open and Save preserve the current document and audio owner',async()=>{
  const {workspace:w,bridge}=await setup();await current(w).controller.edit(note);const unchanged=preserve(w);expect(await w.openDocument()).toBe(false);vi.mocked(mocks.bridges.get(current(w).id)!.saveProject).mockResolvedValueOnce(null);expect(await current(w).controller.save(true)).toBe(false);unchanged();expect(bridge.addDocument).not.toHaveBeenCalled();expect(bridge.cancelDocument).not.toHaveBeenCalled();
});
it('validates a staged blank candidate before committing exactly its token',async()=>{
  const {workspace:w,bridge,stage}=await setup();vi.mocked(bridge.createBlankDocument).mockResolvedValueOnce(stage(blankProject(),'exact-blank'));await w.newDocument();expect(bridge.createBlankDocument).toHaveBeenCalledOnce();expect(bridge.addDocument).toHaveBeenCalledWith('exact-blank');expect(w.getState().documents).toHaveLength(2);
});
it.each(['newDocument','openDocument'] as const)('rejects malformed replay in %s before native publication and cancels only its token',async operation=>{
  const {workspace:w,bridge,stage,staged}=await setup();const candidate=stage({...blankProject(),edits:[{type:'setRest',target:{...target,bar:99}}]},'bad-token');stage(blankProject(),'unrelated');vi.mocked(bridge.createBlankDocument).mockResolvedValueOnce(candidate);vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'candidate',candidate});const unchanged=preserve(w);
  await expect(w[operation]()).rejects.toThrow();unchanged();expect(bridge.addDocument).not.toHaveBeenCalled();expect(bridge.cancelDocument).toHaveBeenCalledExactlyOnceWith('bad-token');expect(staged.has('unrelated')).toBe(true);
});
it.each(['newDocument','openDocument'] as const)('does not cancel a successfully committed %s candidate',async operation=>{
  const {workspace:w,bridge,stage}=await setup();vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'candidate',candidate:stage()});await w[operation]();expect(bridge.cancelDocument).not.toHaveBeenCalled();
});
it('preserves primary intake error and visible history when token cleanup also fails',async()=>{
  const {workspace:w,bridge}=await setup();const primary=new Error('document commit failed');vi.mocked(bridge.addDocument).mockRejectedValueOnce(primary);vi.mocked(bridge.cancelDocument).mockRejectedValueOnce(new Error('cleanup failed'));const unchanged=preserve(w);await expect(w.newDocument()).rejects.toBe(primary);unchanged();expect(w.getState().error).toBe(primary.message);expect(bridge.cancelDocument).toHaveBeenCalledWith('candidate-token');expect(w.getState().busy).toBe(false);
});
const assetId='c'.repeat(64),backingEdit=(anchors:SyncAnchor[]):EditCommand=>({type:'setBacking',backing:{assetId,offsetMs:0,anchors,mix:{gain:1,pan:0,mute:false,solo:false}}});
const repeatStart:Extract<EditCommand,{type:'setMeasureSettings'}>={type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:0,endings:[],section:'',tempos:[]};
const repeatEnd={...repeatStart,bar:1,repeatStart:false,repeatCount:2};
it.each([
  {reason:'missing repeat occurrence',edits:[backingEdit([{bar:0,occurrence:999,ratio:0,audioMs:0}])]},
  {reason:'backwards mapped audio time',edits:[backingEdit([{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:0}])]},
  {reason:'aliased bar-boundary positions',edits:[backingEdit([{bar:0,occurrence:0,ratio:1,audioMs:0},{bar:1,occurrence:0,ratio:0,audioMs:1000}])]},
  {reason:'removed repeat occurrence',edits:[repeatStart,repeatEnd,backingEdit([{bar:1,occurrence:1,ratio:.5,audioMs:6500}]),{...repeatEnd,repeatCount:0}]},
])('invalid staged backing with $reason preserves document/audio/settings/history and cancels token',async({edits})=>{
  const {workspace:w,bridge,stage}=await setup();const candidate=stage({...blankProject(),assets:{[assetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}},edits},'invalid-backing');vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'candidate',candidate});const unchanged=preserve(w);await expect(w.openDocument()).rejects.toThrow(/anchor|backing|occurrence/i);unchanged();expect(bridge.addDocument).not.toHaveBeenCalled();expect(bridge.cancelDocument).toHaveBeenCalledExactlyOnceWith('invalid-backing');
});
it('successful New/Open including identical blanks changes playback session, edits and failed intake retain it',async()=>{
  const {workspace:w,bridge,stage}=await setup();const identities=[w.getState().active];await current(w).controller.edit(note);expect(w.getState().active).toBe(identities[0]);
  for(const operation of ['newDocument','newDocument','openDocument'] as const){if(operation==='openDocument')vi.mocked(bridge.readDocument).mockResolvedValueOnce({kind:'candidate',candidate:stage()});await w[operation]();identities.push(w.getState().active);}
  expect(new Set(identities.map(i=>i.documentId)).size).toBe(4);expect(new Set(identities.map(i=>i.activationId)).size).toBe(4);const unchanged=preserve(w);vi.mocked(bridge.addDocument).mockRejectedValueOnce(new Error('replacement failed'));await expect(w.newDocument()).rejects.toThrow('replacement failed');unchanged();
});

async function twoDirty(){const f=await setup(),a=current(f.workspace);await a.controller.edit(note);await f.workspace.newDocument();const b=current(f.workspace);await b.controller.edit({...note,fret:11});return {...f,a,b};}
it.each(['cancel','save-cancel','native-failure'] as const)('close_all_stages_discards_until_every_decision_succeeds: %s',async failure=>{
  const {workspace:w,bridge,a,b,stage,staged}=await twoDirty();await a.controller.edit({...note,fret:12});await a.controller.undo();expect(a.controller.getState().snapshot.canRedo).toBe(true);w.setView(a.id,{...initialDocumentView(),zoom:150,instrumentVisible:true});stage(blankProject(),'unrelated');
  const before=w.getState().documents.map(d=>({controller:d.controller,state:d.controller.getState(),view:d.view})),owner=w.getState().active;
  if(failure==='cancel')vi.mocked(mocks.bridges.get(b.id)!.askUnsaved).mockResolvedValueOnce('cancel');
  if(failure==='save-cancel'){vi.mocked(mocks.bridges.get(b.id)!.askUnsaved).mockResolvedValueOnce('save');vi.mocked(mocks.bridges.get(b.id)!.saveProject).mockResolvedValueOnce(null);}
  if(failure==='native-failure')vi.mocked(bridge.closeDocuments).mockRejectedValueOnce(new Error('close rejected'));
  if(failure==='native-failure')await expect(w.closeAll()).rejects.toThrow('close rejected');else expect(await w.closeAll()).toBe(false);
  expect(w.getState().documents).toHaveLength(2);expect(w.getState().active).toEqual(owner);for(const d of before){expect(d.controller.getState().snapshot).toBe(d.state.snapshot);expect(w.getState().documents.find(e=>e.controller===d.controller)!.view).toEqual(d.view);}expect(staged.has('unrelated')).toBe(true);if(failure!=='native-failure')expect(bridge.closeDocuments).not.toHaveBeenCalled();await a.controller.redo();expect(a.controller.getState().snapshot.project.edits.at(-1)).toEqual({...note,fret:12});
});
it('an earlier successful Save remains saved when a later close prompt cancels',async()=>{
  const {workspace:w,bridge,a,b}=await twoDirty();vi.mocked(mocks.bridges.get(a.id)!.askUnsaved).mockResolvedValueOnce('save');vi.mocked(mocks.bridges.get(b.id)!.askUnsaved).mockResolvedValueOnce('cancel');expect(await w.closeAll()).toBe(false);expect(a.controller.getState().snapshot.dirty).toBe(false);expect(b.controller.getState().snapshot.dirty).toBe(true);expect(w.getState().documents).toHaveLength(2);expect(bridge.closeDocuments).not.toHaveBeenCalled();
});
it('sends one exact atomic close list with post-save revisions/discard flags and adopts native blank',async()=>{
  const {workspace:w,bridge,a,b}=await twoDirty(),session=sessionFixture();w.setSessionBridge(session);vi.mocked(mocks.bridges.get(a.id)!.askUnsaved).mockResolvedValueOnce('save');expect(await w.closeAll()).toBe(true);expect(bridge.closeDocuments).toHaveBeenCalledExactlyOnceWith([{documentId:a.id,revision:2,discard:false},{documentId:b.id,revision:1,discard:true}] satisfies CloseDocument[]);expect(session.shutdown).not.toHaveBeenCalled();expect(w.getState().documents).toHaveLength(1);expect(current(w).controller.getState().snapshot.dirty).toBe(false);expect(current(w).id).not.toBe(a.id);expect(current(w).id).not.toBe(b.id);
});
it('closing an inactive tab preserves active owner and last close creates a new blank',async()=>{
  const {workspace:w,first}=await setup();await w.newDocument();const owner=w.getState().active;await w.close(first);expect(w.getState().active).toEqual(owner);await w.close(owner.documentId);expect(w.getState().documents).toHaveLength(1);expect(w.getState().active.documentId).not.toBe(owner.documentId);
});
it('busy_reservation_covers_queued_work_dialog_and_late_job',async()=>{
  const {workspace:w,bridge,first}=await setup();const pending=current(w).controller.edit(note);expect(current(w).controller.hasPendingActions()).toBe(true);await expect(w.newDocument()).rejects.toThrow(/wait|finish|pending/i);await pending;
  const dialog=deferred<DocumentCandidate>();vi.mocked(bridge.createBlankDocument).mockReturnValueOnce(dialog.promise);const adding=w.newDocument();expect(w.getState().busy).toBe(true);await expect(current(w).controller.edit(note)).rejects.toThrow(/transition/i);expect(await w.requestWindowClose()).toBe(false);dialog.resolve({project:blankProject(),path:null,token:'unused'});await expect(adding).rejects.toThrow('Missing token');expect(w.getState().busy).toBe(false);
  const release=w.beginEditorOperation(first);expect(w.getState().busy).toBe(true);expect(()=>w.beginEditorOperation(first)).toThrow();await expect(w.newDocument()).rejects.toThrow();await expect(w.openDocument()).rejects.toThrow();await expect(w.activate(first)).rejects.toThrow();expect(await w.close(first)).toBe(false);expect(await w.closeAll()).toBe(false);expect(await w.requestWindowClose()).toBe(false);expect(w.getState().error).toBe('Finish or cancel the current operation before closing.');await current(w).controller.edit({...note,fret:9});release();release();expect(w.getState().busy).toBe(false);
});
it('requires active lease origin and a released late origin never edits a replacement blank',async()=>{
  const {workspace:w,first}=await setup();const old=current(w).controller;await w.newDocument();expect(()=>w.beginEditorOperation(first)).toThrow(/active/i);await w.close(first);const before=current(w).controller.getState();await expect(old.edit(note)).rejects.toThrow();expect(current(w).controller.getState()).toBe(before);
});
it('prevents reentrant close prompts while requestClose saves inside its own transition',async()=>{
  const {workspace:w,bridge,a}=await twoDirty(),decision=deferred<'discard'>();vi.mocked(mocks.bridges.get(a.id)!.askUnsaved).mockReturnValueOnce(decision.promise);const closing=w.closeAll();expect(w.getState().busy).toBe(true);expect(await w.closeAll()).toBe(false);expect(await w.requestWindowClose()).toBe(false);expect(mocks.bridges.get(a.id)!.askUnsaved).toHaveBeenCalledOnce();decision.resolve('discard');expect(await closing).toBe(true);expect(bridge.closeDocuments).toHaveBeenCalledOnce();
});
it('view_and_clipboard_have_correct_scope and controller updates notify workspace immutably',async()=>{
  const {workspace:w,first}=await setup();const updates=vi.fn(),unsubscribe=w.subscribe(updates);const a=current(w),initial=w.getState();w.setView(first,{...initialDocumentView(),zoom:125,instrumentVisible:true,target:{...target,bar:1}});expect(w.getState()).not.toBe(initial);expect(initial.documents[0].view.zoom).toBe(100);await a.controller.edit(note);expect(updates).toHaveBeenCalled();const savedView=w.getState().documents[0].view;
  w.clipboard.set(await a.controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack'));await w.newDocument();const b=current(w);expect(b.view).toEqual(initialDocumentView());await b.controller.edit({type:'pasteMusic',clip:w.clipboard.get()!,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}});expect(b.controller.getState().snapshot.project.edits).toHaveLength(1);expect(b.controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(7);await b.controller.undo();expect(a.controller.getState().snapshot.project.edits).toEqual([note]);await w.activate(first);expect(current(w).view).toEqual(savedView);unsubscribe();
});

it('window close returns false on a failed save or shutdown and retains all documents',async()=>{
  const {workspace:w,bridge,a}=await twoDirty(),session=sessionFixture();w.setSessionBridge(session);vi.mocked(mocks.bridges.get(a.id)!.askUnsaved).mockResolvedValueOnce('save');vi.mocked(mocks.bridges.get(a.id)!.saveProject).mockRejectedValueOnce(new Error('disk unavailable'));
  expect(await w.requestWindowClose()).toBe(false);expect(w.getState().error).toBe('disk unavailable');expect(w.getState().documents).toHaveLength(2);expect(bridge.closeDocuments).not.toHaveBeenCalled();
  vi.mocked(session.shutdown).mockRejectedValueOnce(new Error('native shutdown unavailable'));expect(await w.requestWindowClose()).toBe(false);expect(w.getState().error).toBe('native shutdown unavailable');expect(w.getState().documents).toHaveLength(2);expect(bridge.closeDocuments).not.toHaveBeenCalled();
});

it('holds the external lease through addressed backing commit and releases only once',async()=>{
  const {workspace:w,first}=await setup(),entry=current(w),asset={token:'asset-token',assetId,info:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}},command=backingEdit([]);
  const release=w.beginEditorOperation(first),native=mocks.bridges.get(first)!;
  vi.mocked(native.applyEdit).mockResolvedValueOnce({documentId:first,revision:1,snapshot:{project:{...blankProject(),assets:{[assetId]:asset.info},edits:[command]},canUndo:true,canRedo:false,dirty:true,path:null}});
  await entry.controller.edit(command,asset);expect(native.applyEdit).toHaveBeenCalledExactlyOnceWith(command,0,'asset-token');expect(entry.controller.getState().settings.backing?.assetId).toBe(assetId);expect(w.getState().busy).toBe(true);await expect(w.openDocument()).rejects.toThrow();expect(native.cancelAsset).not.toHaveBeenCalled();release();const state=w.getState();release();expect(w.getState()).toBe(state);expect(state.busy).toBe(false);
});
it('retains native activation identity for same tab and changes it across A to B to A',async()=>{
  const {workspace:w,bridge,first}=await setup(),owner=w.getState().active;await w.activate(first);expect(w.getState().active).toBe(owner);expect(bridge.activateDocument).not.toHaveBeenCalled();await w.newDocument();await w.activate(first);expect(w.getState().active.documentId).toBe(first);expect(w.getState().active.activationId).not.toBe(owner.activationId);
});
it('pending actions synchronously block close, external lease and switching until idle',async()=>{
  const {workspace:w,bridge,first}=await setup(),controller=current(w).controller;const edit=controller.edit(note);expect(await w.closeAll()).toBe(false);expect(()=>w.beginEditorOperation(first)).toThrow(/pending/i);await expect(w.activate(first)).rejects.toThrow(/pending/i);expect(bridge.closeDocuments).not.toHaveBeenCalled();await edit;await controller.whenIdle();const release=w.beginEditorOperation(first);release();
});
it('repairs per-document view after edits without storing drafts or creating extra history',async()=>{
  const {workspace:w,first}=await setup(),a=current(w);await a.controller.edit({type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  w.setView(first,{...initialDocumentView(),target:{...target,track:1,bar:2,beat:1},selectedString:5,selectedNoteIndex:0,zoom:300,trackView:{kind:'custom',trackIds:['base/0','missing']},instrumentVisible:true});const history=a.controller.getState().snapshot.project.edits;
  expect(a.controller.getState().snapshot.project.edits).toBe(history);expect(current(w).view.selectedString).toBe(4);await w.newDocument();expect(current(w).view).toEqual(initialDocumentView());await w.activate(first);expect(current(w).view.target).toEqual({...target,track:1,bar:2,beat:1});await a.controller.edit({type:'removeTrack',track:1});expect(current(w).view.target.track).toBe(0);expect(current(w).view.zoom).toBe(300);expect(current(w).view.instrumentVisible).toBe(true);expect(a.controller.getState().snapshot.project.edits).toHaveLength(2);
});

function sessionFixture():NativeSessionBridge {
  return {startup:vi.fn(async()=>({preferences:{version:1 as const,restorePreviousSession:true},preview:null})),
    resolve:vi.fn(async()=>{throw new Error('Startup belongs to bootstrap');}),setView:vi.fn(async()=>{}),
    setPreferences:vi.fn(async(restorePreviousSession:boolean)=>({version:1 as const,restorePreviousSession})),
    status:vi.fn(async()=>({state:'idle' as const,capturedAtUnixMs:null,generation:null,error:null})),
    retry:vi.fn(async()=>({state:'ready' as const,capturedAtUnixMs:123,generation:1,error:null})),shutdown:vi.fn(async()=>{}),resume:vi.fn(async()=>{})};
}
async function sessionSetup(){const f=await setup(),session=sessionFixture();f.workspace.setSessionBridge(session);await f.workspace.flushViews();vi.mocked(session.setView).mockClear();return {...f,session};}

it('retains score display and manual zoom across activation and forwarded writes without music changes',async()=>{
  const {workspace:w,session,first}=await sessionSetup(),entry=current(w),controller=entry.controller;
  await controller.edit(note);await controller.undo();const before=controller.getState(),owner=w.getState().active;
  const view={...initialDocumentView(),zoom:137.5,scoreDisplay:{layout:'grid' as const,zoomMode:'fitPage' as const}};
  w.setView(first,view);await w.flushViews();
  expect(current(w).view).toEqual(view);expect(w.getState().active).toBe(owner);expect(controller.getState()).toBe(before);
  expect(session.setView).toHaveBeenLastCalledWith(first,view);
  await w.newDocument();expect(current(w).view).toEqual(initialDocumentView());await w.activate(first);
  expect(current(w).controller).toBe(controller);expect(current(w).view).toEqual(view);expect(controller.getState()).toBe(before);
  expect(controller.getState().snapshot.project).toBe(before.snapshot.project);
  expect(controller.getState().revision).toBe(before.revision);expect(controller.getState().snapshot.dirty).toBe(before.snapshot.dirty);
  expect(controller.getState().snapshot.canRedo).toBe(true);
  const addressed=mocks.bridges.get(first)!;
  expect(addressed.applyEdit).toHaveBeenCalledOnce();expect(addressed.undo).toHaveBeenCalledOnce();expect(addressed.redo).not.toHaveBeenCalled();
  await controller.redo();expect(controller.getState().snapshot.project.edits).toEqual([note]);
});

it('seeds resolved ordered records and repairs their views without rereading or editing music',async()=>{
  const f=fixture();await f.bridge.addDocument(f.stage().token);const initial=f.snapshot(),firstRecord=initial.documents[0];
  const w=await WorkspaceController.create(f.bridge,{workspace:initial,views:{[f.first]:{...initialDocumentView(),target:{track:99,staff:-1,bar:99,voice:NaN,beat:99},selectedString:99,selectedNoteIndex:0,zoom:25,trackView:{kind:'custom',trackIds:['gone']},instrumentVisible:true}}});
  expect(f.bridge.snapshot).not.toHaveBeenCalled();expect(w.getState().documents.map(d=>d.id)).toEqual(initial.documents.map(d=>d.documentId));
  expect(w.getState().active).toEqual(initial.active);expect(w.getState().documents[0].view).toEqual({target:{track:0,staff:0,bar:3,voice:0,beat:3},selectedString:6,selectedNoteIndex:null,zoom:25,trackView:{kind:'selected'},instrumentVisible:true});
  expect(w.getState().documents[1].view).toEqual(initialDocumentView());expect(w.getState().documents[0].controller.getState().snapshot).toBe(firstRecord.snapshot);expect(mocks.bridges.get(f.first)!.applyEdit).not.toHaveBeenCalled();
});
it('serializes one in-flight view and coalesces latest per document before switching',async()=>{
  const {workspace:w,session,bridge,first}=await sessionSetup();await w.newDocument();const second=current(w).id;await w.activate(first);await w.flushViews();vi.mocked(session.setView).mockClear();vi.mocked(bridge.activateDocument).mockClear();
  const sent=deferred<void>();vi.mocked(session.setView).mockReturnValueOnce(sent.promise);const before=current(w).controller.getState();
  w.setView(first,{...initialDocumentView(),zoom:125});await Promise.resolve();
  w.setView(first,{...initialDocumentView(),zoom:150});w.setView(first,{...initialDocumentView(),zoom:175});w.setView(second,{...initialDocumentView(),zoom:200});
  const switching=w.activate(second);w.setView(first,{...initialDocumentView(),zoom:250});await Promise.resolve();expect(w.getState().documents[0].view.zoom).toBe(175);expect(session.setView).toHaveBeenCalledTimes(1);expect(bridge.activateDocument).not.toHaveBeenCalled();expect(w.getState().active.documentId).toBe(first);
  sent.resolve();await switching;expect(vi.mocked(session.setView).mock.calls.map(([id,view])=>[id,view.zoom])).toEqual([[first,125],[first,175],[second,200]]);expect(current(w).view.zoom).toBe(200);expect(w.getState().documents[0].view.zoom).toBe(175);expect(w.getState().documents[0].controller.getState()).toBe(before);
});
it('view failure retains latest local location and retry flushes it before native checkpoint retry',async()=>{
  const {workspace:w,session,first}=await sessionSetup(),sent=deferred<void>(),before=current(w).controller.getState();
  vi.mocked(session.setView).mockReturnValueOnce(sent.promise);w.setView(first,{...initialDocumentView(),zoom:125});await Promise.resolve();w.setView(first,{...initialDocumentView(),zoom:175});
  const flushing=w.flushViews();sent.reject(new Error('view unavailable'));await expect(flushing).rejects.toThrow('view unavailable');
  expect(current(w).view.zoom).toBe(175);expect(current(w).controller.getState()).toBe(before);expect(w.getState().recoveryError).toBe('view unavailable');expect(w.getState().error).toBeNull();
  const retrySend=deferred<void>();vi.mocked(session.setView).mockReturnValueOnce(retrySend.promise);const retry=w.retryRecovery();await Promise.resolve();expect(session.retry).not.toHaveBeenCalled();expect(session.setView).toHaveBeenLastCalledWith(first,{...initialDocumentView(),zoom:175});retrySend.resolve();await expect(retry).resolves.toMatchObject({state:'ready'});expect(w.getState().recoveryError).toBeNull();expect(session.retry).toHaveBeenCalledOnce();
});
it('flush failure blocks tab retirement and cannot recreate a closed or unknown document',async()=>{
  const {workspace:w,session,bridge,first}=await sessionSetup();vi.mocked(session.setView).mockRejectedValueOnce(new Error('view unavailable'));w.setView(first,{...initialDocumentView(),zoom:150});await expect(w.close(first)).rejects.toThrow('view unavailable');expect(bridge.closeDocuments).not.toHaveBeenCalled();expect(current(w).view.zoom).toBe(150);
  await w.close(first);const next=current(w).id;expect(()=>w.setView(first,initialDocumentView())).toThrow(/open document/i);expect(()=>w.setView('unknown',initialDocumentView())).toThrow(/open document/i);await w.flushViews();expect(w.getState().documents.map(d=>d.id)).toEqual([next]);
});
it('window close without a session bridge fails before prompts or removal',async()=>{
  const {workspace:w,bridge}=await setup();await current(w).controller.edit(note);expect(await w.requestWindowClose()).toBe(false);expect(w.getState().error).toMatch(/session/i);expect(mocks.bridges.get(current(w).id)!.askUnsaved).not.toHaveBeenCalled();expect(bridge.closeDocuments).not.toHaveBeenCalled();expect(w.getState().busy).toBe(false);
});
it('window shutdown preserves tabs and sends all post-save revisions with explicit discards',async()=>{
  const {workspace:w,bridge,a,b}=await twoDirty(),session=sessionFixture();w.setSessionBridge(session);await w.flushViews();vi.mocked(mocks.bridges.get(a.id)!.askUnsaved).mockResolvedValueOnce('save');const documents=w.getState().documents,owner=w.getState().active;
  expect(await w.requestWindowClose()).toBe(true);expect(session.shutdown).toHaveBeenCalledExactlyOnceWith([{documentId:a.id,revision:2,discard:false},{documentId:b.id,revision:1,discard:true}]);expect(bridge.closeDocuments).not.toHaveBeenCalled();expect(w.getState().documents.map(d=>d.controller)).toEqual(documents.map(d=>d.controller));expect(w.getState().active).toBe(owner);expect(w.getState().busy).toBe(true);await expect(current(w).controller.edit(note)).rejects.toThrow(/transition/i);
  w.setView(b.id,{...initialDocumentView(),zoom:200});expect(current(w).view.zoom).toBe(100);expect(await w.requestWindowClose()).toBe(false);
});
it('canceled decisions and failed view or shutdown preserve live tabs without a Clean acknowledgement',async()=>{
  const {workspace:w,bridge,a,b}=await twoDirty(),session=sessionFixture();w.setSessionBridge(session);await w.flushViews();const owner=w.getState().active;
  vi.mocked(mocks.bridges.get(b.id)!.askUnsaved).mockResolvedValueOnce('cancel');expect(await w.requestWindowClose()).toBe(false);expect(session.shutdown).not.toHaveBeenCalled();
  vi.mocked(session.setView).mockRejectedValueOnce(new Error('view unavailable'));w.setView(a.id,{...initialDocumentView(),zoom:150});expect(await w.requestWindowClose()).toBe(false);expect(session.shutdown).not.toHaveBeenCalled();expect(w.getState().recoveryError).toBe('view unavailable');
  vi.mocked(session.shutdown).mockRejectedValueOnce(new Error('clean write unavailable'));expect(await w.requestWindowClose()).toBe(false);expect(w.getState().error).toBe('clean write unavailable');expect(w.getState().busy).toBe(false);expect(w.getState().active).toEqual(owner);expect(w.getState().documents).toHaveLength(2);expect(bridge.closeDocuments).not.toHaveBeenCalled();
});
it('failed destruction keeps editing locked until Running resume and live snapshot both succeed',async()=>{
  const {workspace:w,session,bridge,first}=await sessionSetup();await current(w).controller.edit(note);const controller=current(w).controller;expect(await w.requestWindowClose()).toBe(true);
  vi.mocked(session.resume).mockRejectedValueOnce(new Error('resume unavailable'));await w.resumeAfterWindowCloseFailure(new Error('destroy failed'));expect(w.getState().busy).toBe(true);await expect(controller.edit(note)).rejects.toThrow(/transition/i);expect(w.getState().error).toMatch(/resume unavailable/);
  const resuming=deferred<void>();vi.mocked(session.resume).mockReturnValueOnce(resuming.promise);vi.mocked(bridge.snapshot).mockRejectedValueOnce(new Error('snapshot unavailable'));const pending=w.resumeAfterWindowCloseFailure(new Error('destroy failed'));await Promise.resolve();expect(w.getState().busy).toBe(true);resuming.resolve();await pending;expect(w.getState().busy).toBe(true);expect(w.getState().error).toMatch(/snapshot unavailable/);
  await w.resumeAfterWindowCloseFailure(new Error('destroy failed'));expect(w.getState().busy).toBe(false);expect(current(w).id).toBe(first);expect(current(w).controller).toBe(controller);await controller.edit({...note,fret:11});expect(controller.getState().snapshot.project.edits).toHaveLength(2);
});

it('retries only the live snapshot after Running resume succeeded and advances playback once',async()=>{
  const {workspace:w,session,bridge,first}=await sessionSetup();await current(w).controller.edit(note);await current(w).controller.undo();
  w.setView(first,{...initialDocumentView(),zoom:175,instrumentVisible:true});await w.flushViews();
  const entry=current(w),state=entry.controller.getState(),owner=w.getState().active;let running=false;
  vi.mocked(session.shutdown).mockImplementation(async()=>{running=false;});
  vi.mocked(session.resume).mockImplementation(async()=>{if(running)throw new Error('The session is not awaiting window destruction.');running=true;});
  expect(await w.requestWindowClose()).toBe(true);vi.mocked(bridge.snapshot).mockRejectedValueOnce(new Error('snapshot unavailable'));
  await w.resumeAfterWindowCloseFailure(new Error('destroy failed'));expect(w.getState().busy).toBe(true);
  await expect(entry.controller.redo()).rejects.toThrow(/transition/i);
  await w.resumeAfterWindowCloseFailure(new Error('destroy failed'));
  expect.soft(session.resume).toHaveBeenCalledOnce();expect(w.getState()).toMatchObject({busy:false,playbackResumeEpoch:1,error:'destroy failed'});
  expect(w.getState().active).toEqual(owner);expect(current(w).controller).toBe(entry.controller);expect(entry.controller.getState().snapshot).toBe(state.snapshot);expect(entry.controller.getState().score).toBe(state.score);expect(entry.controller.getState().settings).toBe(state.settings);expect(current(w).view).toEqual(entry.view);
  await entry.controller.redo();expect(entry.controller.getState().snapshot.project.edits).toEqual([note]);
  await w.resumeAfterWindowCloseFailure(new Error('already handled'));expect(session.resume).toHaveBeenCalledOnce();expect(w.getState()).toMatchObject({playbackResumeEpoch:1});
  expect(await w.requestWindowClose()).toBe(true);await w.resumeAfterWindowCloseFailure(new Error('second destroy failed'));expect(session.resume).toHaveBeenCalledTimes(2);expect(w.getState()).toMatchObject({busy:false,playbackResumeEpoch:2});
});

it('flush includes a view enqueued by a subscriber as the previous tail settles',async()=>{
  const {workspace:w,session,first}=await sessionSetup(),firstSend=deferred<void>(),latest=deferred<void>(),started=deferred<void>();let queued=false;
  vi.mocked(session.setView).mockReturnValueOnce(firstSend.promise).mockImplementationOnce(async()=>{started.resolve();await latest.promise;});
  w.setView(first,{...initialDocumentView(),zoom:125});await Promise.resolve();
  const unsubscribe=w.subscribe(()=>{if(!queued&&w.getState().recoveryError===null){queued=true;w.setView(first,{...initialDocumentView(),zoom:200});}});
  let flushed=false;const flushing=w.flushViews().then(()=>{flushed=true;});firstSend.resolve();
  expect(await Promise.race([started.promise.then(()=> 'sent'),flushing.then(()=> 'flushed')])).toBe('sent');expect(vi.mocked(session.setView).mock.calls.map(([,view])=>view.zoom)).toEqual([125,200]);expect(flushed).toBe(false);latest.resolve();await flushing;expect(current(w).view.zoom).toBe(200);unsubscribe();
});
it('score repair mirrors the addressed location without adding music edits or revisions',async()=>{
  const {workspace:w,session,first}=await sessionSetup(),controller=current(w).controller;
  await controller.edit({type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});w.setView(first,{...initialDocumentView(),target:{...target,track:1},selectedString:4,zoom:300});await w.flushViews();vi.mocked(session.setView).mockClear();
  await controller.edit({type:'removeTrack',track:1});await w.flushViews();expect(session.setView).toHaveBeenCalledExactlyOnceWith(first,{...initialDocumentView(),selectedString:4,zoom:300});expect(controller.getState().revision).toBe(2);expect(controller.getState().snapshot.project.edits).toHaveLength(2);
});

it('library intake validates before commit, activates aliases, and cancels a failed candidate without touching dirty tabs',async()=>{
  const {workspace:w,bridge,stage,first}=await setup();await current(w).controller.edit(note);await current(w).controller.undo();const old=current(w).controller.getState(),owner=w.getState().active;
  const library={stage:vi.fn(async()=>({kind:'candidate' as const,candidate:stage({...blankProject(),edits:[{type:'setRest' as const,target:{...target,bar:99}}]},'library-bad')}))};
  await expect(w.openSource({kind:'recent',id:'opaque'},library)).rejects.toThrow();expect(bridge.addDocument).not.toHaveBeenCalled();expect(bridge.cancelDocument).toHaveBeenCalledExactlyOnceWith('library-bad');expect(current(w).controller.getState()).toBe(old);expect(w.getState().active).toBe(owner);
  library.stage.mockResolvedValueOnce({kind:'existing',documentId:first} as never);expect(await w.openSource({kind:'indexed',rootId:'root',id:'result'},library)).toBe(true);expect(library.stage).toHaveBeenLastCalledWith({kind:'indexed',rootId:'root',id:'result'});expect(current(w).controller.getState()).toBe(old);
});
it('one drop transition preserves prior successes and dirty history through each item failure and cleanup',async()=>{
  const {workspace:w,bridge,stage,first}=await setup();await current(w).controller.edit(note);await current(w).controller.undo();const original=current(w).controller.getState(),pending=deferred<import('./types').DocumentIntake>();
  const library={dropStage:vi.fn().mockResolvedValueOnce({kind:'candidate',candidate:stage(blankProject(),'drop-first')}).mockRejectedValueOnce(new Error('Unsupported score file.')).mockResolvedValueOnce({kind:'candidate',candidate:stage({...blankProject(),edits:[{type:'setRest',target:{...target,bar:99}}]},'drop-bad')}).mockReturnValueOnce(pending.promise)};
  const dropping=w.openDrop('native-token',4,library);await vi.waitFor(()=>expect(library.dropStage).toHaveBeenCalledTimes(4));expect(w.getState().busy).toBe(true);await expect(w.openDocument()).rejects.toThrow(/transition/i);expect(w.getState().documents).toHaveLength(2);
  pending.resolve({kind:'existing',documentId:first});expect(await dropping).toEqual({opened:2,issues:['Unsupported score file.',expect.any(String)]});expect(library.dropStage.mock.calls).toEqual([['native-token',0],['native-token',1],['native-token',2],['native-token',3]]);expect(bridge.cancelDocument).toHaveBeenCalledExactlyOnceWith('drop-bad');expect(w.getState().documents[0].controller.getState()).toBe(original);expect(current(w).id).toBe(first);expect(w.getState().busy).toBe(false);
});
it('busy or invalid drops are rejected before consuming a native token',async()=>{
  const {workspace:w,first}=await setup(),library={dropStage:vi.fn()};const release=w.beginEditorOperation(first);
  await expect(w.openDrop('token',1,library)).rejects.toThrow(/finish/i);expect(library.dropStage).not.toHaveBeenCalled();release();
  for(const count of [0,33,1.5,NaN])await expect(w.openDrop('token',count,library)).rejects.toThrow(/drop/i);expect(library.dropStage).not.toHaveBeenCalled();
});

it('a new score starts in the saved default view and reports it to the native session, while existing views stay',async()=>{
  const {workspace:w,first}=await setup(),session=sessionFixture();w.setSessionBridge(session);w.setView(first,{...initialDocumentView(),zoom:125});
  try{
    writeViewDefaults({layout:'verticalPage',zoomMode:'fitPage',zoom:140,tracks:'all'},undefined);
    await w.newDocument();const created=current(w);
    expect(created.view).toMatchObject({zoom:140,trackView:{kind:'all'},scoreDisplay:{layout:'verticalPage',zoomMode:'fitPage'}});
    await vi.waitFor(()=>expect(session.setView).toHaveBeenCalledWith(created.id,created.view));
    expect(w.getState().documents.find(entry=>entry.id===first)!.view.zoom).toBe(125);
  }finally{forgetSessionViewDefaults();}
});
