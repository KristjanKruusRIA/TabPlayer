import type { AlphaTabApi, model, synth } from '@coderline/alphatab';
import { effectiveAudioSettings, trackIdentity, type BuiltDocument } from '../engine';
import { defaultMix } from '../document-settings';
import type { ChannelMix, EditCommand } from '../edit-types';
import type { ProjectView } from '../project';
import { nativeAudioBridge, type NativeAudioBridge, type NativeAudioStatus, type TransportCommand } from './bridge';
import { preparePlan } from './plan';
import type { PlaybackPlan, PlaybackState } from './types';

let nextGeneration=0;
type Options={bridge?:NativeAudioBridge;onEdit:(edit:EditCommand)=>void|Promise<void>;preparePlan?:typeof preparePlan};
export class NativePlaybackController {
  private state:PlaybackState={ready:false,playing:false,time:0,endTime:0,measure:0,speed:100,metronome:false,error:null};
  private listeners=new Set<()=>void>();private view:AlphaTabApi|null=null;private cleanupView:()=>void=()=>{};
  private unlisten:()=>void=()=>{};private subscription:Promise<void>;private destroyed=false;private suppressHandler=false;private viewPlaying=false;
  private built:BuiltDocument|null=null;private plan:PlaybackPlan|null=null;private lastStatus:NativeAudioStatus|null=null;private operationError:string|null=null;private prepared=false;private embeddedSource:string|null=null;
  private bridge:NativeAudioBridge;private options:Options;generation=++nextGeneration;
  constructor(options:Options) {
    this.options=options;this.bridge=options.bridge??nativeAudioBridge;
    this.subscription=this.bridge.subscribe(status=>this.receive(status)).then(async remove=>{
      if(this.destroyed){remove();return;}this.unlisten=remove;
      const status=await this.bridge.status();if(this.destroyed)return;
      if(status){nextGeneration=Math.max(nextGeneration,status.generation,status.desiredGeneration??0);this.generation=++nextGeneration;}
    }).catch(error=>this.fail(error));
  }
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(change:Partial<PlaybackState>){if(this.destroyed)return;this.state={...this.state,...change};for(const listener of this.listeners)listener();}
  private fail(error:unknown){this.operationError=error instanceof Error?error.message:String(error);this.update({error:this.operationError});}
  private receive(status:NativeAudioStatus){
    if(status.generation!==this.generation || this.destroyed)return;
    this.lastStatus=status;
    if(status.ready)this.prepared=true;
    const occurrence=this.plan?.occurrences.find(o=>status.tick>=o.startTick && status.tick<o.endTick)??this.plan?.occurrences.at(-1);
    this.update({ready:status.ready,playing:status.playing,time:status.seconds*1000,endTime:status.durationSeconds*1000,measure:occurrence?.bar??0,speed:status.speed*100,metronome:status.metronome,error:status.error??this.operationError});
    const api=this.view;const output=api?.player?.output as synth.IExternalMediaSynthOutput|undefined;
    if(api && output?.updatePosition){
      const prior=this.suppressHandler;this.suppressHandler=true;
      try {
        if(status.playing!==this.viewPlaying){if(status.playing)api.play();else api.pause();this.viewPlaying=status.playing;}
        // Native seconds are the score clock. Clear alphaTab's separate backing map.
        output.updatePosition(status.seconds*1000);
      } finally {this.suppressHandler=prior;}
    }
  }
  private send(command:TransportCommand){void this.bridge.command(command).then(()=>{if(command.generation===this.generation){this.operationError=null;this.update({error:null});}}).catch(error=>{if(command.generation===this.generation)this.fail(error);});}
  play(){this.send({type:'play',generation:this.generation});}pause(){this.send({type:'pause',generation:this.generation});}stop(){this.send({type:'stop',generation:this.generation});}
  private occurrence(bar:number){const found=this.plan?.occurrences.find(o=>o.bar===bar);if(!Number.isInteger(bar)||!found)throw new Error('Select a measure after playback is ready.');return found;}
  seekToMeasure(index:number){this.send({type:'seekTick',tick:this.occurrence(index).startTick,generation:this.generation});}
  setSpeed(percent:number){if(!Number.isFinite(percent)||percent<25||percent>200)throw new Error('Speed must be between 25% and 200%.');this.send({type:'setSpeed',speed:percent/100,generation:this.generation});}
  setLoop(start:number,end:number){if(end<start)throw new Error('Loop end must follow its start.');this.send({type:'setLoop',startTick:this.occurrence(start).startTick,endTick:this.occurrence(end).endTick,generation:this.generation});}
  clearLoop(){this.send({type:'clearLoop',generation:this.generation});}
  setMetronome(volume:number){this.send({type:'setMetronome',enabled:volume>0,generation:this.generation});}
  selectDevice(deviceId:string|null){this.send({type:'selectDevice',deviceId,generation:this.generation});}
  devices(){return this.bridge.devices();}
  deviceId(){return this.lastStatus?.deviceId??null;}
  backingDurationMs(){const seconds=this.lastStatus?.backingDurationSeconds;return seconds==null?undefined:seconds*1000;}
  mix(track:model.Track){const mix=this.built?.settings.mixes[trackIdentity(track)];return mix?{mute:mix.mute,solo:mix.solo,volume:mix.gain,pan:mix.pan}:undefined;}
  private editMix(index:number,patch:Partial<ChannelMix>){const track=this.built?.score.tracks[index];if(!track)throw new Error('Select an existing track.');const id=trackIdentity(track);const mix={...(this.built!.settings.mixes[id]??defaultMix()),...patch};void Promise.resolve(this.options.onEdit({type:'setTrackMix',trackId:id,mix})).catch(error=>this.fail(error));}
  setTrackVolume(index:number,value:number){this.editMix(index,{gain:Math.max(0,Math.min(1,value))});}
  setPan(index:number,value:number){this.editMix(index,{pan:Math.max(-1,Math.min(1,value))});}
  setMute(index:number,value:boolean){this.editMix(index,{mute:value});}setSolo(index:number,value:boolean){this.editMix(index,{solo:value});}
  resetMix(){for(const track of this.built?.score.tracks??[])this.editMix(track.index,defaultMix());}
  beforeScoreChange(){this.generation=++nextGeneration;this.plan=null;this.prepared=false;this.operationError=null;this.send({type:'invalidate',generation:this.generation});this.update({ready:false,playing:false,error:null});}
  replaceScore(score:model.Score,track=0){const prior=this.suppressHandler;this.suppressHandler=true;try{this.view?.renderScore(score,[track]);this.view?.player?.updateSyncPoints([]);}finally{this.suppressHandler=prior;this.viewPlaying=false;}}
  async loadDocument(project:ProjectView,built:BuiltDocument,visibleTrack=0){
    await this.subscription;if(this.destroyed)return;
    if(this.built?.score===built.score && this.plan && this.prepared){const unchanged=this.built.settings===built.settings;this.built=built;if(unchanged)return;try{await this.bridge.setMix(effectiveAudioSettings(project,built),this.generation);this.operationError=null;this.update({error:null});}catch(error){this.fail(error);}this.update({});return;}
    this.beforeScoreChange();const generation=this.generation;this.built=built;this.replaceScore(built.score,visibleTrack);
    try {
      const plan=await (this.options.preparePlan??preparePlan)(project,generation);if(generation!==this.generation||this.destroyed)return;
      const sourceKey=project.base.kind==='file'?project.base.sha256:'blank';
      this.plan=plan;await this.bridge.prepare(plan,effectiveAudioSettings(project,built),this.embeddedSource===sourceKey?null:built.embeddedBacking,sourceKey);if(generation!==this.generation||this.destroyed)return;this.embeddedSource=sourceKey;this.prepared=true;this.operationError=null;
      const status=await this.bridge.status();if(status)this.receive(status);
    } catch(error){if(generation===this.generation){this.prepared=false;this.fail(error);}}
  }
  attachView(api:AlphaTabApi){
    this.cleanupView();this.view=api;this.viewPlaying=false;const controller=this;
    const attach=()=>{
      const output=api.player?.output as synth.IExternalMediaSynthOutput|undefined;if(!output?.updatePosition)return;
      const prior=this.suppressHandler;this.suppressHandler=true;
      try {
        output.handler={get backingTrackDuration(){return controller.plan?.durationMs??0;},get playbackRate(){return controller.state.speed/100;},set playbackRate(value){if(!controller.suppressHandler)controller.setSpeed(value*100);},masterVolume:1,
          seekTo(time){if(!controller.suppressHandler){const tick=controller.tickAtSeconds(time/1000);controller.send({type:'seekTick',tick,generation:controller.generation});}},
          play(){if(!controller.suppressHandler)controller.play();},pause(){if(!controller.suppressHandler)controller.pause();}};
        api.player?.updateSyncPoints([]);
      } finally {this.suppressHandler=prior;}
    };
    api.playerReady.on(attach);attach();this.cleanupView=()=>{api.playerReady.off(attach);const output=api.player?.output as synth.IExternalMediaSynthOutput|undefined;if(output?.updatePosition)output.handler=undefined;};
  }
  private tickAtSeconds(seconds:number){let tick=0,elapsed=0;const tempos=this.plan?.tempos??[];for(let i=0;i<tempos.length;i++){const t=tempos[i];const end=tempos[i+1]?.tick??this.plan!.durationTick;const duration=(end-t.tick)*60/(t.bpm*960);if(seconds<=elapsed+duration)return t.tick+(seconds-elapsed)*t.bpm*960/60;elapsed+=duration;tick=end;}return tick;}
  destroy(){this.stop();this.destroyed=true;this.unlisten();this.cleanupView();this.view=null;this.listeners.clear();}
}
