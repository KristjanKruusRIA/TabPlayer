import type { AlphaTabApi, model, synth } from '@coderline/alphatab';
import '../tremolo-guard';
import { effectiveAudioSettings, trackIdentity, type BuiltDocument } from '../engine';
import { completeSound, defaultEffects, defaultMix, masterProblem, soundProblem } from '../document-settings';
import type { ChannelMix, DrumElementMix, DrumKitElement, DrumKitMix, EditCommand, MasterSettings, TrackSound } from '../edit-types';
import { canonicalDrumKitMix, defaultDrumElement } from './drum-kit';
import type { BeatTarget,ProjectView } from '../project';
import type { MusicSelection } from '../editor/range-types';
import type { AudioDiagnostics, AuditionNote, AuditionRequest, NativeAudioBridge, NativeAudioStatus, TransportCommand } from './bridge';
import type { AuditionSource } from './audition';
import { preparePlan,preparePlanFromScore } from './plan';
import { interpretationsOf } from './interpretation';
import type { MeasureOccurrence,PlanNote, PlaybackPlan, PlaybackState } from './types';
import { DEFAULT_PRACTICE,tonalityOf,type PracticeLoop,type PracticeSettings,type PracticeStatus } from './practice-types';
import { practiceForBacking,validatePractice } from './practice';
import { cursorPlaybackChoices,selectionPlaybackChoices,requireCursorChoice,requirePassageChoice } from './selection-playback';
import type { ScheduledNotes } from '../instruments/focus';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './selection-playback-types';
import type { BackingScoreSelection,BackingTimeline } from './backing-waveform-types';
import {applyReferenceSyncPlan,referenceTimingKey} from './reference-sync';
import { focusedSettings,type TrackFocus } from './focus';
import { keptLoopOf,mapKeptLoop,resolveKeptLoop,type KeptLoop } from './kept-loop';
import type { BarIndexMap } from '../editor/measures-types';

let nextGeneration=0;
function practiceKey(settings:PracticeSettings){const tempo=settings.tempo;return JSON.stringify([tempo.kind,tempo.kind==='relative'?[tempo.ratio]:tempo.kind==='fixed'?[tempo.bpm]:[tempo.start,tempo.end,tempo.step,tempo.repetitions],settings.metronome.enabled,settings.metronome.volume,settings.metronome.visual,settings.metronome.sound??"beep",settings.countIn.bars,settings.countIn.betweenLoops,settings.tonality??0]);}
function idlePractice(settings:PracticeSettings):PracticeStatus {return {settings:structuredClone(settings),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:settings.tempo.kind==='relative'?settings.tempo.ratio:settings.tempo.kind==='progressive'?settings.tempo.start:1,currentBpm:0,pulse:null};}

