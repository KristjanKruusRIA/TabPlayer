import { type AlphaTabApi, type model, synth } from '@coderline/alphatab';
export type PlaybackApi=Pick<AlphaTabApi,'score'|'tracks'|'tickCache'|'tickPosition'|'playbackRange'|'isLooping'|'playbackSpeed'|'metronomeVolume'|'isReadyForPlayback'|'play'|'pause'|'stop'|'renderScore'|'changeTrackMute'|'changeTrackSolo'|'changeTrackVolume'|'playerReady'|'midiLoaded'|'playerStateChanged'|'playerPositionChanged'|'error'>;
export interface PlaybackState {ready:boolean;playing:boolean;time:number;endTime:number;measure:number;speed:number;metronome:boolean;error:string|null}

export class PlaybackController {
  private state:PlaybackState={ready:false,playing:false,time:0,endTime:0,measure:0,speed:100,metronome:false,error:null};
  private listeners=new Set<()=>void>();private cleanup:Array<()=>void>=[];
  private mixes=new Map<number,{mute?:boolean;solo?:boolean;volume?:number}>();
  constructor(private api:PlaybackApi) {
    const ready=()=>{if(api.isReadyForPlayback)for(const [index,mix] of this.mixes){const track=api.score?.tracks[index];if(!track)continue;
      if(mix.mute!==undefined)api.changeTrackMute([track],mix.mute);if(mix.solo!==undefined)api.changeTrackSolo([track],mix.solo);if(mix.volume!==undefined)api.changeTrackVolume([track],mix.volume);
    }this.update({ready:api.isReadyForPlayback});};
    const status=(e:synth.PlayerStateChangedEventArgs)=>this.update({playing:e.state===synth.PlayerState.Playing});
    const position=(e:synth.PositionChangedEventArgs)=>this.update({time:e.currentTime,endTime:e.endTime,
      measure:api.tickCache?.masterBars.find(b=>e.currentTick>=b.start && e.currentTick<b.end)?.masterBar.index ?? 0});
    const error=(e:unknown)=>this.update({error:e instanceof Error?e.message:String(e),ready:false});
    // 1.8.4's cached midiLoaded subscription reads a recursive upstream getter.
    // playerReady reports when both MIDI and the SoundFont are ready.
    api.playerReady.on(ready);api.playerStateChanged.on(status);api.playerPositionChanged.on(position);api.error.on(error);
    this.cleanup=[()=>api.playerReady.off(ready),()=>api.playerStateChanged.off(status),()=>api.playerPositionChanged.off(position),()=>api.error.off(error)];
    ready();
  }
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(change:Partial<PlaybackState>){this.state={...this.state,...change};for(const listener of this.listeners)listener();}
  play(){this.api.play();} pause(){this.api.pause();} stop(){this.api.stop();}
  private bar(index:number) {
    const bar=this.api.score?.masterBars[index];
    if(!Number.isInteger(index) || !bar || !this.api.tickCache)throw new Error('Select a measure after playback is ready.');
    return this.api.tickCache.getMasterBar(bar);
  }
  seekToMeasure(index:number){this.api.tickPosition=this.bar(index).start;}
  setSpeed(percent:number){if(!Number.isFinite(percent)||percent<25||percent>200)throw new Error('Speed must be between 25% and 200%.');this.api.playbackSpeed=percent/100;this.update({speed:this.api.playbackSpeed*100});}
  setLoop(start:number,end:number){if(end<start)throw new Error('Loop end must follow its start.');const first=this.bar(start),last=this.bar(end);this.api.playbackRange={startTick:first.start,endTick:last.end};this.api.isLooping=true;}
  clearLoop(){this.api.playbackRange=null;this.api.isLooping=false;}
  private track(index:number){const track=this.api.score?.tracks[index];if(!track)throw new Error('Select an existing track.');return track;}
  mix(index:number){return this.mixes.get(index);}
  resetMix(){this.mixes.clear();}
  removeTrackMix(index:number){this.mixes=new Map([...this.mixes].filter(([i])=>i!==index).map(([i,mix])=>[i>index?i-1:i,mix]));}
  setTrackVolume(index:number,value:number){const volume=Math.max(0,Math.min(1,value));this.api.changeTrackVolume([this.track(index)],volume);this.mixes.set(index,{...this.mixes.get(index),volume});}
  setMute(index:number,value:boolean){this.api.changeTrackMute([this.track(index)],value);this.mixes.set(index,{...this.mixes.get(index),mute:value});}
  setSolo(index:number,value:boolean){this.api.changeTrackSolo([this.track(index)],value);this.mixes.set(index,{...this.mixes.get(index),solo:value});}
  setMetronome(value:number){this.api.metronomeVolume=Math.max(0,Math.min(1,value));this.update({metronome:this.api.metronomeVolume>0});}
  beforeScoreChange(){this.stop();this.clearLoop();this.update({ready:false,error:null});}
  replaceScore(score:model.Score,track=0){const changed=this.api.score!==score;if(changed)this.update({ready:false,error:null});this.api.renderScore(score,[track]);if(!changed)this.update({ready:this.api.isReadyForPlayback});}
  destroy(){for(const remove of this.cleanup)remove();this.listeners.clear();}
}
