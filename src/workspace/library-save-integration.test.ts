import {beforeEach,expect,it,vi} from 'vitest';
import {blankProject,type Project} from '../project';
import type {DocumentSnapshot,WorkspaceSnapshot} from './types';
import {WorkspaceController} from './WorkspaceController';
import {WorkspaceLibrary} from './WorkspaceLibrary';
import type {NativeFileLibraryBridge} from '../library/types';
import type {NativeSessionBridge} from './recovery-types';

const native=vi.hoisted(()=>({invoke:vi.fn(),message:vi.fn(),confirm:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({message:native.message,confirm:native.confirm}));
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('VITE_DESKTOP_TEST','0');});
const catalog=()=>({version:1 as const,revision:1,welcomeSeen:true,recents:[],roots:[],templates:[],examples:[],warning:null});
function setup(){
  const original={...blankProject(),baselineEdits:[{type:'setScoreInfo' as const,title:'Saved ensemble',artist:'Composer',tempo:120},{type:'setScoreMetadata' as const,fields:{album:'Studies',subTitle:'',words:'',music:'',copyright:'',instructions:'',notices:'',tab:''}}]};
  const records=new Map<string,DocumentSnapshot>(['a','b'].map(documentId=>[documentId,{documentId,revision:3,snapshot:{project:original as Project,path:`C:/scores/${documentId}.tabplayer`,dirty:true,canUndo:false,canRedo:false}}]));let active={documentId:'b',activationId:'owner-b'};
  const snapshot=():WorkspaceSnapshot=>({documents:[...records.values()],active});
  native.invoke.mockImplementation(async(name,args)=>{
    if(name==='workspace_snapshot')return snapshot();
    if(name==='save_project'){const r=records.get(args.document.documentId)!;if(r.revision!==args.document.revision)throw new Error('Stale save.');const next={...r,revision:r.revision+1,snapshot:{...r.snapshot,dirty:false,path:`C:/saved/${r.documentId}.tabplayer`}};records.set(r.documentId,next);return next;}
    if(name==='workspace_close'){args.documents.forEach((r:{documentId:string})=>records.delete(r.documentId));return snapshot();}
    if(name==='workspace_activate'){active={documentId:args.documentId,activationId:`owner-${args.documentId}`};return snapshot();}
    throw new Error(`Unexpected native operation ${name}`);
  });
  const bridge={snapshot:async()=>snapshot(),activateDocument:async(documentId:string)=>{active={documentId,activationId:`owner-${documentId}`};return snapshot();}} as import('./types').NativeWorkspaceBridge;
  const library={snapshot:vi.fn(async()=>catalog()),ackMetadata:vi.fn(async()=>catalog()),reveal:vi.fn(async()=>{})} as unknown as NativeFileLibraryBridge;
  return {records,bridge,library,snapshot};
}
it('the common real document bridge acknowledges only successful saves, including an inactive request-close save, with returned address and canonical metadata',async()=>{
  const f=setup(),w=await WorkspaceController.create(f.bridge),library=await WorkspaceLibrary.create(w,f.library,{run:vi.fn(),dispose:vi.fn()},{blocked:()=>null,restoredWorkingDocument:true});
  const a=w.getState().documents[0].controller,b=w.getState().documents[1].controller;
  await b.save(true);await vi.waitFor(()=>expect(f.library.ackMetadata).toHaveBeenCalledTimes(1));expect(vi.mocked(f.library.ackMetadata).mock.calls[0]).toEqual([{documentId:'b',revision:4},{title:'Saved ensemble',artist:'Composer',album:'Studies',trackNames:['Guitar'],metadataTruncated:false}]);
  native.message.mockResolvedValueOnce('Save');expect(await a.requestClose()).toBe(true);await vi.waitFor(()=>expect(f.library.ackMetadata).toHaveBeenCalledTimes(2));expect(vi.mocked(f.library.ackMetadata).mock.calls[1][0]).toEqual({documentId:'a',revision:4});expect(w.getState().active.documentId).toBe('b');
  native.invoke.mockResolvedValueOnce(null);expect(await b.save()).toBe(false);expect(f.library.ackMetadata).toHaveBeenCalledTimes(2);
  vi.mocked(f.library.ackMetadata).mockRejectedValueOnce(new Error('Catalog read-only.'));expect(await b.save()).toBe(true);await vi.waitFor(()=>expect(library.getState().error).toContain('Catalog read-only.'));expect(b.getState().snapshot.dirty).toBe(false);expect(b.getState().error).toBeNull();library.dispose();
});
it('reveal sends only the current saved document address under a temporary lease and never changes owner or music',async()=>{
  const f=setup(),w=await WorkspaceController.create(f.bridge),library=await WorkspaceLibrary.create(w,f.library,{run:vi.fn(),dispose:vi.fn()},{blocked:()=>null,restoredWorkingDocument:true}),before=w.getState(),score=before.documents[1].controller.getState();
  await library.reveal();expect(f.library.reveal).toHaveBeenCalledExactlyOnceWith({documentId:'b',revision:3});expect(w.getState().active).toBe(before.active);expect(w.getState().documents[1].controller.getState()).toBe(score);expect(w.getState().busy).toBe(false);expect(f.library.ackMetadata).not.toHaveBeenCalled();library.dispose();
});
it('a successful reveal retry clears the old Library failure, and an unsaved score cannot submit a path',async()=>{
  const f=setup(),w=await WorkspaceController.create(f.bridge),library=await WorkspaceLibrary.create(w,f.library,{run:vi.fn(),dispose:vi.fn()},{blocked:()=>null,restoredWorkingDocument:true});
  vi.mocked(f.library.reveal).mockRejectedValueOnce(new Error('Launcher unavailable.'));await library.reveal();expect(library.getState().error).toContain('Launcher unavailable.');await library.reveal();expect(library.getState().error).toBeNull();library.dispose();
  const unsaved=setup();unsaved.records.get('b')!.snapshot.path=null;const second=await WorkspaceController.create(unsaved.bridge),next=await WorkspaceLibrary.create(second,unsaved.library,{run:vi.fn(),dispose:vi.fn()},{blocked:()=>null,restoredWorkingDocument:true});await next.reveal();expect(unsaved.library.reveal).not.toHaveBeenCalled();expect(next.getState().error).toMatch(/Save this score/);expect(second.getState().busy).toBe(false);next.dispose();
});
