import type { model } from '@coderline/alphatab';
import { buildDocument, effectiveAudioSettings,exportGp, previewEdit, replayDocumentSettings, type BuiltDocument } from './engine';
import { type EditCommand, type ProjectSnapshot, type AssetCandidate } from './project';
import type { DocumentId,DocumentRevision,DocumentSnapshot } from './workspace/types';
import { isSettingsEdit,type BackingSettings } from './edit-types';
import type { NativeBridge } from './bridge';
import type { ClipboardMode,MusicClip } from './editor/clipboard-types';
import type { MusicSelection } from './editor/range-types';
import { makeMusicClip,musicClipSelection } from './editor/clipboard-source';
import type {NativeBackingWaveformBridge} from './audio/backing-waveform-types';
import {backingLocationsForScore} from './audio/plan';
import {referenceSyncTiming,referenceTimingKey} from './audio/reference-sync';
import {projectGpDocument} from './interchange/backing-projection';

type ReferenceWaveformBinding={bridge:NativeBackingWaveformBridge};
const tempoState=(score:model.Score)=>JSON.stringify(score.masterBars.map(bar=>bar.tempoAutomations.map(tempo=>[
  tempo.type,tempo.value,tempo.ratioPosition,tempo.isLinear,tempo.isVisible,tempo.text??'',tempo.syncPointValue,
])));
const backingState=(backing:BackingSettings|null)=>JSON.stringify(backing?[
  backing.assetId,backing.offsetMs,backing.anchors.map(a=>[a.bar,a.occurrence,a.ratio,a.audioMs]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3]),
  [backing.mix.gain,backing.mix.pan,backing.mix.mute,backing.mix.solo],backing.referenceSync?[backing.referenceSync.entryAudioMs,backing.referenceSync.exitAudioMs]:null,
]:null);

export interface DocumentState extends BuiltDocument { documentId:DocumentId; revision:number; snapshot: ProjectSnapshot; documentEpoch:number; busy: boolean; error: string | null }

export class DocumentController {
  private state: DocumentState;
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private pendingActions=0;
  private undone:EditCommand[]=[];
  private referenceBinding:ReferenceWaveformBinding|null=null;
  private referenceMetadata:{binding:ReferenceWaveformBinding;assetId:string;durationMs:number}|null=null;

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
  setReferenceWaveformBridge(bridge:NativeBackingWaveformBridge):()=>void {
    const binding={bridge};this.referenceBinding=binding;this.referenceMetadata=null;
    return ()=>{if(this.referenceBinding===binding){this.referenceBinding=null;this.referenceMetadata=null;}};
  }
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
      if(command.type==='setBacking'&&backingState(command.backing)===backingState(effectiveAudioSettings(this.state.snapshot.project,this.state).backing)){
        if(asset)await this.bridge.cancelAsset(asset.token);return;
      }
      if(command.type==='replaceTempoAutomations'&&tempoState(candidate.score)===tempoState(this.state.score))return;
      await this.admitReferenceTiming(candidate);
      record=await this.bridge.applyEdit(command,this.state.revision,asset?.token);
      this.verifyRecord(record);
    } catch(error) {
      if(asset) {try {await this.bridge.cancelAsset?.(asset.token);} catch {}}
      throw error;
    }
    if(!isSettingsEdit(command))this.beforeChange();
    this.undone=[];this.update({...record,score:candidate.score,settings:candidate.settings,embeddedBacking:candidate.embeddedBacking,embeddedBackingSettings:candidate.embeddedBackingSettings,sourceMixes:candidate.sourceMixes});
  }
  private async admitReferenceTiming(candidate:BuiltDocument) {
    const backing=candidate.settings.backing;
    if(!backing?.referenceSync||candidate.score===this.state.score&&referenceTimingKey(backing)===referenceTimingKey(this.state.settings.backing))return;
    if(!this.state.snapshot.project.assets[backing.assetId])throw new Error('Import and commit backing audio before enabling reference timing.');
    const binding=this.referenceBinding,document={documentId:this.state.documentId,revision:this.state.revision};
    if(!binding||binding.bridge.owner.documentId!==document.documentId)throw new Error('Reference timing requires the active backing waveform source.');
    let durationMs=this.referenceMetadata?.binding===binding&&this.referenceMetadata.assetId===backing.assetId?this.referenceMetadata.durationMs:null;
    if(durationMs===null) {
      const receipt=await binding.bridge.read(document,{kind:'asset',assetId:backing.assetId},1);
      if(receipt.document.documentId!==document.documentId||receipt.document.revision!==document.revision||receipt.owner.documentId!==binding.bridge.owner.documentId||receipt.owner.activationId!==binding.bridge.owner.activationId||receipt.source.kind!=='asset'||receipt.source.assetId!==backing.assetId||!Number.isFinite(receipt.durationMs)||receipt.durationMs<=0)throw new Error('The backing waveform source receipt does not match the current document.');
      durationMs=receipt.durationMs;
    }
    if(this.referenceBinding!==binding||this.state.documentId!==document.documentId||this.state.revision!==document.revision||this.isWorkspaceTransitioning())throw new Error('The active reference source changed. Try the edit again.');
    referenceSyncTiming(backing,backingLocationsForScore(candidate.score),durationMs);
    this.referenceMetadata={binding,assetId:backing.assetId,durationMs};
  }
  edit(command: EditCommand, asset?:AssetCandidate) { return this.run(()=>this.editNow(command,asset)); }
  editAtRevision(command:EditCommand,expected:DocumentRevision) {
    const requested=structuredClone(command),document={...expected};
    return this.run(()=>{
      if(document.documentId!==this.state.documentId||document.revision!==this.state.revision)throw new Error('The document revision changed. Try the edit again.');
      return this.editNow(requested);
    });
  }
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
    if(!await this.bridge.confirmExport())return;
    const current=this.state,settings=effectiveAudioSettings(current.snapshot.project,current),backing=settings.backing;
    const bytes=backing&&backing.assetId!=='embedded'?await this.bridge.readBackingAsset(backing.assetId,current.revision):current.embeddedBacking;
    const score=projectGpDocument({score:current.score,settings,bytes,selection:{tracks:current.score.tracks.map((_,index)=>index),range:null},backing:true});
    await this.bridge.exportGp(exportGp(score),current.revision);
  }); }
  requestClose() { return this.run(()=>this.canLeave(),true); }
}
