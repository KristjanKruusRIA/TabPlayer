import type { model } from '@coderline/alphatab';
import { admitDocumentBase } from './interchange/archive-gate';
import { gpExportRefusal,gpLosses } from './interchange/gp-losses';
import { scoreHasMusicXmlTimeCarry } from './interchange/musicxml-time-symbols';
import { gpWarning } from './export/gp-warning';
import { yieldAfter,yieldToInput } from './engine-verify';
import { getMessage,getResolvedLanguage,type MessageKey } from './i18n';
import { buildDocument, canEditInPlace, canUndoInPlace, checkpointFits, cloneDocument, compareDocuments, compareWithRebuild, makeCheckpoint, checkEditInPlace, editInPlace, editStats, idleVerification, registerLiveDocument, undoInPlace, verifyEditStepwise, effectiveAudioSettings,exportGp, forgetPreview, previewEdit, replayDocumentSettings, shouldCheckEdit, type BuiltDocument, type Checkpoint } from './engine';
import { appliesFilePartialCapo, projectCommands, type EditCommand, type ProjectSnapshot, type AssetCandidate, type DocumentLock } from './project';
import { getPartialCapo } from './editor/partial-capo';
import type { DocumentId,DocumentRevision,DocumentSnapshot } from './workspace/types';
import { isSettingsEdit,type BackingSettings } from './edit-types';
import type { NativeBridge } from './bridge';
import type { ProtectionRequest } from './protection/protection';
import type { ClipboardMode,MusicClip } from './editor/clipboard-types';
import type { MusicSelection,VoiceAddress } from './editor/range-types';
import { makeMusicClip,musicClipSelection } from './editor/clipboard-source';
import { pasteGestureProblem } from './editor/clipboard-paste';
import type {NativeBackingWaveformBridge} from './audio/backing-waveform-types';
import {backingLocationsForScore} from './audio/plan';
import {backingProcessingKey} from './audio/backing-processing';
import {referenceSyncTiming,referenceTimingKey} from './audio/reference-sync';
import {scoreUsesTempoUnits,tempoUnitOf} from './editor/tempo-unit';
import {projectGpDocument} from './interchange/backing-projection';
import {barMapOfEdit,barMapOfUndo} from './editor/edit-bar-map';
import type {BarIndexMap} from './editor/measures-types';
import {rangeCutsSoundingBeat} from './editor/clipboard-subdivide';
import {anchorLane,cutRefusal,eraseCommandFor} from './editor/range-cut';

/** Called before a score change the player must rebuild for; `bars` says where the bars went when the change moved some and that is known. */
export type BeforeChange=(bars?:BarIndexMap)=>void;

type ReferenceWaveformBinding={bridge:NativeBackingWaveformBridge};
const tempoState=(score:model.Score)=>JSON.stringify(score.masterBars.map(bar=>bar.tempoAutomations.map(tempo=>[
  tempo.type,tempo.value,tempo.ratioPosition,tempo.isLinear,tempo.isVisible,tempo.text??'',tempo.syncPointValue,tempoUnitOf(tempo),
])));
const backingState=(backing:BackingSettings|null)=>JSON.stringify(backing?[
  backing.assetId,backing.offsetMs,backing.anchors.map(a=>[a.bar,a.occurrence,a.ratio,a.audioMs]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3]),
  [backing.mix.gain,backing.mix.pan,backing.mix.mute,backing.mix.solo],backing.referenceSync?[backing.referenceSync.entryAudioMs,backing.referenceSync.exitAudioMs]:null,backingProcessingKey(backing.processing),
]:null);

export interface DocumentState extends BuiltDocument { documentId:DocumentId; revision:number; snapshot: ProjectSnapshot; documentEpoch:number; busy: boolean; error: string | null;
  /** The edited document differed from one rebuilt from its history, and the rebuilt one was put in its place (shown as a quiet note until the next edit). */
  repaired?:boolean;
  /** How many of the newest edits could not be replayed and were taken back to keep the document usable (shown until the next edit). */
  takenBack?:number }

/** What an action that waited for the check gets when the document was closed meanwhile: not a failure to show, only the end of that work. */
export class DocumentClosedError extends Error {constructor(){super('The document was closed.');this.name='DocumentClosedError';}}

/** The most edits one automatic take-back goes through when the document cannot be rebuilt (each costs a native undo and a rebuild attempt). */
const MAX_TAKE_BACK=16;