/** `latestMix` and `latestMaster` read a track's mix and the master from the newest document, which can be ahead of the one last loaded here. */
const mixKey=(mix:ChannelMix|undefined)=>{const m=mix??defaultMix();return JSON.stringify([m.gain,m.pan,m.mute,m.solo,m.drumKit??null,m.midiPort??null]);};
/** Whether the loaded document holds the edit that a dragged mix became: it is another project than the edit began from (a track-selection reload keeps the same one), so the edit or an undo of it has been loaded; or its mix for the track moved off what the edit began from, or is the one heard. */
const mixLanded=(heard:{track:string;mix:ChannelMix;landing:{key:string;project:ProjectView|null}|null},built:BuiltDocument|null,project:ProjectView|null)=>{if(heard.landing===null||!built)return false;if(project!==heard.landing.project)return true;const key=mixKey(built.settings.mixes[heard.track]);return key!==heard.landing.key||key===mixKey(heard.mix);};
/** How long a practice change waits for the native acknowledgement before it falls back to the acknowledged settings. Native's own wait for the callback is 250 ms. */
const PENDING_MS=2500;
type Options={pendingMs?:number;bridge:NativeAudioBridge;onEdit:(edit:EditCommand)=>void|Promise<void>;preparePlan?:typeof preparePlan;latestMix?:(trackId:string)=>ChannelMix|undefined;latestMaster?:()=>MasterSettings|undefined};
export class NativePlaybackController {
  private state:PlaybackState={ready:false,playing:false,time:0,endTime:0,measure:0,speed:100,metronome:false,practice:idlePractice(DEFAULT_PRACTICE),practicePending:false,practiceNotice:null,range:null,loop:null,loopNotice:null,error:null};
  private listeners=new Set<()=>void>();private view:AlphaTabApi|null=null;private cleanupView:()=>void=()=>{};
  private unlisten:()=>void=()=>{};private subscription:Promise<void>;private destroyed=false;private suppressHandler=false;private viewPlaying=false;
  // Focus is session-only: it changes what native audio plays, never the saved mix or the project.
  private requested:{project:ProjectView;built:BuiltDocument;documentEpoch:number;playbackResumeEpoch:number}|null=null;
  private trackFocus:TrackFocus|null=null;private preview:{track:string;sound:TrackSound}|null=null;private mixPreview:{track:string;mix:ChannelMix;landing:{key:string;project:ProjectView|null}|null}|null=null;private mixPending=false;private loaded:{project:ProjectView;documentEpoch:number;playbackResumeEpoch:number}|null=null;
  private built:BuiltDocument|null=null;private plan:PlaybackPlan|null=null;private authoredPlan:PlaybackPlan|null=null;private planTimingKey:string|null=null;private planInterpretationKey='';private lastStatus:NativeAudioStatus|null=null;private operationError:string|null=null;private prepared=false;private preparing=false;private audioSettingsKey:string|null=null;private desiredAudioSettingsKey:string|null=null;private mixQueue:Promise<void>=Promise.resolve();private mixRequest=0;private embeddedSource:string|null=null;
  private documentEpoch:number|undefined;private practice:PracticeSettings=structuredClone(DEFAULT_PRACTICE);private pendingPractice:PracticeSettings|null=null;private pendingTimer:ReturnType<typeof setTimeout>|null=null;/** Steps taken while a change was pending, added up into one key sent once it is acknowledged. */private queuedKey:number|null=null;/** The key a pending request asked for when the score changed under it, passed on to the next prepare. */private carriedKey:number|null=null;/** What a request that timed out asked for, so a late echo of it clears the notice. */private lateKey:string|null=null;/** Counts changes of document, so a view can tell a key that reset with the document from one that was changed. */private documentSerial=0;private hasBacking=false;
  /** The running loop by bars, so it can follow an edit that rebuilds the plan. `awaitingRestore` holds off reading the loop back from native while the rebuilt plan has none yet; `loopLost` is an edit that took the loop's bars with it. */
  private keptLoop:KeptLoop|null=null;private loopLost=false;private awaitingRestore=false;private loopsSending=0;
  private playbackResumeEpoch=0;private floorReadyEpoch=0;private resumeRefresh:Promise<boolean>|null=null;private loadRequest=0;
  private notesByTrack=new Map<string,PlanNote[]>();private noteMode:'stopped'|'waiting'|'seeking'|'playing'|'paused'='stopped';private pendingNoteTick:number|undefined;
  private bridge:NativeAudioBridge;private options:Options;generation=++nextGeneration;
  constructor(options:Options) {
    this.options=options;this.bridge=options.bridge;
    this.subscription=this.bridge.subscribe(status=>this.receive(status)).then(async remove=>{
      if(this.destroyed){remove();return;}this.unlisten=remove;
      const status=await this.bridge.status();if(this.destroyed)return;
      if(status){nextGeneration=Math.max(nextGeneration,status.generation,status.desiredGeneration??0);this.generation=++nextGeneration;}
    }).catch(error=>this.fail(error));
  }
  getState=()=>this.state;
  activeNotes(trackId:string):readonly PlanNote[]{
    const status=this.lastStatus;
    if(status?.practice.countInRemaining || status?.practice.phase==='countIn' || status?.practice.phase==='ended' || this.destroyed || !this.prepared || !this.state.ready || this.state.error || !status || status.generation!==this.generation || this.plan?.generation!==this.generation || (this.noteMode!=='playing' && this.noteMode!=='paused'))return [];
    return (this.notesByTrack.get(trackId)??[]).filter(note=>note.startTick<=status.tick && status.tick<note.endTick);
  }
  /** The track's planned notes and performed beats for previews of the selection or the next beat, with the playback position while a performance is under way. Never throws. */
  scheduledNotes(trackId:string):ScheduledNotes{
    const status=this.lastStatus,plan=this.plan;
    if(this.destroyed || !this.prepared || !this.state.ready || this.state.error || !plan || plan.generation!==this.generation)return {notes:[],beats:[],tick:null,counting:false,loop:null,range:null};
    const live=!!status && status.generation===this.generation && (this.noteMode==='playing' || this.noteMode==='paused') && status.practice.phase!=='ended' && status.tick<(plan.playbackEndTick??plan.durationTick);
    const counting=live && (!!status!.practice.countInRemaining || status!.practice.phase==='countIn');
    return {notes:this.notesByTrack.get(trackId)??[],beats:plan.performedBeats??[],tick:live?status!.tick:null,counting,loop:live?status!.loop:null,range:live?status!.range:null};
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private keyTarget(){return this.queuedKey??(this.pendingPractice?tonalityOf(this.pendingPractice):tonalityOf(this.practice));}
  private update(change:Partial<PlaybackState>){if(this.destroyed)return;this.state={...this.state,...change,keyTarget:this.keyTarget(),documentSerial:this.documentSerial};for(const listener of this.listeners)listener();}
  private fail(error:unknown){this.noteMode='stopped';this.pendingNoteTick=undefined;this.operationError=error instanceof Error?error.message:String(error);this.update({error:this.operationError});}
  private receive(status:NativeAudioStatus){
    if(status.generation!==this.generation || this.destroyed)return;
    this.lastStatus=status;
    if(!this.awaitingRestore&&this.loopsSending===0&&this.plan&&this.built&&status.ready&&!status.error)this.keptLoop=status.loop?keptLoopOf(status.loop,this.plan.occurrences,this.built.score.masterBars.length):null;
    if(!status.ready || status.error){this.noteMode='stopped';this.pendingNoteTick=undefined;}
    else if((this.noteMode==='waiting' && status.playing)
      || (this.noteMode==='seeking' && (status.playing || Math.abs(status.tick-this.pendingNoteTick!)<1e-6))
      || this.noteMode==='playing' || this.noteMode==='paused'){
      this.noteMode=status.playing?'playing':'paused';this.pendingNoteTick=undefined;
    }
    if(status.ready&&!status.error){this.prepared=true;this.practice=structuredClone(status.practice.settings);}
    const acknowledged=!status.error&&this.pendingPractice!==null&&status.ready&&practiceKey(status.practice.settings)===practiceKey(this.pendingPractice);
    const droppedKey=!!status.error&&this.queuedKey!==null;if(status.error){this.clearPending();this.queuedKey=null;}else if(acknowledged)this.clearPending();
    const late=this.lateKey!==null&&status.ready&&!status.error&&practiceKey(status.practice.settings)===this.lateKey;if(late){this.lateKey=null;this.state={...this.state,practiceNotice:null};}
    const occurrence=this.plan?.occurrences.find(o=>status.tick>=o.startTick && status.tick<o.endTick)??this.plan?.occurrences.at(-1);
    this.update({ready:status.ready,playing:status.playing,time:status.seconds*1000,endTime:status.durationSeconds*1000,measure:occurrence?.bar??0,speed:status.practice.effectiveRatio*100,metronome:this.practice.metronome.enabled,practice:{...status.practice,settings:this.practice},practicePending:this.pendingPractice!==null,loop:status.loop,range:status.range,error:status.error??this.operationError,...(droppedKey?{practiceNotice:'key_shift_refused' as const}:{})});
    if(acknowledged)this.sendQueuedKey();
    const api=this.view;const output=api?.player?.output as synth.IExternalMediaSynthOutput|undefined;
    if(api && output?.updatePosition){
      const prior=this.suppressHandler;this.suppressHandler=true;
      try {
        const scorePlaying=status.playing&&status.practice.phase!=='countIn'&&status.practice.countInRemaining===0;
        if(scorePlaying!==this.viewPlaying){if(scorePlaying)api.play();else api.pause();this.viewPlaying=scorePlaying;}
        // Notation retains authored tempos while native playback uses the reference clock.
        output.updatePosition(this.planTimingKey!==null&&this.authoredPlan?this.millisecondsAtTick(status.tick,this.authoredPlan):status.seconds*1000);
      } finally {this.suppressHandler=prior;}
    }
  }
  /** Resolves when the command has completed, whether or not it succeeded. */
  private send(command:TransportCommand):Promise<void>{return this.bridge.command(command).then(()=>{if(command.type==='setPractice')this.armPending(command.settings);if(command.generation===this.generation){this.operationError=null;this.update({error:null});}}).catch(error=>{if(command.generation===this.generation){if(command.type==='setPractice'){if(this.pendingPractice!==command.settings)return;const dropped=this.queuedKey!==null;this.clearPending();this.queuedKey=null;if(dropped||tonalityOf(command.settings)!==tonalityOf(this.practice)){this.update({practicePending:false,practiceNotice:'key_shift_refused'});if(!dropped||tonalityOf(command.settings)!==tonalityOf(this.practice))return;}else this.update({practicePending:false});}this.fail(error);}});}
  private selectionReady(){return !this.destroyed&&!this.preparing&&this.prepared&&this.state.ready&&this.built!==null&&this.plan?.generation===this.generation;}
  private requireSelectionReady(){if(!this.selectionReady())throw new Error('Select a measure after playback is ready.');return {score:this.built!.score,plan:this.plan!};}
  cursorPlaybackChoices(target:BeatTarget):CursorPlaybackChoice[]{if(!this.selectionReady())return [];return cursorPlaybackChoices(this.built!.score,this.plan!,target);}
  selectionPlaybackChoices(selection:MusicSelection):PassagePlaybackChoice[]{if(!this.selectionReady())return [];return selectionPlaybackChoices(this.built!.score,this.plan!,selection);}
  playbackOccurrences():readonly Readonly<MeasureOccurrence>[]{return this.selectionReady()?this.plan!.occurrences:[];}
  backingTimeline():BackingTimeline|null {
    const plan=this.plan;if(this.destroyed||this.preparing||plan?.generation!==this.generation)return null;
    return {generation:plan.generation,durationTick:plan.durationTick,tempos:plan.tempos,occurrences:plan.occurrences};
  }
  backingScoreSelection(target:BeatTarget,selection:MusicSelection|null):BackingScoreSelection {
    const result:BackingScoreSelection={points:[],spans:[]};
    if(!this.backingTimeline()||!this.built)return result;
    const score=this.built.score,plan=this.plan!;
    // Stale editor addresses can outlive a score change; each valid part still remains visible.
    try {
      result.points=cursorPlaybackChoices(score,plan,target).map(choice=>{
        const occurrence=plan.occurrences[choice.occurrenceIndex],tick=choice.startTick;
        const anchor=tick>=occurrence.startTick&&tick<=occurrence.endTick?{bar:occurrence.bar,occurrence:occurrence.occurrence,ratio:(tick-occurrence.startTick)/(occurrence.endTick-occurrence.startTick)}:null;
        return {tick,anchor};
      });
    }catch{}
    if(selection)try{result.spans=selectionPlaybackChoices(score,plan,selection).map(({startTick,endTick})=>({startTick,endTick}));}catch{}
    return result;
  }
  private startRange(startTick:number,endTick:number|null){this.noteMode='waiting';this.pendingNoteTick=undefined;this.update({});this.send({type:'playRange',generation:this.generation,startTick,endTick});}
  play(cursor?:BeatTarget,choice?:CursorPlaybackChoice){
    if(cursor){
      const {score,plan}=this.requireSelectionReady();
      if(!this.state.loop&&(this.state.practice.phase==='idle'||this.state.practice.phase==='ended')){
        const choices=cursorPlaybackChoices(score,plan,cursor),selected=choice??(choices.length===1?choices[0]:undefined);
        if(!selected)throw new Error('Choose a current performed occurrence.');
        this.startRange(requireCursorChoice(choices,selected).startTick,null);return;
      }
    }
    this.noteMode='waiting';this.pendingNoteTick=undefined;this.update({});this.send({type:'play',generation:this.generation});
  }
  playFromCursor(cursor:BeatTarget,choice:CursorPlaybackChoice){const {score,plan}=this.requireSelectionReady();const selected=requireCursorChoice(cursorPlaybackChoices(score,plan,cursor),choice);this.startRange(selected.startTick,null);}
  playSelection(selection:MusicSelection,choice:PassagePlaybackChoice){const {score,plan}=this.requireSelectionReady();const selected=requirePassageChoice(selectionPlaybackChoices(score,plan,selection),choice);this.startRange(selected.startTick,selected.endTick);}
  loopSelection(selection:MusicSelection,choice:PassagePlaybackChoice){const {score,plan}=this.requireSelectionReady();const selected=requirePassageChoice(selectionPlaybackChoices(score,plan,selection),choice);this.loopSet({startTick:selected.startTick,endTick:selected.endTick});this.sendLoop({type:'setLoop',generation:this.generation,startTick:selected.startTick,endTick:selected.endTick});}
  pause(){this.send({type:'pause',generation:this.generation});}stop(){this.noteMode='stopped';this.pendingNoteTick=undefined;this.update({});this.send({type:'stop',generation:this.generation});}
  private occurrence(bar:number){const found=this.plan?.occurrences.find(o=>o.bar===bar);if(!Number.isInteger(bar)||!found)throw new Error('Select a measure after playback is ready.');return found;}
  private seekToTick(tick:number){this.noteMode='seeking';this.pendingNoteTick=tick;this.operationError=null;this.update({error:this.lastStatus?.error??null});this.send({type:'seekTick',tick,generation:this.generation});}
  seekToMeasure(index:number){this.seekToTick(this.occurrence(index).startTick);}
  setPractice(settings:PracticeSettings){
    validatePractice(settings,this.hasBacking);
    if(this.pendingPractice)throw new Error('Practice settings acknowledgement is pending.');
    if(practiceKey(settings)===practiceKey(this.practice))return;
    const next=structuredClone(settings);this.pendingPractice=next;this.lateKey=null;
    this.update({practicePending:true,practiceNotice:null});
    this.send({type:'setPractice',settings:next,generation:this.generation});
  }
  /** A request nobody acknowledges does not hold the controls for ever: once native has answered the command, the wait for the echo is bounded and falls back to the acknowledged settings. Native builds the new renderer inside the command, so the bound does not run while it does. */
  private armPending(next:PracticeSettings){if(this.destroyed||this.pendingPractice!==next||this.pendingTimer!==null)return;this.pendingTimer=setTimeout(()=>this.expirePending(next),this.options.pendingMs??PENDING_MS);}
  private clearPending(){this.pendingPractice=null;if(this.pendingTimer!==null){clearTimeout(this.pendingTimer);this.pendingTimer=null;}}
  private expirePending(next:PracticeSettings){
    if(this.destroyed||this.pendingPractice!==next)return;
    this.clearPending();this.queuedKey=null;this.lateKey=practiceKey(next);
    this.update({practicePending:false,practiceNotice:tonalityOf(next)!==tonalityOf(this.practice)?'key_shift_refused':'practice_unconfirmed'});
  }
  private sendQueuedKey(){
    const queued=this.queuedKey;this.queuedKey=null;
    if(queued===null||queued===tonalityOf(this.practice)){this.update({});return;}
    try{this.setPractice({...this.practice,tonality:queued});}catch(error){this.fail(error);}
  }
  /** The playback key, in semitones from -12 to 12. Asked for while a change is pending, it is kept as the one next request. */
  setKeyShift(target:number){
    if(!Number.isInteger(target)||target<-12||target>12||target===this.keyTarget())return;
    if(this.pendingPractice){this.queuedKey=target===tonalityOf(this.pendingPractice)?null:target;this.update({});return;}
    this.setPractice({...this.practice,tonality:target});
  }
  stepKeyShift(delta:number){this.setKeyShift(this.keyTarget()+delta);}
  exportPracticeRatio():number|null{return this.practice.tempo.kind==='fixed'?null:this.state.practice.effectiveRatio;}
  setSpeed(percent:number){this.setPractice({...this.practice,tempo:{kind:'relative',ratio:percent/100}});}
  setLoop(start:number,end:number){if(end<start)throw new Error('Loop end must follow its start.');const startTick=this.occurrence(start).startTick,endTick=this.occurrence(end).endTick;this.loopSet({startTick,endTick});this.sendLoop({type:'setLoop',startTick,endTick,generation:this.generation});}
  /** A loop the player asked for replaces whatever an edit left behind, and its notice. */
  private loopSet(loop:PracticeLoop|null){this.loopLost=false;this.keptLoop=loop&&this.plan&&this.built?keptLoopOf(loop,this.plan.occurrences,this.built.score.masterBars.length):null;this.update({loopNotice:null});}
  /** Native's own statuses are not read back as the kept loop while a loop command is on its way, since they can still describe the loop before it. */
  private sendLoop(command:TransportCommand){this.loopsSending++;return this.send(command).finally(()=>{this.loopsSending--;});}
  clearLoop(){this.loopSet(null);this.sendLoop({type:'clearLoop',generation:this.generation});}
  setMetronome(volume:number){this.setPractice({...this.practice,metronome:{...this.practice.metronome,enabled:volume>0,volume}});}
  selectDevice(deviceId:string|null){return this.send({type:'selectDevice',deviceId,generation:this.generation});}
  devices(){return this.bridge.devices();}
  diagnostics(){return this.bridge.diagnostics?.()??Promise.resolve({} as AudioDiagnostics);}
  testTone(){return this.bridge.testTone?.()??Promise.resolve();}
  deviceId(){return this.lastStatus?.deviceId??null;}
  backingDurationMs(){const seconds=this.lastStatus?.backingDurationSeconds;return seconds==null?undefined:seconds*1000;}
  /** The track's mix as saved. The newest document wins over the one last loaded, so a control reads back what an edit just saved. */
  mix(track:model.Track){const id=trackIdentity(track),mix=this.options.latestMix?.(id)??this.built?.settings.mixes[id];return mix?{mute:mix.mute,solo:mix.solo,volume:mix.gain,pan:mix.pan,...(mix.drumKit?{drumKit:mix.drumKit}:{})}:undefined;}
  private editMix(index:number,patch:Partial<ChannelMix>){return this.saveMix(index,saved=>({...saved,...patch}));}
  private saveMix(index:number,next:(saved:ChannelMix)=>ChannelMix|null){const track=this.built?.score.tracks[index];if(!track)throw new Error('Select an existing track.');const id=trackIdentity(track),mix=next(this.options.latestMix?.(id)??this.built!.settings.mixes[id]??defaultMix());if(!mix)return Promise.resolve();const from=this.built,fromProject=this.requested?.project??null,heard=this.mixPreview;return Promise.resolve(this.options.onEdit({type:'setTrackMix',trackId:id,mix})).then(()=>this.landMixPreview(heard,from,fromProject),error=>this.endMixPreview(heard).then(()=>this.fail(error)));}
  /** The edit that a dragged mix became was accepted: the preview ends once the player holds a document whose mix for the track is not the one the edit began from (or is the one heard), or at once when it already does, so the sound never steps back to the old mix in between. A reload that leaves the mix alone, such as a track selection, ends nothing. A refusal is told after the saved mix is back, because that reload clears an earlier error. */
  private landMixPreview(heard:typeof this.mixPreview,from:BuiltDocument|null,fromProject:ProjectView|null):Promise<void>|void{if(!heard||this.mixPreview!==heard)return;heard.landing={key:mixKey(from?.settings.mixes[heard.track]),project:fromProject};if(mixLanded(heard,this.built,this.requested?.project??null))return this.endMixPreview(heard);}
  private async endMixPreview(heard:typeof this.mixPreview){if(!heard||this.mixPreview!==heard)return;this.mixPreview=null;this.update({});await this.reloadLatest().catch(error=>this.fail(error));}
  /** Each of these saves one undoable edit and settles once it has been accepted or refused (a refusal is reported through `fail`). */
  setTrackVolume(index:number,value:number){return this.editMix(index,{gain:Math.max(0,Math.min(1,value))});}
  setPan(index:number,value:number){return this.editMix(index,{pan:Math.max(-1,Math.min(1,value))});}
  /** The song's master chain as saved, or undefined while it has never been edited. */
  master():MasterSettings|undefined{const master=this.options.latestMaster?this.options.latestMaster():this.built?.settings.master;return master?structuredClone(master):undefined;}
  /** Saves the master chain as an undoable edit. It settles once the edit has been accepted or refused. */
  setMaster(master:MasterSettings):Promise<void>{
    const problem=masterProblem(master);
    if(problem){const error=new Error(problem);this.fail(error);return Promise.reject(error);}
    return Promise.resolve(this.options.onEdit({type:'setMaster',master:structuredClone(master)})).then(()=>undefined,error=>{this.fail(error);throw error;});
  }
  setMute(index:number,value:boolean){return this.editMix(index,{mute:value});}setSolo(index:number,value:boolean){return this.editMix(index,{solo:value});}
  /** The track's mix with one kit element changed by `patch`, or null when that records nothing: choosing the value an element already has, or one that leaves the kit as it was. Elements all at their defaults leave the kit out. */
  private kitMix(saved:ChannelMix,element:DrumKitElement,patch:Partial<DrumElementMix>):ChannelMix|null{
    const currentKit=saved.drumKit??{},current=currentKit[element]??defaultDrumElement();
    const next:DrumElementMix={
      gain:patch.gain!==undefined?Math.max(0,Math.min(1,patch.gain)):current.gain,
      pan:patch.pan!==undefined?Math.max(-1,Math.min(1,patch.pan)):current.pan,
      mute:patch.mute!==undefined?patch.mute:current.mute,
      solo:patch.solo!==undefined?patch.solo:current.solo,
    };
    if(next.gain===current.gain&&next.pan===current.pan&&next.mute===current.mute&&next.solo===current.solo)return null;
    const kit=canonicalDrumKitMix({...currentKit,[element]:next}),{drumKit:_dropped,...rest}=saved;
    return kit?{...rest,drumKit:kit}:rest;
  }
  private percussionTrack(index:number){const track=this.built?.score.tracks[index];if(!track)throw new Error('Select an existing track.');if(!track.isPercussion)throw new Error('Select a percussion track.');return track;}
  /** Saves one kit element's level, pan, mute or solo as one undoable edit. It settles once the edit has been accepted or refused, and records nothing when the value is the one it already has. */
  setDrumElement(index:number,element:DrumKitElement,patch:Partial<DrumElementMix>):Promise<void>{this.percussionTrack(index);return this.saveMix(index,saved=>this.kitMix(saved,element,patch));}
  setDrumVolume(index:number,element:DrumKitElement,value:number){return this.setDrumElement(index,element,{gain:value});}
  setDrumPan(index:number,element:DrumKitElement,value:number){return this.setDrumElement(index,element,{pan:value});}
  setDrumMute(index:number,element:DrumKitElement,value:boolean){return this.setDrumElement(index,element,{mute:value});}
  setDrumSolo(index:number,element:DrumKitElement,value:boolean){return this.setDrumElement(index,element,{solo:value});}
  /** Plays a kit element with `patch` on top while its fader or knob is dragged, as `previewMix` does for a track; it edits nothing. Null ends it. */
  previewDrumElement(index:number,element:DrumKitElement,patch:Partial<DrumElementMix>|null):Promise<void>{
    if(!patch)return this.previewMix(index,null);
    this.percussionTrack(index);
    const id=trackIdentity(this.built!.score.tracks[index]),saved=this.options.latestMix?.(id)??this.built!.settings.mixes[id]??defaultMix();
    const heard=this.kitMix(saved,element,patch)??saved,{drumKit,...rest}=heard;
    return this.previewMix(index,{...rest,drumKit} as Partial<ChannelMix>);
  }
  /** Plays a track's mix with `patch` on top while a fader or knob is dragged, as the player applies a mix change on the running plan; it edits nothing. Null ends it and goes back to the saved mix. */
  async previewMix(index:number,patch:Partial<ChannelMix>|null){
    if(patch){
      const track=this.built?.score.tracks[index];if(!track)throw new Error('Select an existing track.');
      const id=trackIdentity(track),saved=this.options.latestMix?.(id)??this.built!.settings.mixes[id]??defaultMix();
      this.mixPreview={landing:null,track:id,mix:{...saved,...patch,gain:Math.max(0,Math.min(1,patch.gain??saved.gain)),pan:Math.max(-1,Math.min(1,patch.pan??saved.pan))}};
    } else if(this.mixPreview)this.mixPreview=null;
    else return;
    this.update({});
    await this.reloadLatest();
  }
  /** The focused track (by identity) and amount, from -1 (unfocused) to 1 (focused), or null when off. */
  focus():TrackFocus|null{return this.trackFocus?{...this.trackFocus}:null;}
  /** Focuses a track by identity, so a selection resolved against a newer score cannot land on another track. */
  async setFocus(trackId:string,amount:number){
    if(!this.built?.score.tracks.some(track=>trackIdentity(track)===trackId))throw new Error('Select an existing track.');
    if(!Number.isFinite(amount)||Math.abs(amount)>1)throw new Error('Focus must be between -100% and 100%.');
    this.trackFocus=amount===0?null:{track:trackId,amount};this.update({});
    await this.reloadLatest();
  }
  /** The sound being previewed on a track for this session, or null. */
  soundPreview():{track:string;sound:TrackSound}|null{return this.preview?{track:this.preview.track,sound:structuredClone(this.preview.sound)}:null;}
  /** Plays `sound` on a track (by identity) in place of its saved sound without editing the document; null ends the preview. */
  async previewSound(trackId:string,sound:TrackSound|null){
    if(sound){
      if(!this.built?.score.tracks.some(track=>trackIdentity(track)===trackId))throw new Error('Select an existing track.');
      const problem=soundProblem(sound);if(problem)throw new Error(problem);
      this.preview={track:trackId,sound:structuredClone(completeSound(sound))};
    } else if(this.preview?.track===trackId)this.preview=null;
    else return;
    this.update({});
    await this.reloadLatest();
  }
  /** Sends the sounds to the native player again, so it resolves each cabinet response afresh. Importing or removing a response leaves the document as it was, so nothing else would: the player would go on with the cabinet it had, while an export resolves the library anew. */
  async refreshSounds(){this.desiredAudioSettingsKey=null;await this.reloadLatest();}
  /** Loads the most recently requested document again, so a session change made while that load waits cannot bring back an older one. */
  private async reloadLatest(){const latest=this.requested;if(latest&&this.loaded)await this.loadDocument(latest.project,latest.built,0,latest.documentEpoch,latest.playbackResumeEpoch);}
  /**
   * Plays `notes` through a track's own sound without touching playback. The sound, mix and program are the ones prepare uses
   * (including a sound being previewed); `latest` supplies a document newer than the one last loaded. It needs no prepared
   * plan, never throws, and does nothing when the bridge cannot audition.
   */
  audition(source:AuditionSource,notes:AuditionNote[],durationMs:number,latest?:{project:ProjectView;built:BuiltDocument}):void {
    try {
      const audition=this.bridge.audition;if(this.destroyed||!audition||!notes.length)return;
      let base:Omit<AuditionRequest,'notes'|'durationMs'>;
      if('program' in source)base={voice:completeSound({voiceId:null,presetId:'gm',effects:defaultEffects()}),program:source.program,percussion:false,mix:defaultMix()};
      else {
        const document=latest??this.requested;if(!document)return;
        const track=document.built.score.tracks.find(item=>trackIdentity(item)===source.trackId);if(!track)return;
        const settings=effectiveAudioSettings(document.project,document.built),preview=this.preview;
        const sound=preview?.track===source.trackId?preview.sound:settings.sounds[source.trackId]??{voiceId:null,presetId:'gm' as const,effects:defaultEffects()};
        base={voice:completeSound(structuredClone(sound)),program:track.playbackInfo.program,percussion:track.isPercussion,mix:structuredClone(settings.mixes[source.trackId]??defaultMix())};
      }
      void Promise.resolve(audition.call(this.bridge,{...base,notes,durationMs})).catch(()=>{});
    } catch {/* An audition is a courtesy; a failure never reaches the editor. */}
  }
  resetMix(){for(const track of this.built?.score.tracks??[])this.editMix(track.index,defaultMix());}
  /** `bars` says where an edit moved the bars, so a running loop follows them; without it the bars are taken to be where they were. */
  beforeScoreChange(notifyNative=true,bars?:BarIndexMap){if(bars&&this.keptLoop){const mapped=mapKeptLoop(this.keptLoop,bars);if(!mapped)this.loopLost=true;this.keptLoop=mapped;}if((this.pendingPractice||this.queuedKey!==null)&&this.keyTarget()!==tonalityOf(this.practice))this.carriedKey=this.keyTarget();this.generation=++nextGeneration;this.plan=null;this.authoredPlan=null;this.planTimingKey=null;this.notesByTrack.clear();this.noteMode='stopped';this.pendingNoteTick=undefined;this.prepared=false;this.preparing=false;this.audioSettingsKey=null;this.desiredAudioSettingsKey=null;this.mixPending=false;this.mixQueue=Promise.resolve();this.lastStatus=null;this.clearPending();this.queuedKey=null;this.operationError=null;if(notifyNative)this.send({type:'invalidate',generation:this.generation});const practice=idlePractice(this.practice);this.update({ready:false,playing:false,practice,practicePending:false,range:null,loop:null,loopNotice:null,speed:practice.effectiveRatio*100,metronome:this.practice.metronome.enabled,error:null});}
  setRenderedScore(score:model.Score,tracks:number[]):void{if(this.destroyed)return;const prior=this.suppressHandler;this.suppressHandler=true;try{this.view?.renderScore(score,tracks);this.view?.player?.updateSyncPoints([]);}finally{this.suppressHandler=prior;this.viewPlaying=false;}}
  replaceScore(score:model.Score,track=0){this.setRenderedScore(score,[track]);}
  async loadDocument(project:ProjectView,built:BuiltDocument,_visibleTrack=0,documentEpoch=0,playbackResumeEpoch=0){
    if(!this.requested||playbackResumeEpoch>=this.requested.playbackResumeEpoch)this.requested={project,built,documentEpoch,playbackResumeEpoch};
    await this.subscription;if(this.destroyed)return;
    if(playbackResumeEpoch<this.playbackResumeEpoch)return;
    // Supersede loads waiting for the floor, without canceling an identical preparing plan.
    const loadRequest=++this.loadRequest;
    while(playbackResumeEpoch>this.playbackResumeEpoch || this.floorReadyEpoch!==playbackResumeEpoch){
      if(playbackResumeEpoch>this.playbackResumeEpoch || !this.resumeRefresh){
        this.playbackResumeEpoch=playbackResumeEpoch;
        this.keptLoop=null;this.loopLost=false;this.awaitingRestore=false;
        // Another document starts at the original key: reset before the idle status below is built from it.
        if(this.documentEpoch!==documentEpoch){this.practice=structuredClone(DEFAULT_PRACTICE);this.documentSerial++;}
        this.beforeScoreChange(false);this.update({time:0,endTime:0,measure:0});const generation=this.generation;
        const refresh=this.bridge.status().then(status=>{
          if(this.destroyed||generation!==this.generation||playbackResumeEpoch!==this.playbackResumeEpoch)return false;
          if(status)nextGeneration=Math.max(nextGeneration,status.generation,status.desiredGeneration??0);
          this.floorReadyEpoch=playbackResumeEpoch;return true;
        }).catch(error=>{if(!this.destroyed&&generation===this.generation)this.fail(error);return false;}).finally(()=>{if(this.resumeRefresh===refresh)this.resumeRefresh=null;});
        this.resumeRefresh=refresh;
      }
      const ready=await this.resumeRefresh;
      if(this.destroyed||playbackResumeEpoch!==this.playbackResumeEpoch||loadRequest!==this.loadRequest)return;
      if(!ready&&this.operationError)return;
    }
    if(this.destroyed||playbackResumeEpoch!==this.playbackResumeEpoch)return;
    let carriedFrom:number|null=null;
    const documentChanged=this.documentEpoch!==documentEpoch;this.documentEpoch=documentEpoch;this.loaded={project,documentEpoch,playbackResumeEpoch};
    // Focus ends with its document or its track, so an undo that restores the track does not revive it.
    const focused=this.trackFocus;if(focused&&!built.score.tracks.some(track=>trackIdentity(track)===focused.track)){this.trackFocus=null;this.update({});}
    if(this.mixPreview&&mixLanded(this.mixPreview,built,project))this.mixPreview=null;
    const mixed=this.mixPreview;if(mixed&&!built.score.tracks.some(track=>trackIdentity(track)===mixed.track))this.mixPreview=null;
    const previewed=this.preview;if(previewed&&!built.score.tracks.some(track=>trackIdentity(track)===previewed.track)){this.preview=null;this.update({});}
    if(documentChanged){this.keptLoop=null;this.loopLost=false;this.awaitingRestore=false;this.trackFocus=null;this.preview=null;this.mixPreview=null;this.practice=structuredClone(DEFAULT_PRACTICE);this.carriedKey=null;this.update({practiceNotice:null,documentSerial:++this.documentSerial});}
    else if(this.carriedKey!==null){carriedFrom=tonalityOf(this.practice);this.practice={...this.practice,tonality:this.carriedKey};this.carriedKey=null;}
    const saved=effectiveAudioSettings(project,built),preview=this.preview,mixHeard=this.mixPreview;
    const heard={...saved,...(preview?{sounds:{...saved.sounds,[preview.track]:preview.sound}}:{}),...(mixHeard?{mixes:{...saved.mixes,[mixHeard.track]:mixHeard.mix}}:{})};
    const audioSettings=focusedSettings(preview||mixHeard?heard:saved,built.score.tracks.map(trackIdentity),this.trackFocus);this.hasBacking=audioSettings.backing!==null;
    const audioSettingsKey=JSON.stringify([audioSettings.sounds,audioSettings.mixes,audioSettings.backing,audioSettings.master??null]);
    // The saved interpretations shape the plan itself, so a change re-plans like a change of reference timing.
    const interpretations=interpretationsOf(saved.mixes),interpreted=Object.keys(interpretations).length>0;
    const timingKey=referenceTimingKey(audioSettings.backing),interpretationKey=interpreted?JSON.stringify(interpretations):'';
    const normalized=practiceForBacking(this.practice,this.hasBacking);
    if(normalized.notice){this.practice=normalized.settings;this.update({practiceNotice:normalized.notice});}
    if(!documentChanged && !normalized.notice && this.built?.score===built.score && timingKey===this.planTimingKey && interpretationKey===this.planInterpretationKey && (this.preparing || this.plan&&this.prepared)){
      this.built=built;if(audioSettingsKey===this.desiredAudioSettingsKey)return;
      // A mix or focus change during preparation is sent once it finishes, rather than restarting it.
      if(this.preparing){this.mixPending=true;return;}
      if(!this.preparing){
        const generation=this.generation,request=++this.mixRequest;this.desiredAudioSettingsKey=audioSettingsKey;
        const pending=this.mixQueue.then(async()=>{
          if(generation!==this.generation||this.destroyed)return;
          try{await this.bridge.setMix(audioSettings,generation);if(generation!==this.generation||this.destroyed)return;this.audioSettingsKey=audioSettingsKey;if(request===this.mixRequest){this.operationError=null;this.update({error:null});}}
          catch(error){if(generation!==this.generation||this.destroyed)return;if(request===this.mixRequest){this.desiredAudioSettingsKey=this.audioSettingsKey;this.fail(error);}}
        });
        this.mixQueue=pending;await pending;return;
      }
    }
    const practice=structuredClone(this.practice);
    this.awaitingRestore=this.keptLoop!==null||this.loopLost;
    this.beforeScoreChange();const generation=this.generation;this.built=built;this.preparing=true;this.planTimingKey=timingKey;this.planInterpretationKey=interpretationKey;this.desiredAudioSettingsKey=audioSettingsKey;
    try {
      const authored=await (this.options.preparePlan?(interpreted?this.options.preparePlan(project,generation,interpretations):this.options.preparePlan(project,generation)):(interpreted?preparePlanFromScore(built.score,generation,interpretations):preparePlanFromScore(built.score,generation)));if(generation!==this.generation||this.destroyed)return;
      const plan=applyReferenceSyncPlan(authored,audioSettings.backing);
      const sourceKey=project.base.kind==='file'?project.base.sha256:'blank';
      this.authoredPlan=authored;this.plan=plan;this.update({endTime:plan.playbackEndTick===undefined?plan.durationMs:this.millisecondsAtTick(plan.playbackEndTick,plan)});for(const note of plan.notes){let track=this.notesByTrack.get(note.trackId);if(!track){track=[];this.notesByTrack.set(note.trackId,track);}track.push(note);}
      const embedded=this.embeddedSource===sourceKey?null:built.embeddedBacking;
      try{await this.bridge.prepare(plan,audioSettings,embedded,sourceKey,practice);}
      catch(error){
        // A key carried over an edit that native refuses must not leave the score unplayable (the key buttons wait for a prepared score): try again once at the acknowledged key and say so.
        if(carriedFrom===null||generation!==this.generation||this.destroyed)throw error;
        this.practice={...this.practice,tonality:carriedFrom};this.update({practiceNotice:'key_shift_refused'});
        await this.bridge.prepare(plan,audioSettings,embedded,sourceKey,{...practice,tonality:carriedFrom});
      }
      if(generation!==this.generation||this.destroyed)return;this.embeddedSource=sourceKey;this.prepared=true;this.audioSettingsKey=audioSettingsKey;this.operationError=null;
      const status=await this.bridge.status();if(generation!==this.generation||this.destroyed)return;if(status)this.receive(status);
      await this.restoreLoop(generation);
    } catch(error){if(generation===this.generation){this.prepared=false;this.keptLoop=null;this.loopLost=false;this.fail(error);}}finally{if(generation===this.generation){this.awaitingRestore=false;this.preparing=false;this.update({});
      if(this.prepared&&this.mixPending&&this.loaded&&this.built){this.mixPending=false;void this.reloadLatest().catch(error=>this.fail(error));}}}
  }
  /** Arms the loop again on the rebuilt plan, or says it could not be placed. Native playback still owns the loop; this only sends the same command a person would. */
  private async restoreLoop(generation:number){
    const kept=this.keptLoop,lost=this.loopLost;this.loopLost=false;
    if(!kept&&!lost){this.awaitingRestore=false;return;}
    const plan=this.plan,built=this.built,loop=kept&&plan&&built?resolveKeptLoop(kept,plan.occurrences,built.score.masterBars.length):null;
    if(!loop){this.awaitingRestore=false;this.keptLoop=null;this.update({loopNotice:'cleared'});return;}
    // Statuses stay unread until native has answered, so one that still shows no loop cannot drop the kept one.
    try{await this.send({type:'setLoop',generation,startTick:loop.startTick,endTick:loop.endTick});if(generation===this.generation&&this.keptLoop===kept&&plan&&built)this.keptLoop=keptLoopOf(loop,plan.occurrences,built.score.masterBars.length)??kept;}finally{if(generation===this.generation)this.awaitingRestore=false;}
  }
  attachView(api:AlphaTabApi){
    this.cleanupView();this.view=api;this.viewPlaying=false;const controller=this;
    const attach=()=>{
      if(this.destroyed || this.view!==api)return;
      const output=api.player?.output as synth.IExternalMediaSynthOutput|undefined;if(!output?.updatePosition)return;
      const prior=this.suppressHandler;this.suppressHandler=true;
      try {
        output.handler={get backingTrackDuration(){return controller.authoredPlan?.durationMs??0;},get playbackRate(){return controller.state.speed/100;},set playbackRate(value){if(!controller.suppressHandler)controller.setSpeed(value*100);},masterVolume:1,
          seekTo(time){if(!controller.suppressHandler)controller.seekToTick(controller.tickAtSeconds(time/1000));},
          play(){if(!controller.suppressHandler)controller.play();},pause(){if(!controller.suppressHandler)controller.pause();}};
        api.player?.updateSyncPoints([]);
      } finally {this.suppressHandler=prior;}
    };
    api.playerReady.on(attach);attach();this.cleanupView=()=>{api.playerReady.off(attach);const output=api.player?.output as synth.IExternalMediaSynthOutput|undefined;if(output?.updatePosition)output.handler=undefined;};
  }
  private millisecondsAtTick(tick:number,plan:PlaybackPlan){let elapsed=0;for(let i=0;i<plan.tempos.length;i++){const tempo=plan.tempos[i],end=plan.tempos[i+1]?.tick??plan.durationTick;if(tick<=end)return elapsed+(tick-tempo.tick)*60000/(tempo.bpm*960);elapsed+=(end-tempo.tick)*60000/(tempo.bpm*960);}return elapsed;}
  private tickAtSeconds(seconds:number){let tick=0,elapsed=0;const tempos=this.authoredPlan?.tempos??[];for(let i=0;i<tempos.length;i++){const t=tempos[i];const end=tempos[i+1]?.tick??this.authoredPlan!.durationTick;const duration=(end-t.tick)*60/(t.bpm*960);if(seconds<=elapsed+duration)return t.tick+(seconds-elapsed)*t.bpm*960/60;elapsed+=duration;tick=end;}return tick;}
  destroy(){this.stop();this.destroyed=true;this.clearPending();this.unlisten();this.cleanupView();this.view=null;this.listeners.clear();}
}
