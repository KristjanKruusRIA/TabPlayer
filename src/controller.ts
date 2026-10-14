import type { model } from '@coderline/alphatab';
import { buildScore, exportGp, previewEdit } from './engine';
import { blankProject, type EditCommand, type ProjectSnapshot } from './project';
import type { NativeBridge } from './bridge';

export interface DocumentState { snapshot: ProjectSnapshot; score: model.Score; busy: boolean; error: string | null }

export class DocumentController {
  private state: DocumentState;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private bridge: NativeBridge, snapshot: ProjectSnapshot, private beforeChange: () => void) {
    this.state={snapshot,score:buildScore(snapshot.project),busy:false,error:null};
  }
  static async create(bridge: NativeBridge, beforeChange: () => void = () => {}) {
    return new DocumentController(bridge,await bridge.snapshot(),beforeChange);
  }
  getState = () => this.state;
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
  open() { return this.run(async()=>{
    if (!await this.canLeave()) return;
    const candidate=await this.bridge.readDocument(); if (!candidate) return;
    const score=buildScore(candidate.project); this.beforeChange();
    const snapshot=await this.bridge.replaceProject(candidate.project,candidate.path);
    this.update({snapshot,score});
  }); }
  new() { return this.run(async()=>{
    if (!await this.canLeave()) return;
    const project=blankProject(); const score=buildScore(project); this.beforeChange();
    const snapshot=await this.bridge.replaceProject(project,null); this.update({snapshot,score});
  }); }
  edit(command: EditCommand) { return this.run(async()=>{
    const candidate=previewEdit(this.state.snapshot.project,command); this.beforeChange();
    const snapshot=await this.bridge.applyEdit(command); this.update({snapshot,score:candidate.score});
  }); }
  undo() { return this.run(async()=>{
    this.beforeChange(); const snapshot=await this.bridge.undo();
    this.update({snapshot,score:buildScore(snapshot.project)});
  }); }
  redo() { return this.run(async()=>{
    this.beforeChange(); const snapshot=await this.bridge.redo();
    this.update({snapshot,score:buildScore(snapshot.project)});
  }); }
  save(saveAs = false) { return this.run(()=>this.saveNow(saveAs)); }
  export() { return this.run(async()=>{
    if (await this.bridge.confirmExport()) await this.bridge.exportGp(exportGp(this.state.score));
  }); }
  requestClose() { return this.run(()=>this.canLeave()); }
}
