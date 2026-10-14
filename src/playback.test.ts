import { expect, it, vi } from 'vitest';
import { midi, model, Settings, synth } from '@coderline/alphatab';
import { buildScore } from './engine';
import { blankProject } from './project';
import { PlaybackController, type PlaybackApi } from './playback';

function setup(unsafeMidiSubscription=false) {
  const event=<T,>()=>{const listeners=new Set<(value:T)=>void>();return {on:(fn:(value:T)=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},off:(fn:(value:T)=>void)=>{listeners.delete(fn);},trigger:(value:T)=>{for(const fn of listeners)fn(value);}};};
  let score=buildScore(blankProject());
  score.masterBars[1].timeSignatureNumerator=3;score.masterBars[1].timeSignatureDenominator=8;
  const voice=score.tracks[0].staves[0].bars[1].voices[0];voice.beats.splice(3,1);for(const beat of voice.beats)beat.duration=8;
  score=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings());
  const state=event<synth.PlayerStateChangedEventArgs>();
  const ready=event<void>();
  const file=new midi.MidiFile();const gen=new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file));gen.generate();
  const api:PlaybackApi={score,tickCache:gen.tickLookup,tracks:score.tracks,tickPosition:0,playbackRange:null,isLooping:false,
    playbackSpeed:1,metronomeVolume:0,isReadyForPlayback:true,
    playerReady:ready,midiLoaded:event<synth.PositionChangedEventArgs>(),playerStateChanged:state,playerPositionChanged:event<synth.PositionChangedEventArgs>(),error:event<Error>(),
    play:vi.fn(()=>true),pause:vi.fn(),stop:vi.fn(),renderScore:vi.fn(),changeTrackMute:vi.fn(),changeTrackSolo:vi.fn(),changeTrackVolume:vi.fn()};
  if(unsafeMidiSubscription)api.midiLoaded.on=()=>{throw new Error('Upstream cached MIDI getter recurses');};
  return {score,api,player:new PlaybackController(api),file,state,ready};
}
it('can initialize without subscribing to the unsafe cached MIDI emitter',()=>{expect(()=>setup(true)).not.toThrow();});
it('uses actual MIDI ticks for first/last seeking and inclusive variable-meter looping',()=>{
  const {score,api,player,file}=setup();expect(file.tracks.length).toBeGreaterThan(0);
  player.seekToMeasure(0);expect(api.tickPosition).toBe(0);
  player.seekToMeasure(3);expect(api.tickPosition).toBe(api.tickCache!.getMasterBar(score.masterBars[3]).start);
  player.setLoop(1,2);expect(api.playbackRange).toEqual({startTick:3840,endTick:9120});expect(api.isLooping).toBe(true);
  player.clearLoop();expect(api.playbackRange).toBeNull();expect(api.isLooping).toBe(false);
  expect(()=>player.setLoop(3,1)).toThrow();expect(()=>player.seekToMeasure(99)).toThrow();
});
it('uses engine events for play state and maps speed and mixer controls',()=>{
  const {api,player,score,state}=setup();player.play();expect(player.getState().playing).toBe(false);
  state.trigger(new synth.PlayerStateChangedEventArgs(synth.PlayerState.Playing,false));
  expect(player.getState().playing).toBe(true);player.setSpeed(50);expect(api.playbackSpeed).toBe(.5);
  player.setMute(0,true);player.setSolo(0,true);player.setTrackVolume(0,.7);player.setMetronome(.3);
  expect(api.changeTrackMute).toHaveBeenCalledWith([score.tracks[0]],true);
  expect(api.changeTrackSolo).toHaveBeenCalledWith([score.tracks[0]],true);
  expect(api.changeTrackVolume).toHaveBeenCalledWith([score.tracks[0]],.7);
  expect(api.metronomeVolume).toBe(.3);
});
it('stops before score/MIDI replacement and clears stale loop positions',()=>{
  const {api,player,score}=setup();const order:string[]=[];
  api.stop=()=>order.push('stop');api.renderScore=()=>order.push('render');
  player.setLoop(0,1);player.beforeScoreChange();player.replaceScore(score);
  expect(order).toEqual(['stop','render']);expect(api.playbackRange).toBeNull();
  player.destroy();
});
it('keeps a ready player ready when selecting tracks or changing display options',()=>{
  const {player,score}=setup();expect(player.getState().ready).toBe(true);
  player.replaceScore(score);expect(player.getState().ready).toBe(true);
});
it('restores session mixer settings after edited MIDI becomes ready',()=>{
  const {player,api,ready}=setup();player.setMute(0,true);player.setSolo(0,true);player.setTrackVolume(0,.5);
  vi.mocked(api.changeTrackMute).mockClear();vi.mocked(api.changeTrackSolo).mockClear();vi.mocked(api.changeTrackVolume).mockClear();
  Object.assign(api,{score:buildScore(blankProject())});ready.trigger();
  expect(api.changeTrackMute).toHaveBeenCalledWith([api.score!.tracks[0]],true);
  expect(api.changeTrackSolo).toHaveBeenCalledWith([api.score!.tracks[0]],true);
  expect(api.changeTrackVolume).toHaveBeenCalledWith([api.score!.tracks[0]],.5);
});
