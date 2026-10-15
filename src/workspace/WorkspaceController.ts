import { createDocumentBridge } from '../bridge';
import { DocumentController } from '../controller';
import { ClipboardStore } from '../editor/ClipboardStore';
import { buildDocument } from '../engine';
import type { DocumentCandidate } from '../project';
import type { AudioOwner,CloseDocument,DocumentId,DocumentViewState,NativeWorkspaceBridge,WorkspaceSnapshot } from './types';
import { initialDocumentView,repairDocumentView } from './view-state';

export interface WorkspaceState {
  documents:readonly {id:DocumentId;controller:DocumentController;view:DocumentViewState}[];
  active:AudioOwner;busy:boolean;error:string|null;
}
export class WorkspaceController {
  readonly clipboard=new ClipboardStore();
  private state!:WorkspaceState;
  private listeners=new Set<()=>void>();
  private subscriptions=new Map<DocumentId,()=>void>();
  private transitioning=false;
  private windowClosing=false;
  private editorOperation:DocumentId|null=null;
  private constructor(private bridge:NativeWorkspaceBridge) {}
  static async create(bridge:NativeWorkspaceBridge):Promise<WorkspaceController> {
    const workspace=new WorkspaceController(bridge);
    await workspace.synchronize(await bridge.snapshot());return workspace;
  }
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private update(change:Partial<WorkspaceState>) {
    this.state={...this.state,...change};for(const listener of this.listeners)listener();
  }
  private async synchronize(snapshot:WorkspaceSnapshot) {
    const cached=new Map(this.state?.documents.map(entry=>[entry.id,entry]));
    const documents:WorkspaceState['documents'][number][]=[];
    for(const record of snapshot.documents) {
      const existing=cached.get(record.documentId);
      if(existing){documents.push(existing);continue;}
      const id=record.documentId;
      const controller=await DocumentController.create(createDocumentBridge(id),undefined,record,()=>this.transitioning||!this.subscriptions.has(id));
      documents.push({id,controller,view:repairDocumentView(controller.getState().score,initialDocumentView())});
      this.subscriptions.set(id,controller.subscribe(()=>{
        this.update({documents:this.state.documents.map(entry=>entry.id===id?{...entry,view:repairDocumentView(controller.getState().score,entry.view)}:entry)});
      }));
    }
    for(const [id,unsubscribe] of this.subscriptions)if(!documents.some(entry=>entry.id===id)){unsubscribe();this.subscriptions.delete(id);}
    this.update({documents,active:snapshot.active,busy:this.transitioning||this.editorOperation!==null,error:null});
  }
  private conflict() {
    if(this.editorOperation!==null)return 'Finish or cancel the current editor operation before changing documents.';
    if(this.transitioning)return 'Wait for the current workspace transition to finish.';
    if(this.state.documents.some(entry=>entry.controller.hasPendingActions()))return 'Wait for pending document actions to finish before changing documents.';
    return null;
  }
  private async transition(action:()=>Promise<boolean>,closing=false):Promise<boolean> {
    const conflict=this.conflict();
    if(conflict){const message=closing&&this.editorOperation!==null?'Finish or cancel the current operation before closing.':conflict;this.update({error:message});if(closing)return false;throw new Error(message);}
    this.transitioning=true;this.update({busy:true,error:null});
    try{return await action();}
    catch(error){this.update({error:error instanceof Error?error.message:String(error)});throw error;}
    finally{if(!this.windowClosing){this.transitioning=false;this.update({busy:this.editorOperation!==null});}}
  }
  private async add(candidate:DocumentCandidate) {
    let committed=false;
    try {
      buildDocument(candidate.project);
      const snapshot=await this.bridge.addDocument(candidate.token);committed=true;
      await this.synchronize(snapshot);return true;
    } catch(error) {
      if(!committed){try{await this.bridge.cancelDocument(candidate.token);}catch{}}
      throw error;
    }
  }
  newDocument():Promise<boolean> {return this.transition(async()=>this.add(await this.bridge.createBlankDocument()));}
  openDocument():Promise<boolean> {return this.transition(async()=>{
    const intake=await this.bridge.readDocument();if(!intake)return false;
    if(intake.kind==='candidate')return this.add(intake.candidate);
    await this.synchronize(await this.bridge.activateDocument(intake.documentId));return true;
  });}
  activate(documentId:DocumentId):Promise<boolean> {return this.transition(async()=>{
    if(!this.state.documents.some(entry=>entry.id===documentId))throw new Error('Select an open document.');
    if(this.state.active.documentId===documentId)return true;
    await this.synchronize(await this.bridge.activateDocument(documentId));return true;
  });}
  private async closeNow(ids:readonly DocumentId[],windowClose=false) {
    const decisions:CloseDocument[]=[];
    for(const id of ids) {
      const entry=this.state.documents.find(document=>document.id===id);if(!entry)throw new Error('Select an open document.');
      if(!await entry.controller.requestClose())return false;
      const state=entry.controller.getState();decisions.push({documentId:id,revision:state.revision,discard:state.snapshot.dirty});
    }
    const snapshot=await this.bridge.closeDocuments(decisions);
    if(windowClose)this.windowClosing=true;else await this.synchronize(snapshot);return true;
  }
  close(documentId:DocumentId):Promise<boolean> {return this.transition(()=>this.closeNow([documentId]),true);}
  closeAll():Promise<boolean> {return this.transition(()=>this.closeNow(this.state.documents.map(entry=>entry.id)),true);}
  async requestWindowClose():Promise<boolean> {try{return await this.transition(()=>this.closeNow(this.state.documents.map(entry=>entry.id),true),true);}catch{return false;}}
  async resumeAfterWindowCloseFailure(error:unknown):Promise<void> {
    const message=error instanceof Error?error.message:String(error);
    try {await this.synchronize(await this.bridge.snapshot());}
    catch(refreshError){this.update({error:`${message}. Could not refresh workspace: ${refreshError instanceof Error?refreshError.message:String(refreshError)}`});return;}
    this.windowClosing=false;this.transitioning=false;this.update({busy:false,error:message});
  }
  setView(documentId:DocumentId,view:DocumentViewState) {
    this.update({documents:this.state.documents.map(entry=>entry.id===documentId?{...entry,view:repairDocumentView(entry.controller.getState().score,view)}:entry)});
  }
  beginEditorOperation(documentId:DocumentId):()=>void {
    if(this.state.active.documentId!==documentId)throw new Error('The editor operation must belong to the active document.');
    const conflict=this.conflict();if(conflict)throw new Error(conflict);
    this.editorOperation=documentId;this.update({busy:true,error:null});let released=false;
    return ()=>{if(released)return;released=true;this.editorOperation=null;this.update({busy:this.transitioning});};
  }
}
