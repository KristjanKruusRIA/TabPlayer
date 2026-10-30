import type { AlphaTabApi, model, synth } from '@coderline/alphatab';
import { effectiveAudioSettings, trackIdentity, type BuiltDocument } from '../engine';
import { completeSound, defaultEffects, defaultMix, masterProblem, soundProblem } from '../document-settings';
import type { ChannelMix, EditCommand, MasterSettings, TrackSound } from '../edit-types';
import type { BeatTarget,ProjectView } from '../project';
import type { MusicSelection } from '../editor/range-types';
import type { AuditionNote, AuditionRequest, NativeAudioBridge, NativeAudioStatus, TransportCommand } from './bridge';
import type { AuditionSource } from './audition';
import { preparePlan,preparePlanFromScore } from './plan';
import type { MeasureOccurrence,PlanNote, PlaybackPlan, PlaybackState } from './types';
import { DEFAULT_PRACTICE,type PracticeSettings,type PracticeStatus } from './practice-types';
import { practiceForBacking,validatePractice } from './practice';
import { cursorPlaybackChoices,selectionPlaybackChoices,requireCursorChoice,requirePassageChoice } from './selection-playback';
import type { ScheduledNotes } from '../instruments/focus';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './selection-playback-types';
import type { BackingScoreSelection,BackingTimeline } from './backing-waveform-types';
import {applyReferenceSyncPlan,referenceTimingKey} from './reference-sync';
import { focusedSettings,type TrackFocus } from './focus';

let nextGeneration=0;
function practiceKey(settings:PracticeSettings){const tempo=settings.tempo;return JSON.stringify([tempo.kind,tempo.kind==='relative'?[tempo.ratio]:tempo.kind==='fixed'?[tempo.bpm]:[tempo.start,tempo.end,tempo.step,tempo.repetitions],settings.metronome.enabled,settings.metronome.volume,settings.metronome.visual,settings.countIn.bars,settings.countIn.betweenLoops]);}
function idlePractice(settings:PracticeSettings):PracticeStatus {return {settings:structuredClone(settings),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:settings.tempo.kind==='relative'?settings.tempo.ratio:settings.tempo.kind==='progressive'?settings.tempo.start:1,currentBpm:0,pulse:null};}

