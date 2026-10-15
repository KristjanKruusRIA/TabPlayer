import type { model } from '@coderline/alphatab';
import { buildDocument, exportGp, previewEdit, replayDocumentSettings, type BuiltDocument } from './engine';
import { type EditCommand, type ProjectSnapshot, type AssetCandidate, type DocumentCandidate } from './project';
import { isSettingsEdit } from './edit-types';
import type { NativeBridge } from './bridge';
import type { ClipboardMode,MusicClip } from './editor/clipboard-types';
import type { MusicSelection } from './editor/range-types';
import { makeMusicClip,musicClipSelection } from './editor/clipboard-source';

export interface DocumentState extends BuiltDocument { snapshot: ProjectSnapshot; documentEpoch:number; busy: boolean; error: string | null }

export class DocumentController {
  private state: DocumentState;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private undone:EditCommand[]=[];

  private constructor(private bridge: NativeBridge, snapshot: ProjectSnapshot, private beforeChange: () => void) {
    this.state={snapshot,...buildDocument(snapshot.project),documentEpoch:0,busy:false,error:null};
  }
  static async create(bridge: NativeBridge, beforeChange: () => void = () => {}) {
    return new DocumentController(bridge,await bridge.snapshot(),beforeChange);
  }
  getState = () => this.state;
  setBeforeChange(handler: () => void) { this.beforeChange=handler; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<DocumentState>) { this.state={...this.state,...change}; for (const listener of this.listeners) listener(); }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const job=this.tail.then(async()=>{
      this.update({busy:true,error:null});
      try { return await action(); }
      catch(error) { this.update({error:error instanceof Error ? error.message : String(error)}); throw error; }
      finally { this.update({busy:false}); }
    });
    this.tail=job.catch(()=>{}); return job;
  }
  private async saveNow(saveAs: boolean) {
    const snapshot=await this.bridge.saveProject(saveAs);
    if (!snapshot) return false;
    this.update({snapshot}); return true;
  }
  private async canLeave() {
    if (!this.state.snapshot.dirty) return true;
    const choice=await this.bridge.askUnsaved();
    return choice==='discard' || (choice==='save' && await this.saveNow(false));
  }
  private async replaceDocument(candidate:DocumentCandidate) {
    let built:BuiltDocument;let snapshot:ProjectSnapshot;
    try {
      built=buildDocument(candidate.project);
      snapshot=await this.bridge.replaceProject(candidate.token);
    } catch(error) {
      try {await this.bridge.cancelDocument?.(candidate.token);} catch {}
      throw error;
    }
    this.beforeChange();this.undone=[];this.update({snapshot,...built,documentEpoch:this.state.documentEpoch+1});
  }
  open() { return this.run(async()=>{
    if (!await this.canLeave()) return;
    const candidate=await this.bridge.readDocument(); if (!candidate) return;
    await this.replaceDocument(candidate);
  }); }
  new() { return this.run(async()=>{
    if (!await this.canLeave()) return;
    await this.replaceDocument(await this.bridge.createBlankDocument());
  }); }
  private async editNow(command:EditCommand,asset?:AssetCandidate) {
    let candidate:ReturnType<typeof previewEdit>;let snapshot:ProjectSnapshot;
    try {
      const project=asset?{...this.state.snapshot.project,assets:{...this.state.snapshot.project.assets,[asset.assetId]:asset.info}}:this.state.snapshot.project;
      candidate=previewEdit(project,command,this.state);
      snapshot=await this.bridge.applyEdit(command,asset?.token);
    } catch(error) {
      if(asset) {try {await this.bridge.cancelAsset?.(asset.token);} catch {}}
      throw error;
    }
    if(!isSettingsEdit(command))this.beforeChange();
    this.undone=[];this.update({snapshot,score:candidate.score,settings:candidate.settings,embeddedBacking:candidate.embeddedBacking,embeddedBackingSettings:candidate.embeddedBackingSettings,sourceMixes:candidate.sourceMixes});
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
    const snapshot=await this.bridge.undo();if(!settingsOnly)this.beforeChange();
    this.undone.push(removed);this.update({snapshot,...built});
  }); }
  redo() { return this.run(async()=>{
    const restored=this.state.snapshot.redoEdit ?? this.undone.at(-1);
    if(!restored){if(this.state.snapshot.canRedo)throw new Error('The next redo command is unavailable; reopen the document.');return;}
    const project={...this.state.snapshot.project,edits:[...this.state.snapshot.project.edits,restored]},settingsOnly=isSettingsEdit(restored);
    const built=settingsOnly?replayDocumentSettings(project,this.state):buildDocument(project);
    const snapshot=await this.bridge.redo();if(!settingsOnly)this.beforeChange();
    this.undone.pop();this.update({snapshot,...built});
  }); }
  save(saveAs = false) { return this.run(()=>this.saveNow(saveAs)); }
  export() { return this.run(async()=>{
    if (await this.bridge.confirmExport()) await this.bridge.exportGp(exportGp(this.state.score));
  }); }
  requestClose() { return this.run(()=>this.canLeave()); }
}