export class DocumentController {
  private state: DocumentState;
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private pendingActions=0;
  private undone:EditCommand[]=[];
  private referenceBinding:ReferenceWaveformBinding|null=null;
  private referenceMetadata:{binding:ReferenceWaveformBinding;assetId:string;durationMs:number}|null=null;
  /** Edits applied in place since the document was last checked against a rebuild from its history. */
  /** The edit count a score had when an edit applied in place made it, so the next undo knows the edit it takes back is the one that can be taken back in place. */
  private marks=new WeakMap<model.Score,number>();
  /** The score object known to equal a rebuild from the history: the one a full build made, or one a check found equal. A settings edit keeps the score object, so it keeps what was or was not known about it. */
  private verifiedScore:model.Score|null=null;private verifyTimer:ReturnType<typeof setTimeout>|null=null;private verifyRun=0;
  /** Playback or a count-in is running: the idle check does not start, and one that runs stops (a swap would stop playback, and its slices would stall the moving cursor). */
  private verifyHeld=false;
  /**
   * What the check replays from: a detached copy of a document that was a real rebuild (or was compared with one and found equal), at the edit count it had.
   * `lazyCheckpoint` is a real rebuild that is the open document and has not been edited in place yet; it is copied just before the first edit in place touches it.
   */
  private checkpoint:Checkpoint|null=null;
  private lazyCheckpoint:{built:BuiltDocument;project:ProjectSnapshot['project'];canRedo:boolean}|null=null;
  private closed=false;
  /** Why the document cannot be used (it could not be rebuilt after native changed it), as the alert shows it: every action but Undo and closing refuses. */
  private broken:string|null=null;
  private healing=false;
  /** The edits taken back since the document broke (what the user is told once it is whole again). */
  private takenBackWhileBroken=0;

