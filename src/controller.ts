import type { model } from '@coderline/alphatab';
import { buildDocument, exportGp, previewEdit, replayDocumentSettings, type BuiltDocument } from './engine';
import { type EditCommand, type ProjectSnapshot, type AssetCandidate } from './project';
import type { DocumentId,DocumentSnapshot } from './workspace/types';
import { isSettingsEdit } from './edit-types';
import type { NativeBridge } from './bridge';
import type { ClipboardMode,MusicClip } from './editor/clipboard-types';
import type { MusicSelection } from './editor/range-types';
import { makeMusicClip,musicClipSelection } from './editor/clipboard-source';

export interface DocumentState extends BuiltDocument { documentId:DocumentId; revision:number; snapshot: ProjectSnapshot; documentEpoch:number; busy: boolean; error: string | null }

export class DocumentController {
  private state: DocumentState;
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private pendingActions=0;
  private undone:EditCommand[]=[];

  private constructor(private bridge: NativeBridge, record:DocumentSnapshot, private beforeChange: () => void, private isWorkspaceTransitioning:()=>boolean) {
    this.verifyRecord(record);
    this.state={...record,...buildDocument(record.snapshot.project),documentEpoch:0,busy:false,error:null};
  }
  static async create(bridge: NativeBridge, beforeChange: () => void = () => {},initial?:DocumentSnapshot,isWorkspaceTransitioning:()=>boolean=()=>false) {
    return new DocumentController(bridge,initial ?? await bridge.snapshot(),beforeChange,isWorkspaceTransitioning);
  }
  private verifyRecord(record:DocumentSnapshot) {
    if(record.documentId!==this.bridge.documentId) throw new Error('The native response belongs to a different document.');
  }
  hasPendingActions() { return this.pendingActions>0; }
  whenIdle():Promise<void> { return this.tail; }
  getState = () => this.state;
  setBeforeChange(handler: () => void) { this.beforeChange=handler; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<DocumentState>) { this.state={...this.state,...change}; for (const listener of this.listeners) listener(); }
  private run<T>(action: () => Promise<T>,allowTransition=false): Promise<T> {
    if(!allowTransition && this.isWorkspaceTransitioning()) return Promise.reject(new Error('Wait for the current workspace transition to finish.'));
    this.pendingActions++;
    const job=this.tail.then(async()=>{
      this.update({busy:true,error:null});
      try { return await action(); }
      catch(error) { this.update({error:error instanceof Error ? error.message : String(error)}); throw error; }
      finally { this.pendingActions--;this.update({busy:this.hasPendingActions()}); }
    });
    this.tail=job.then(()=>{},()=>{}); return job;
  }
  private async saveNow(saveAs: boolean) {
    const record=await this.bridge.saveProject(saveAs,this.state.revision);
    if (!record) return false;
    this.verifyRecord(record);this.update(record); return true;
  }
  private async canLeave() {
    if (!this.state.snapshot.dirty) return true;
    const choice=await this.bridge.askUnsaved(this.state.score.title || 'Untitled',this.state.snapshot.path);
    return choice==='discard' || (choice==='save' && await this.saveNow(false));
  }
  private async editNow(command:EditCommand,asset?:AssetCandidate) {
    let candidate:ReturnType<typeof previewEdit>;let record:DocumentSnapshot;
    try {
      const project=asset?{...this.state.snapshot.project,assets:{...this.state.snapshot.project.assets,[asset.assetId]:asset.info}}:this.state.snapshot.project;
      candidate=previewEdit(project,command,this.state);
      record=await this.bridge.applyEdit(command,this.state.revision,asset?.token);
      this.verifyRecord(record);
    } catch(error) {
      if(asset) {try {await this.bridge.cancelAsset?.(asset.token);} catch {}}
      throw error;
    }
    if(!isSettingsEdit(command))this.beforeChange();
    this.undone=[];this.update({...record,score:candidate.score,settings:candidate.settings,embeddedBacking:candidate.embeddedBacking,embeddedBackingSettings:candidate.embeddedBackingSettings,sourceMixes:candidate.sourceMixes});
  }
  edit(command: EditCommand, asset?:AssetCandidate) { return this.run(()=>this.editNow(command,asset)); }
  copyMusic(selection:MusicSelection,mode:ClipboardMode):Promise<MusicClip> {
    const requested=structuredClone(selection);
    return this.run(async()=>makeMusicClip(this.state.score,requested,mode));
  }
  cutMusic(selection:MusicSelection,mode:ClipboardMode):Promise<MusicClip> {
    const requested=structuredClone(selection);
    return this.run(async()=>{
      const scope=musicClipSelection(this.state.score,requested,mode),clip=makeMusicClip(this.state.score,scope,mode);
      const bars=scope as Extract<MusicSelection,{kind:'bars'}>;
      await this.editNow(mode==='multiTrack'?{type:'removeMeasures',firstBar:bars.firstBar,lastBar:bars.lastBar}:{type:'eraseSelection',selection:scope});
      return clip;
    });
  }
  undo() { return this.run(async()=>{
    const project=this.state.snapshot.project,removed=project.edits.at(-1);if(!removed)return;
    const settingsOnly=isSettingsEdit(removed),previous={...project,edits:project.edits.slice(0,-1)};
    const built=settingsOnly?replayDocumentSettings(previous,this.state):buildDocument(previous);
    const record=await this.bridge.undo(this.state.revision);this.verifyRecord(record);if(!settingsOnly)this.beforeChange();
    this.undone.push(removed);this.update({...record,...built});
  }); }
  redo() { return this.run(async()=>{
    const restored=this.state.snapshot.redoEdit ?? this.undone.at(-1);
    if(!restored){if(this.state.snapshot.canRedo)throw new Error('The next redo command is unavailable; reopen the document.');return;}
    const project={...this.state.snapshot.project,edits:[...this.state.snapshot.project.edits,restored]},settingsOnly=isSettingsEdit(restored);
    const built=settingsOnly?replayDocumentSettings(project,this.state):buildDocument(project);
    const record=await this.bridge.redo(this.state.revision);this.verifyRecord(record);if(!settingsOnly)this.beforeChange();
    this.undone.pop();this.update({...record,...built});
  }); }
  save(saveAs = false) { return this.run(()=>this.saveNow(saveAs)); }
  export() { return this.run(async()=>{
    if (await this.bridge.confirmExport()) await this.bridge.exportGp(exportGp(this.state.score),this.state.revision);
  }); }
  requestClose() { return this.run(()=>this.canLeave(),true); }
}
