import type { model } from '@coderline/alphatab';
import type { WorkspaceController } from './WorkspaceController';
import { LibraryController } from '../library/LibraryController';
import type { MetadataRunner } from '../library/metadata-runner';
import { projectMetadata } from '../library/metadata';
import type { LibrarySection,LibrarySource,NativeFileLibraryBridge,ScoreFilesDroppedEvent } from '../library/types';
import type { DocumentRevision } from './types';

export interface WorkspaceLibraryState {open:boolean;welcome:boolean;error:string|null;closeReason:'dismiss'|'opened'|null}
export class WorkspaceLibrary {
  controller!:LibraryController;
  opener:HTMLElement|null=null;
  private state:WorkspaceLibraryState={open:false,welcome:false,error:null,closeReason:null};
  private listeners=new Set<()=>void>();
  private release:(()=>void)|null=null;
  private committed=false;
  private welcomeShown=false;
  private disposed=false;
  private constructor(private workspace:WorkspaceController,private bridge:NativeFileLibraryBridge,private blocked:()=>string|null){}
  static async create(workspace:WorkspaceController,bridge:NativeFileLibraryBridge,runner:MetadataRunner,options:{blocked:()=>string|null;restoredWorkingDocument:boolean}):Promise<WorkspaceLibrary>{
    const library=new WorkspaceLibrary(workspace,bridge,options.blocked);
    library.controller=await LibraryController.create(bridge,runner,{openSource:source=>library.openSource(source),saveTemplate:(name,revision)=>library.saveTemplate(name,revision)});
    workspace.setLibraryObserver({committed:(document,score)=>library.acknowledge(document,score),failed:error=>library.reportError(error),transitioning:()=>{if(library.controller.getState().scanning)void library.controller.cancelScan();}});
    if(library.controller.getState().snapshot?.welcomeSeen===false&&!options.restoredWorkingDocument)library.show('recent',null,true);
    return library;
  }
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(patch:Partial<WorkspaceLibraryState>){if(this.disposed)return;this.state={...this.state,...patch};this.listeners.forEach(listener=>listener());}
  show(section:LibrarySection='recent',opener:HTMLElement|null=null,welcome=false):void{
    if(this.disposed||this.state.open)return;
    try{
      const blocked=this.blocked();if(blocked)throw new Error(blocked);
      this.release=this.workspace.beginEditorOperation(this.workspace.getState().active.documentId);
      this.opener=opener;this.committed=false;this.welcomeShown=false;this.controller.section(section);
      this.update({open:true,welcome,error:null,closeReason:null});
    }catch(error){this.reportError(error);}
  }
  shown():void{
    if(!this.state.open||!this.state.welcome||this.welcomeShown)return;this.welcomeShown=true;
    void this.controller.change({kind:'welcomeSeen'});
  }
  close():void{
    if(!this.state.open)return;
    this.release?.();this.release=null;this.update({open:false,closeReason:this.committed?'opened':'dismiss'});
  }
  private async openSource(source:LibrarySource):Promise<boolean>{
    if(!this.release||!this.state.open)throw new Error('Open the Library before choosing a score.');
    const blocked=this.blocked();if(blocked)throw new Error(blocked);
    this.release();this.release=null;
    const opening=this.workspace.openSource(source,this.bridge);
    try{this.committed=await opening;return this.committed;}
    finally{if(!this.committed&&!this.disposed&&this.state.open)this.release=this.workspace.beginEditorOperation(this.workspace.getState().active.documentId);}
  }
  private saveTemplate(name:string,expectedRevision:number){
    if(!this.release||!this.state.open)throw new Error('Open the Library before saving a template.');
    const blocked=this.blocked();if(blocked)throw new Error(blocked);
    const state=this.workspace.getState(),entry=state.documents.find(entry=>entry.id===state.active.documentId)!;
    return this.bridge.saveTemplate(expectedRevision,{documentId:entry.id,revision:entry.controller.getState().revision},name);
  }
  private async acknowledge(document:DocumentRevision,score:model.Score):Promise<void>{
    if(this.disposed)return;
    // A password-protected score sends no details at all: the native side keeps none of them in the plain catalog and clears what an earlier build stored.
    const sealed=this.workspace.getState().documents.find(entry=>entry.id===document.documentId)?.controller.getState().snapshot.protection?.open===true;
    const metadata=sealed?{title:'',artist:'',album:'',trackNames:[],metadataTruncated:false}:projectMetadata({title:score.title,artist:score.artist,album:score.album,trackNames:score.tracks.slice(0,256).map(track=>track.name),metadataTruncated:score.tracks.length>256},[]);
    await this.bridge.ackMetadata({documentId:document.documentId,revision:document.revision},metadata);
    if(!this.disposed)await this.controller.refresh();
  }
  async reveal():Promise<void>{
    if(this.disposed)return;this.update({error:null});
    let release:(()=>void)|null=null;
    try{const blocked=this.blocked();if(blocked)throw new Error(blocked);const state=this.workspace.getState(),entry=state.documents.find(entry=>entry.id===state.active.documentId)!;const document=entry.controller.getState();if(!document.snapshot.path)throw new Error('Save this score before opening its containing folder.');release=this.workspace.beginEditorOperation(entry.id);await this.bridge.reveal({documentId:entry.id,revision:document.revision});}
    catch(error){this.reportError(error);}finally{release?.();}
  }
  refresh():Promise<void>{return this.controller.refresh();}
  async drop(event:ScoreFilesDroppedEvent):Promise<void>{
    if(this.disposed)return;
    try{
      const blocked=this.blocked();if(blocked)throw new Error(blocked);
      if(this.state.open)throw new Error('Finish the current Library operation before dropping scores.');
      this.update({error:null});
      const result=await this.workspace.openDrop(event.dropToken,event.count,this.bridge);
      if(result.issues.length)this.update({error:`${this.state.error?`${this.state.error} `:''}${result.opened} score${result.opened===1?'':'s'} opened. ${result.issues.join(' ')}`});
    }catch(error){this.reportError(error);}
  }
  reportError(error:unknown):void{this.update({error:`Library: ${error instanceof Error?error.message:String(error)}`});}
  dispose():void{if(this.disposed)return;this.disposed=true;this.release?.();this.release=null;this.workspace.setLibraryObserver(null);this.controller.dispose();this.listeners.clear();}
}