  private constructor(private bridge: NativeBridge, record:DocumentSnapshot, private beforeChange: BeforeChange, private isWorkspaceTransitioning:()=>boolean, built:BuiltDocument, takenBack=0) {
    this.verifyRecord(record);
    this.state={...record,...built,documentEpoch:0,busy:false,error:null,...(takenBack?{takenBack}:{})};
    this.adoptRebuilt(this.state);
  }
  static async create(bridge: NativeBridge, beforeChange: BeforeChange = () => {},initial?:DocumentSnapshot,isWorkspaceTransitioning:()=>boolean=()=>false) {
    let record=initial ?? await bridge.snapshot();
    await admitDocumentBase(record.snapshot.project);
    let built:BuiltDocument,takenBack=0;
    try {built=buildDocument(record.snapshot.project,record.snapshot.canRedo);}
    catch(error) {
      // A saved history that does not replay (an edit that an older or buggier build let in): the document opens at the last edit that does, the rest is taken back
      // (it stays in native's redo stack, and nothing is written to the file until the user saves).
      const opened=await DocumentController.openAtLastReplayableEdit(bridge,record,error);
      record=opened.record;built=opened.built;takenBack=opened.takenBack;
    }
    return new DocumentController(bridge,record,beforeChange,isWorkspaceTransitioning,built,takenBack);
  }
  /** The longest prefix of the history that replays (found by bisection: a prefix that fails makes every longer one fail), and the document taken back to it. Throws the original error when not even the base opens. */
  private static async openAtLastReplayableEdit(bridge:NativeBridge,record:DocumentSnapshot,error:unknown):Promise<{record:DocumentSnapshot;built:BuiltDocument;takenBack:number}> {
    const project=record.snapshot.project,edits=projectCommands(project);
    const replays=(count:number)=>{try{buildDocument({...project,edits:edits.slice(0,count)},true);return true;}catch{return false;}};
    if(!edits.length||!replays(0))throw error;
    let good=0,bad=edits.length;
    while(bad-good>1){const middle=(good+bad)>>1;if(replays(middle))good=middle;else bad=middle;}
    let current=record;
    for(let remaining=edits.length-good;remaining>0;remaining--){
      current=await bridge.undo(current.revision);
      if(current.documentId!==bridge.documentId)throw new Error('The native response belongs to a different document.');
    }
    return {record:current,built:buildDocument(current.snapshot.project,current.snapshot.canRedo),takenBack:edits.length-good};
  }
  private message(key:MessageKey,params?:Record<string,string|number>):string {return getMessage(getResolvedLanguage(),key,params);}
  /** Whether the document could not be rebuilt after native changed it, and has not been made whole again. */
  isBroken():boolean {return this.broken!==null;}
  private verifyRecord(record:DocumentSnapshot) {
    if(record.documentId!==this.bridge.documentId) throw new Error('The native response belongs to a different document.');
  }
  hasPendingActions() { return this.pendingActions>0; }
  cancelAsset(token: string) { return this.bridge.cancelAsset(token); }
  whenIdle():Promise<void> { return this.tail; }
  getState = () => this.state;
  setBeforeChange(handler: BeforeChange) { this.beforeChange=handler; }
  setReferenceWaveformBridge(bridge:NativeBackingWaveformBridge):()=>void {
    const binding={bridge};this.referenceBinding=binding;this.referenceMetadata=null;
    return ()=>{if(this.referenceBinding===binding){this.referenceBinding=null;this.referenceMetadata=null;}};
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<DocumentState>) { this.state={...this.state,...change};registerLiveDocument(this.state.snapshot.project,this.state); for (const listener of this.listeners) listener(); }
  private run<T>(action: () => Promise<T>,allowTransition=false,allowBroken=false): Promise<T> {
    if(this.broken&&!allowBroken) return Promise.reject(new Error(this.message('document.broken_refused')));
    if(!allowTransition && this.isWorkspaceTransitioning()) return Promise.reject(new Error('Wait for the current workspace transition to finish.'));
    this.cancelVerify();
    this.pendingActions++;
    const job=this.tail.then(async()=>{
      // The alert of a broken document stays: no action clears it, and one that was queued before the break is refused when its turn comes.
      this.update({busy:true,error:this.broken});
      try {
        if(this.broken&&!allowBroken)throw new Error(this.message('document.broken_refused'));
        return await action();
      }
      catch(error) { this.update({error:this.broken??(error instanceof Error ? error.message : String(error))}); throw error; }
      finally { this.pendingActions--;this.update({busy:this.hasPendingActions()});if(this.pendingActions===0&&this.isUnverified())this.scheduleVerify(); }
    });
    this.tail=job.then(()=>{},()=>{}); return job;
  }
  /** Stops a check that runs on the side, or waits for its time: something else is going to happen to the document. A check an action itself asked for (export, copy) is not stopped by actions queued behind it. */
  private cancelVerify() {this.verifyRun++;if(this.verifyTimer!==null){clearTimeout(this.verifyTimer);this.verifyTimer=null;}}
  /** The document is going away: nothing is checked or scheduled for it any more. */
  dispose() {this.closed=true;this.cancelVerify();this.checkpoint=null;this.lazyCheckpoint=null;}
  private isUnverified():boolean {return this.state.score!==this.verifiedScore;}
  /** Whether the document is known to equal a rebuild from the file and the history. */
  isVerified():boolean {return !this.isUnverified();}
  private markVerified():void {this.verifiedScore=this.state.score;}
  /** The open document is a real rebuild (a full build just made it): it is known to equal one, and is kept to be copied for a checkpoint before it is edited in place. */
  private adoptRebuilt(built:BuiltDocument) {
    this.verifiedScore=built.score;this.checkpoint=null;
    this.lazyCheckpoint={built:{...built},project:this.state.snapshot.project,canRedo:this.state.snapshot.canRedo};
  }
  /** Copies the real rebuild that is the open document before anything edits it in place (what is kept then is the copy, which nothing edits). */
  private detachCheckpoint() {
    const lazy=this.lazyCheckpoint;if(!lazy)return;
    this.lazyCheckpoint=null;
    try {this.checkpoint=makeCheckpoint(lazy.project,cloneDocument(lazy.built),lazy.canRedo);} catch(error) {this.checkpoint=null;console.warn(`No checkpoint could be made: ${error instanceof Error?error.message:String(error)}`);}
  }
  /** The checkpoint a check of the open document can replay from, or null (the check then replays from the file). A checkpoint above the end of the history, or of another one, is dropped. */
  private usableCheckpoint(live:DocumentState):Checkpoint|null {
    this.detachCheckpoint();
    if(this.checkpoint&&!checkpointFits(this.checkpoint,live.snapshot.project,live.snapshot.canRedo))this.checkpoint=null;
    return this.checkpoint;
  }
  /** Playback or a count-in starts (true) or ends (false): the idle check waits, and one that runs stops, until it ends. A check an action asked for (export, copy) is not held. */
  holdVerification(held:boolean) {
    if(this.verifyHeld===held)return;
    this.verifyHeld=held;
    if(held)this.cancelVerify();
    else if(this.pendingActions===0&&this.isUnverified())this.scheduleVerify();
  }
  /** The check starts once the edits stop, and starts over with the next one; while playback runs it waits (`holdVerification` re-arms it). It never runs with actions queued: the queue re-arms it when it empties. */
  private scheduleVerify(delay=idleVerification.afterMs) {
    this.cancelVerify();
    if(delay<=0||this.closed)return;
    this.verifyTimer=setTimeout(()=>{
      this.verifyTimer=null;
      if(this.closed||this.pendingActions>0)return;
      if(this.verifyHeld)return;
      void this.verifyNow().catch(()=>{});
    },delay);
  }
  /**
   * Compares the document, when it holds edits applied in place that nobody compared, with a rebuild from the file and the history (replayed from a checkpoint
   * when there is one, and always through the full edit path), in steps that let typing go first; on a difference the document is replaced by a rebuild made in
   * one piece. Resolves false when something else began meanwhile (the check is then wanted again later). `owned` is a check an action asked for: other
   * actions queued behind it do not stop it.
   */
  async verifyNow(pause:()=>Promise<void>=yieldToInput,owned=false):Promise<boolean> {
    if(!this.isUnverified())return true;
    if(this.closed)return false;
    const run=owned?-1:++this.verifyRun,live=this.state;
    const cancelled=()=>this.closed||(!owned&&run!==this.verifyRun)||this.state.score!==live.score||this.state.revision!==live.revision;
    const from=this.usableCheckpoint(live);
    let result:Awaited<ReturnType<typeof verifyEditStepwise>>;
    try {result=await verifyEditStepwise(live.snapshot.project,live,live.snapshot.canRedo,pause,cancelled,from??undefined);}
    catch(error) {
      // A replay that threw is no answer: the rebuild in one piece decides (and a checkpoint that led here is not trusted again).
      this.checkpoint=null;result={problem:`the replay failed: ${error instanceof Error?error.message:String(error)}`,rebuilt:live};
    }
    if(!result||cancelled())return false;
    editStats.verified++;
    if(!result.problem){
      // The replayed document is detached from the open one, and equal to it: it is what the next check starts from.
      this.checkpoint=makeCheckpoint(live.snapshot.project,result.rebuilt,live.snapshot.canRedo);this.markVerified();return true;
    }
    // The stepwise rebuild can be disturbed by what runs between its steps, and a replay from a checkpoint rests on a copy, so neither decides: a rebuild from the
    // file made in one piece does, and it is the one that replaces the document if the two differ.
    let whole:BuiltDocument;
    try {whole=buildDocument(live.snapshot.project,live.snapshot.canRedo);}
    catch(error) {this.fail(error);return false;}
    const problem=compareDocuments(live,whole);
    if(problem){
      editStats.mismatches++;console.error(`Edit in place differs from a full rebuild: ${problem}`);
      forgetPreview();this.update({...whole,repaired:true});this.adoptRebuilt(whole);
    } else {
      console.warn(`The stepwise check disagreed (${result.problem}) and a rebuild in one piece did not.`);
      this.checkpoint=makeCheckpoint(live.snapshot.project,whole,live.snapshot.canRedo);this.markVerified();
    }
    return true;
  }
  /**
   * Resolves the state once it is verified (or rebuilt): what is exported or copied reads this, never an edit nobody has compared with a rebuild. The check is made in
   * slices that let input go first (not when the window is hidden, where timers are throttled to a crawl); after a few interrupted tries it is made in one piece.
   */
  private async settled(): Promise<DocumentState> {
    const hidden=typeof document!=='undefined'&&document.visibilityState==='hidden';
    for(let attempt=0;this.isUnverified()&&!this.closed&&this.broken===null&&attempt<3;attempt++)await this.verifyNow(hidden?async()=>{}:yieldAfter(),true);
    if(this.broken!==null)throw new Error(this.broken);
    if(this.isUnverified()&&!this.closed){
      // One uninterrupted rebuild from the file, compared with the open document.
      let whole:BuiltDocument;
      try {whole=buildDocument(this.state.snapshot.project,this.state.snapshot.canRedo);} catch(error) {this.fail(error);throw new Error(this.broken!);}
      const problem=compareDocuments(this.state,whole);
      if(problem){editStats.mismatches++;console.error(`Edit in place differs from a full rebuild: ${problem}`);forgetPreview();this.update({...whole,repaired:true});this.adoptRebuilt(whole);}
      else {this.checkpoint=makeCheckpoint(this.state.snapshot.project,whole,this.state.snapshot.canRedo);this.markVerified();}
    }
    if(this.closed&&this.isUnverified())throw new DocumentClosedError();
    return this.state;
  }
  verified():Promise<DocumentState> {return this.run(()=>this.settled());}
  /**
   * The document could not be rebuilt after native changed it, so what is shown is not what native holds. The failure is the same every time and the newest
   * edits caused it, so the newest edits are taken back at once (native undo, then a rebuild), up to a small bound; only if that does not make the document
   * whole is it left broken, where Undo takes edits back one by one and Close leaves without saving. Nothing is saved, exported or edited while it is broken.
   */
  private fail(error:unknown) {
    const reason=error instanceof Error?error.message:String(error);
    if(this.broken===null)this.takenBackWhileBroken=0;
    this.broken=this.message('document.broken',{reason});this.update({error:this.broken});
    if(this.healing||this.closed)return;
    this.healing=true;
    void this.run(()=>this.healBroken(),true,true).catch(()=>{}).finally(()=>{this.healing=false;});
  }
  /** One native undo, then a rebuild of what native now holds: the rebuilt document, or null when it still cannot be rebuilt (or there is nothing left to take back). */
  private async takeBackOne():Promise<BuiltDocument|null> {
    const removed=this.state.snapshot.project.edits.at(-1);if(!removed)return null;
    const record=await this.bridge.undo(this.state.revision);this.verifyRecord(record);
    this.undone.push(removed);this.takenBackWhileBroken++;this.update({...record});
    try {return buildDocument(record.snapshot.project,record.snapshot.canRedo);} catch {return null;}
  }
  /** The document is whole again after edits were taken back: the rebuilt one is the open document, verified, and the user is told. */
  private adoptHealed(built:BuiltDocument) {
    this.beforeChange();forgetPreview();
    this.broken=null;
    this.update({...built,repaired:false,takenBack:this.takenBackWhileBroken,error:null});this.adoptRebuilt(this.state);
  }
  /** Takes back the newest edits, one after another and only as far as the edits made since the last checkpoint (and at most `MAX_TAKE_BACK`), until the document rebuilds. */
  private async healBroken():Promise<void> {
    if(this.broken===null)return;
    const known=this.checkpoint?.index??(this.lazyCheckpoint?projectCommands(this.lazyCheckpoint.project).length:0);
    const limit=Math.max(1,Math.min(MAX_TAKE_BACK,projectCommands(this.state.snapshot.project).length-known));
    try {
      for(let attempt=0;attempt<limit;attempt++){
        const built=await this.takeBackOne();
        if(built){this.adoptHealed(built);return;}
        if(!this.state.snapshot.project.edits.length)return;
      }
    } catch(error) {console.warn(`Edits could not be taken back: ${error instanceof Error?error.message:String(error)}`);}
    this.update({error:this.broken});
  }
  private async saveNow(saveAs: boolean) {
    const record=await this.bridge.saveProject(saveAs,this.state.revision);
    if (!record) return false;
    this.verifyRecord(record);this.update(record); return true;
  }
  private async canLeave() {
    // A broken document is closed without asking: the question offers to save, and what would be saved cannot be rebuilt.
    if (this.broken!==null) return true;
    if (!this.state.snapshot.dirty) return true;
    const choice=await this.bridge.askUnsaved(this.state.score.title || 'Untitled',this.state.snapshot.path);
    return choice==='discard' || (choice==='save' && await this.saveNow(false));
  }
  private needsPartialCapoMark() {
    const project=this.state.snapshot.project;
    return !!this.bridge.markPartialCapo&&project.base.kind==='file'&&!this.state.snapshot.canRedo&&appliesFilePartialCapo(project)&&project.partialCapo!==true&&(scoreHasMusicXmlTimeCarry(this.state.score)||scoreUsesTempoUnits(this.state.score)||this.state.score.tracks.some(track=>track.staves.some(staff=>getPartialCapo(staff))));
  }
  private async editNow(command:EditCommand,asset?:AssetCandidate) {
    let candidate:BuiltDocument|null=null;let record:DocumentSnapshot;let inPlace=false;
    try {
      // The first edit of a file that holds a partial capo fixes that it applies, before the edit that depends on it.
      const mark=this.needsPartialCapoMark();
      const current=mark?{...this.state.snapshot.project,partialCapo:true as const}:this.state.snapshot.project;
      const project=asset?{...current,assets:{...current.assets,[asset.assetId]:asset.info}}:current;
      if(command.type==='pasteMusic'){const problem=pasteGestureProblem(this.state.score,command);if(problem)throw new Error(problem);}
      // A note, rest, duration or beat is checked on copies of the voices it touches and applied to the built document once native has recorded it; anything else (and anything unusual) rebuilds the document from the file and the history first.
      if(!mark&&!asset&&canEditInPlace(this.state,command)){checkEditInPlace(this.state,command,projectCommands(project).length);inPlace=true;}
      else {candidate=previewEdit(project,command,mark?{...this.state,snapshot:{...this.state.snapshot,project:current}}:this.state);forgetPreview();editStats.full++;}
      if(candidate){
        if(command.type==='setBacking'&&backingState(command.backing)===backingState(effectiveAudioSettings(this.state.snapshot.project,this.state).backing)){
          if(asset)await this.bridge.cancelAsset(asset.token);return;
        }
        if(command.type==='replaceTempoAutomations'&&tempoState(candidate.score)===tempoState(this.state.score))return;
        await this.admitReferenceTiming(candidate);
      }
      if(mark){const marked=await this.bridge.markPartialCapo!(this.state.revision);this.verifyRecord(marked);this.update({...marked});}
      record=await this.bridge.applyEdit(command,this.state.revision,asset?.token);
      this.verifyRecord(record);
    } catch(error) {
      if(asset) {try {await this.bridge.cancelAsset?.(asset.token);} catch {}}
      throw error;
    }
    let rebuilt=false;
    if(inPlace) {
      // Native has the edit. The checked edit is applied to the built document now; should that fail all the same, the document is rebuilt from what native holds.
      this.detachCheckpoint();
      try {candidate=editInPlace(this.state,command,projectCommands(this.state.snapshot.project).length);editStats.inPlace++;this.marks.set(candidate.score,record.snapshot.project.edits.length);}
      catch(error) {
        editStats.healed++;console.warn(`Edit in place failed after it was checked: ${error instanceof Error?error.message:String(error)}`);
        candidate=this.rebuildOrFail(record,error);forgetPreview();rebuilt=true;
      }
    }
    const scoreBefore=this.state.score;
    if(!isSettingsEdit(command))this.beforeChange(barMapOfEdit(command,this.state.score.masterBars.length)??undefined);
    this.undone=[];this.update({...record,repaired:false,takenBack:0,score:candidate!.score,settings:candidate!.settings,embeddedBacking:candidate!.embeddedBacking,embeddedBackingSettings:candidate!.embeddedBackingSettings,sourceMixes:candidate!.sourceMixes});
    // Only a score a full build made is known to equal a rebuild. A settings edit keeps the score object, and with it what is known of it. The check of an edit made in place is armed when the queue empties.
    if(inPlace&&!rebuilt)this.checkInPlace();
    else if(this.state.score!==scoreBefore)this.adoptRebuilt(this.state);
  }
  /** Compares the document after an edit in place with a full rebuild when asked to (see `editCheck`); on a difference the rebuilt document is used. A check that could not be made leaves the document unchecked. */
  private checkInPlace() {
    if(!shouldCheckEdit())return;
    const live=this.state;
    try {
      const {problem,rebuilt}=compareWithRebuild(live.snapshot.project,live,live.snapshot.canRedo);
      editStats.verified++;
      if(!problem){if(rebuilt)this.checkpoint=makeCheckpoint(live.snapshot.project,rebuilt,live.snapshot.canRedo);this.markVerified();return;}
      editStats.mismatches++;console.error(`Edit in place differs from a full rebuild: ${problem}`);
      const whole=rebuilt??buildDocument(live.snapshot.project,live.snapshot.canRedo);
      forgetPreview();this.update({...whole});this.adoptRebuilt(whole);
    } catch(error) {console.warn(`The sampled check could not be made: ${error instanceof Error?error.message:String(error)}`);}
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
    return this.run(async()=>{await this.settled();return makeMusicClip(this.state.score,requested,mode);});
  }
  /** `anchor` is the lane the range was shaped on (the cursor's); a range edge inside a note there is cut, inside a note of another lane it is refused, as it always was. */
  cutMusic(selection:MusicSelection,mode:ClipboardMode,anchor?:VoiceAddress):Promise<MusicClip> {
    const requested=structuredClone(selection);
    return this.run(async()=>{
      await this.settled();
      const scope=musicClipSelection(this.state.score,requested,mode);
      if(mode==='singleTrack'&&scope.kind==='range'){const lane=anchorLane(scope.range,anchor);if(rangeCutsSoundingBeat(this.state.score,scope.range,scope.range.lanes.filter(other=>other!==lane)))throw cutRefusal('editor.cut_refusal_other_lane');}
      const clip=makeMusicClip(this.state.score,scope,mode,{cut:true});
      const bars=scope as Extract<MusicSelection,{kind:'bars'}>;
      // Only a range edge inside a held note needs the splitting cut; every other cut keeps the edit older builds read.
      await this.editNow(mode==='multiTrack'?{type:'removeMeasures',firstBar:bars.firstBar,lastBar:bars.lastBar}:eraseCommandFor(this.state.score,scope,anchor));
      return clip;
    });
  }
  /** What an undo or redo applied in place falls back to when it fails after native has done it: the document is rebuilt from what native now holds. */
  private rebuildFrom(record:DocumentSnapshot,why:unknown) {
    editStats.healed++;console.warn(`Undo or redo in place failed: ${why instanceof Error?why.message:String(why)}`);
    const built=this.rebuildOrFail(record,why);
    forgetPreview();this.update({...record,...built,repaired:false});this.adoptRebuilt(this.state);
  }
  /**
   * The document rebuilt from what native holds, after native already acted and the in-place path failed. When that fails as well the document shown is behind native
   * and cannot be trusted: it is marked broken (every action but saving and closing refuses, and the error is shown) and the failure is thrown.
   */
  private rebuildOrFail(record:DocumentSnapshot,why:unknown):BuiltDocument {
    try {return buildDocument(record.snapshot.project,record.snapshot.canRedo);}
    catch(error) {
      this.update({...record});this.fail(error);
      throw new Error(this.broken!);
    }
  }
  undo() { return this.run(async()=>{
    // A broken document is made whole by taking edits back: native undoes the newest edit, then the document is rebuilt from what native holds.
    if(this.broken!==null){
      const built=await this.takeBackOne();
      if(built)this.adoptHealed(built);
      else this.update({error:this.broken});
      return;
    }
    const project=this.state.snapshot.project,removed=project.edits.at(-1);if(!removed)return;
    const settingsOnly=isSettingsEdit(removed),previous={...project,edits:project.edits.slice(0,-1)};
    // The edit that was applied in place last is taken back in place too, when the document still is what that edit made and the file's partial capo does not depend on the redo it leaves.
    const quick=!settingsOnly&&this.marks.get(this.state.score)===project.edits.length&&canUndoInPlace(this.state.score)&&appliesFilePartialCapo(previous,true)===appliesFilePartialCapo(project,this.state.snapshot.canRedo);
    const built=quick?null:settingsOnly?replayDocumentSettings(previous,this.state):buildDocument(previous,true);
    const record=await this.bridge.undo(this.state.revision);this.verifyRecord(record);if(!settingsOnly)this.beforeChange(barMapOfUndo(removed,this.state.score.masterBars.length)??undefined);
    this.undone.push(removed);
    if(quick){
      this.detachCheckpoint();
      try {
        const next=undoInPlace(this.state);if(canUndoInPlace(next.score))this.marks.set(next.score,project.edits.length-1);
        editStats.inPlace++;this.update({...record,score:next.score,repaired:false,takenBack:0});
      } catch(error) {this.rebuildFrom(record,error);}
    } else {
      const before=this.state.score;this.update({...record,...built!,repaired:false,takenBack:0});
      if(this.state.score!==before)this.adoptRebuilt(this.state);
    }
  },false,true); }
  redo() { return this.run(async()=>{
    const restored=this.state.snapshot.redoEdit ?? this.undone.at(-1);
    if(!restored){if(this.state.snapshot.canRedo)throw new Error('The next redo command is unavailable; reopen the document.');return;}
    const project={...this.state.snapshot.project,edits:[...this.state.snapshot.project.edits,restored]},settingsOnly=isSettingsEdit(restored);
    let quick=!settingsOnly&&canEditInPlace(this.state,restored)&&appliesFilePartialCapo(project,false)===appliesFilePartialCapo(this.state.snapshot.project,this.state.snapshot.canRedo);
    // A redo that is applied in place is checked first, on copies, as an edit is; one the check refuses is rebuilt like any other.
    if(quick){try{checkEditInPlace(this.state,restored,projectCommands(this.state.snapshot.project).length);}catch{quick=false;}}
    const built=quick?null:settingsOnly?replayDocumentSettings(project,this.state):buildDocument(project);
    const record=await this.bridge.redo(this.state.revision);this.verifyRecord(record);if(!settingsOnly)this.beforeChange(barMapOfEdit(restored,this.state.score.masterBars.length)??undefined);
    this.undone.pop();
    if(quick){
      this.detachCheckpoint();
      try {
        const next=editInPlace(this.state,restored,projectCommands(this.state.snapshot.project).length);this.marks.set(next.score,project.edits.length);
        editStats.inPlace++;this.update({...record,score:next.score,repaired:false,takenBack:0});
      } catch(error) {this.rebuildFrom(record,error);}
    } else {
      const before=this.state.score;this.update({...record,...built!,repaired:false,takenBack:0});
      if(this.state.score!==before)this.adoptRebuilt(this.state);
    }
  }); }
  /** Finalizes or unfinalizes the document. A lock change is not an edit, so history and the redo stack stay as they are. */
  setLock(lock:DocumentLock|null) { return this.run(async()=>{
    const current=this.state,wanted=lock?.kind??null;
    if((current.snapshot.project.lock?.kind??null)===wanted)return;
    const record=await this.bridge.setLock(lock,current.revision);this.verifyRecord(record);
    this.update({...record});
  }); }
  /**
   * Gives or withdraws the password to edit, or sets, changes or removes a password. Not an edit: history and the redo
   * stack stay as they are. A refused password rejects without leaving the controller's own error behind, because the
   * dialog that asked shows the reason beside the field.
   */
  protect(request:ProtectionRequest) {
    return this.run(async()=>{
      if(!this.bridge.protect)throw new Error('Password protection is unavailable.');
      const record=await this.bridge.protect(request,this.state.revision);this.verifyRecord(record);
      this.update({...record});
    }).catch(error=>{this.update({error:null});throw error;});
  }
  /** Refused while the document is broken: what would be written cannot be rebuilt. */
  save(saveAs = false) { return this.run(()=>this.saveNow(saveAs)); }
  export() { return this.run(async()=>{
    // What the file cannot keep is worked out first, so the user is asked once, with it, and not after confirming.
    await this.settled();
    const refusal=gpExportRefusal(this.state.score);if(refusal)throw new Error(refusal);
    const losses=gpLosses(this.state.score);
    if(!await (losses.length?this.bridge.confirmExport(gpWarning(losses)):this.bridge.confirmExport()))return;
    const current=this.state,settings=effectiveAudioSettings(current.snapshot.project,current),backing=settings.backing;
    const bytes=backing&&backing.assetId!=='embedded'?await this.bridge.readBackingAsset(backing.assetId,current.revision):current.embeddedBacking;
    const score=projectGpDocument({score:current.score,settings,bytes,selection:{tracks:current.score.tracks.map((_,index)=>index),range:null},backing:true});
    await this.bridge.exportGp(exportGp(score),current.revision);
  }); }
  requestClose() { return this.run(()=>this.canLeave(),true,true); }
  /** Only for the test seam below. */
  private adoptVerifiedScore(score:model.Score) {this.update({score});this.adoptRebuilt(this.state);}
}

/** Test seam: puts `score` in the place of the controller's score and says it is known to equal a rebuild. It exists only where tests run. */
export function adoptVerifiedScoreForTest(controller:DocumentController,score:model.Score):void {
  if((import.meta as {env?:{MODE?:string}}).env?.MODE!=='test')throw new Error('This is a test seam.');
  (controller as unknown as {adoptVerifiedScore(score:model.Score):void}).adoptVerifiedScore(score);
}