type Options={bridge:NativeAudioBridge;onEdit:(edit:EditCommand)=>void|Promise<void>;preparePlan?:typeof preparePlan};
export class NativePlaybackController {
  private state:PlaybackState={ready:false,playing:false,time:0,endTime:0,measure:0,speed:100,metronome:false,practice:idlePractice(DEFAULT_PRACTICE),practicePending:false,practiceNotice:null,range:null,loop:null,error:null};
  private listeners=new Set<()=>void>();private view:AlphaTabApi|null=null;private cleanupView:()=>void=()=>{};
  private unlisten:()=>void=()=>{};private subscription:Promise<void>;private destroyed=false;private suppressHandler=false;private viewPlaying=false;
  // Focus is session-only: it changes what native audio plays, never the saved mix or the project.
  private requested:{project:ProjectView;built:BuiltDocument;documentEpoch:number;playbackResumeEpoch:number}|null=null;
  private trackFocus:TrackFocus|null=null;private preview:{track:string;sound:TrackSound}|null=null;private mixPending=false;private loaded:{project:ProjectView;documentEpoch:number;playbackResumeEpoch:number}|null=null;
  private built:BuiltDocument|null=null;private plan:PlaybackPlan|null=null;private authoredPlan:PlaybackPlan|null=null;private planTimingKey:string|null=null;private lastStatus:NativeAudioStatus|null=null;private operationError:string|null=null;private prepared=false;private preparing=false;private audioSettingsKey:string|null=null;private desiredAudioSettingsKey:string|null=null;private mixQueue:Promise<void>=Promise.resolve();private mixRequest=0;private embeddedSource:string|null=null;
  private documentEpoch:number|undefined;private practice:PracticeSettings=structuredClone(DEFAULT_PRACTICE);private pendingPractice:PracticeSettings|null=null;private hasBacking=false;
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
  private update(change:Partial<PlaybackState>){if(this.destroyed)return;this.state={...this.state,...change};for(const listener of this.listeners)listener();}
  private fail(error:unknown){this.noteMode='stopped';this.pendingNoteTick=undefined;this.operationError=error instanceof Error?error.message:String(error);this.update({error:this.operationError});}
  private receive(status:NativeAudioStatus){
    if(status.generation!==this.generation || this.destroyed)return;
    this.lastStatus=status;
    if(!status.ready || status.error){this.noteMode='stopped';this.pendingNoteTick=undefined;}
    else if((this.noteMode==='waiting' && status.playing)
      || (this.noteMode==='seeking' && (status.playing || Math.abs(status.tick-this.pendingNoteTick!)<1e-6))
      || this.noteMode==='playing' || this.noteMode==='paused'){
      this.noteMode=status.playing?'playing':'paused';this.pendingNoteTick=undefined;
    }
    if(status.ready&&!status.error){this.prepared=true;this.practice=structuredClone(status.practice.settings);}
    if(status.error || (this.pendingPractice && status.ready && practiceKey(status.practice.settings)===practiceKey(this.pendingPractice)))this.pendingPractice=null;
    const occurrence=this.plan?.occurrences.find(o=>status.tick>=o.startTick && status.tick<o.endTick)??this.plan?.occurrences.at(-1);
    this.update({ready:status.ready,playing:status.playing,time:status.seconds*1000,endTime:status.durationSeconds*1000,measure:occurrence?.bar??0,speed:status.practice.effectiveRatio*100,metronome:this.practice.metronome.enabled,practice:{...status.practice,settings:this.practice},practicePending:this.pendingPractice!==null,loop:status.loop,range:status.range,error:status.error??this.operationError});
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
  private send(command:TransportCommand){void this.bridge.command(command).then(()=>{if(command.generation===this.generation){this.operationError=null;this.update({error:null});}}).catch(error=>{if(command.generation===this.generation){if(command.type==='setPractice'){if(this.pendingPractice!==command.settings)return;this.pendingPractice=null;this.update({practicePending:false});}this.fail(error);}});}
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
  loopSelection(selection:MusicSelection,choice:PassagePlaybackChoice){const {score,plan}=this.requireSelectionReady();const selected=requirePassageChoice(selectionPlaybackChoices(score,plan,selection),choice);this.send({type:'setLoop',generation:this.generation,startTick:selected.startTick,endTick:selected.endTick});}
  pause(){this.send({type:'pause',generation:this.generation});}stop(){this.noteMode='stopped';this.pendingNoteTick=undefined;this.update({});this.send({type:'stop',generation:this.generation});}
  private occurrence(bar:number){const found=this.plan?.occurrences.find(o=>o.bar===bar);if(!Number.isInteger(bar)||!found)throw new Error('Select a measure after playback is ready.');return found;}
  private seekToTick(tick:number){this.noteMode='seeking';this.pendingNoteTick=tick;this.operationError=null;this.update({error:this.lastStatus?.error??null});this.send({type:'seekTick',tick,generation:this.generation});}
  seekToMeasure(index:number){this.seekToTick(this.occurrence(index).startTick);}
  setPractice(settings:PracticeSettings){
    validatePractice(settings,this.hasBacking);
    if(this.pendingPractice)throw new Error('Practice settings acknowledgement is pending.');
    if(practiceKey(settings)===practiceKey(this.practice))return;
    const next=structuredClone(settings);this.pendingPractice=next;this.update({practicePending:true,practiceNotice:null});
    this.send({type:'setPractice',settings:next,generation:this.generation});
  }
  exportPracticeRatio():number|null{return this.practice.tempo.kind==='fixed'?null:this.state.practice.effectiveRatio;}
  setSpeed(percent:number){this.setPractice({...this.practice,tempo:{kind:'relative',ratio:percent/100}});}
  setLoop(start:number,end:number){if(end<start)throw new Error('Loop end must follow its start.');this.send({type:'setLoop',startTick:this.occurrence(start).startTick,endTick:this.occurrence(end).endTick,generation:this.generation});}
  clearLoop(){this.send({type:'clearLoop',generation:this.generation});}
  setMetronome(volume:number){this.setPractice({...this.practice,metronome:{...this.practice.metronome,enabled:volume>0,volume}});}
  selectDevice(deviceId:string|null){this.send({type:'selectDevice',deviceId,generation:this.generation});}
  devices(){return this.bridge.devices();}
  deviceId(){return this.lastStatus?.deviceId??null;}
  backingDurationMs(){const seconds=this.lastStatus?.backingDurationSeconds;return seconds==null?undefined:seconds*1000;}
  mix(track:model.Track){const mix=this.built?.settings.mixes[trackIdentity(track)];return mix?{mute:mix.mute,solo:mix.solo,volume:mix.gain,pan:mix.pan}:undefined;}
  private editMix(index:number,patch:Partial<ChannelMix>){const track=this.built?.score.tracks[index];if(!track)throw new Error('Select an existing track.');const id=trackIdentity(track);const mix={...(this.built!.settings.mixes[id]??defaultMix()),...patch};void Promise.resolve(this.options.onEdit({type:'setTrackMix',trackId:id,mix})).catch(error=>this.fail(error));}
  setTrackVolume(index:number,value:number){this.editMix(index,{gain:Math.max(0,Math.min(1,value))});}
  setPan(index:number,value:number){this.editMix(index,{pan:Math.max(-1,Math.min(1,value))});}
  /** The song's master chain as saved, or undefined while it has never been edited. */
  master():MasterSettings|undefined{const master=this.built?.settings.master;return master?structuredClone(master):undefined;}
  /** Saves the master chain as an undoable edit. It settles once the edit has been accepted or refused. */
  setMaster(master:MasterSettings):Promise<void>{
    const problem=masterProblem(master);
    if(problem){const error=new Error(problem);this.fail(error);return Promise.reject(error);}
    return Promise.resolve(this.options.onEdit({type:'setMaster',master:structuredClone(master)})).then(()=>undefined,error=>{this.fail(error);throw error;});
  }
  setMute(index:number,value:boolean){this.editMix(index,{mute:value});}setSolo(index:number,value:boolean){this.editMix(index,{solo:value});}
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
  beforeScoreChange(notifyNative=true){this.generation=++nextGeneration;this.plan=null;this.authoredPlan=null;this.planTimingKey=null;this.notesByTrack.clear();this.noteMode='stopped';this.pendingNoteTick=undefined;this.prepared=false;this.preparing=false;this.audioSettingsKey=null;this.desiredAudioSettingsKey=null;this.mixPending=false;this.mixQueue=Promise.resolve();this.lastStatus=null;this.pendingPractice=null;this.operationError=null;if(notifyNative)this.send({type:'invalidate',generation:this.generation});const practice=idlePractice(this.practice);this.update({ready:false,playing:false,practice,practicePending:false,range:null,loop:null,speed:practice.effectiveRatio*100,metronome:this.practice.metronome.enabled,error:null});}
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
    const documentChanged=this.documentEpoch!==documentEpoch;this.documentEpoch=documentEpoch;this.loaded={project,documentEpoch,playbackResumeEpoch};
    // Focus ends with its document or its track, so an undo that restores the track does not revive it.
    const focused=this.trackFocus;if(focused&&!built.score.tracks.some(track=>trackIdentity(track)===focused.track)){this.trackFocus=null;this.update({});}
    const previewed=this.preview;if(previewed&&!built.score.tracks.some(track=>trackIdentity(track)===previewed.track)){this.preview=null;this.update({});}
    if(documentChanged){this.trackFocus=null;this.preview=null;this.practice=structuredClone(DEFAULT_PRACTICE);this.update({practiceNotice:null});}
    const saved=effectiveAudioSettings(project,built),preview=this.preview;
    const audioSettings=focusedSettings(preview?{...saved,sounds:{...saved.sounds,[preview.track]:preview.sound}}:saved,built.score.tracks.map(trackIdentity),this.trackFocus);this.hasBacking=audioSettings.backing!==null;
    const audioSettingsKey=JSON.stringify([audioSettings.sounds,audioSettings.mixes,audioSettings.backing,audioSettings.master??null]);
    const timingKey=referenceTimingKey(audioSettings.backing);
    const normalized=practiceForBacking(this.practice,this.hasBacking);
    if(normalized.notice){this.practice=normalized.settings;this.update({practiceNotice:normalized.notice});}
    if(!documentChanged && !normalized.notice && this.built?.score===built.score && timingKey===this.planTimingKey && (this.preparing || this.plan&&this.prepared)){
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
    this.beforeScoreChange();const generation=this.generation;this.built=built;this.preparing=true;this.planTimingKey=timingKey;this.desiredAudioSettingsKey=audioSettingsKey;
    try {
      const authored=await (this.options.preparePlan?this.options.preparePlan(project,generation):preparePlanFromScore(built.score,generation));if(generation!==this.generation||this.destroyed)return;
      const plan=applyReferenceSyncPlan(authored,audioSettings.backing);
      const sourceKey=project.base.kind==='file'?project.base.sha256:'blank';
      this.authoredPlan=authored;this.plan=plan;this.update({endTime:plan.playbackEndTick===undefined?plan.durationMs:this.millisecondsAtTick(plan.playbackEndTick,plan)});for(const note of plan.notes){let track=this.notesByTrack.get(note.trackId);if(!track){track=[];this.notesByTrack.set(note.trackId,track);}track.push(note);}
      await this.bridge.prepare(plan,audioSettings,this.embeddedSource===sourceKey?null:built.embeddedBacking,sourceKey,practice);if(generation!==this.generation||this.destroyed)return;this.embeddedSource=sourceKey;this.prepared=true;this.audioSettingsKey=audioSettingsKey;this.operationError=null;
      const status=await this.bridge.status();if(generation!==this.generation||this.destroyed)return;if(status)this.receive(status);
    } catch(error){if(generation===this.generation){this.prepared=false;this.fail(error);}}finally{if(generation===this.generation){this.preparing=false;this.update({});
      if(this.prepared&&this.mixPending&&this.loaded&&this.built){this.mixPending=false;void this.reloadLatest().catch(error=>this.fail(error));}}}
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
  destroy(){this.stop();this.destroyed=true;this.unlisten();this.cleanupView();this.view=null;this.listeners.clear();}
}
