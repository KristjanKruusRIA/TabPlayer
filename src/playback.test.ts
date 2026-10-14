import { expect, it, vi } from 'vitest';
import { midi, model, Settings, synth } from '@coderline/alphatab';
import { buildScore, previewEdit } from './engine';
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
    playbackSpeed:1,metronomeVolume:0,isReadyForPlayback:true,player:{setChannelMute:vi.fn(),setChannelSolo:vi.fn()},
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
it('reports metronome state to a remounted transport',()=>{const {player}=setup();player.setMetronome(.4);expect(player.getState().metronome).toBe(true);player.setMetronome(0);expect(player.getState().metronome).toBe(false);});

function realMixer() {
  const test=setup();
  const emitter=()=>({on:()=>()=>{},off:()=>{}});
  const engine=new synth.AlphaSynth({sampleRate:44100,open:()=>{},play:()=>{},pause:()=>{},destroy:()=>{},activate:()=>{},addSamples:()=>{},resetSamples:()=>{},
    ready:emitter(),samplesPlayed:emitter(),sampleRequest:emitter(),enumerateOutputDevices:async()=>[],setOutputDevice:async()=>{},getOutputDevice:async()=>null},100);
  const channels=(engine as unknown as {synthesizer:{_mutedChannels:Map<number,boolean>;_soloChannels:Map<number,boolean>;channelGetMixVolume:(channel:number)=>number}}).synthesizer;
  Object.assign(test.api,{player:engine});
  // The actual JavaScript API resolves track arguments against current indices.
  const currentTracks=(tracks:model.Track[])=>tracks.map(t=>test.api.score?.tracks[t.index]).filter((t):t is model.Track=>!!t);
  test.api.changeTrackMute=(tracks,value)=>{for(const track of currentTracks(tracks)){engine.setChannelMute(track.playbackInfo.primaryChannel,value);engine.setChannelMute(track.playbackInfo.secondaryChannel,value);}};
  test.api.changeTrackSolo=(tracks,value)=>{for(const track of currentTracks(tracks)){engine.setChannelSolo(track.playbackInfo.primaryChannel,value);engine.setChannelSolo(track.playbackInfo.secondaryChannel,value);}};
  test.api.changeTrackVolume=(tracks,value)=>{for(const track of tracks)engine.setChannelVolume(track.playbackInfo.primaryChannel,value);};
  test.api.renderScore=score=>{
    Object.assign(test.api,{score,tracks:score.tracks});
    const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();engine.loadMidiFile(file);
  };
  const load=(score:model.Score)=>{test.player.replaceScore(score);test.ready.trigger();};
  return {...test,engine,channels,load};
}
it('clears actual persistent synth mute and solo state when resetting the document mix',()=>{
  const {player,channels,load,engine}=realMixer();
  player.setMute(0,true);player.setSolo(0,true);expect(channels._mutedChannels.size).toBe(2);
  player.resetMix();load(buildScore(blankProject()));
  expect([...channels._mutedChannels.keys()]).toEqual([]);expect([...channels._soloChannels.keys()]).toEqual([]);engine.destroy();
});
it('clears deleted solo channels while restoring the same track mix through undo and redo',()=>{
  const {player,channels,load,engine}=realMixer();
  const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});load(added.score);
  player.setMute(1,true);player.setSolo(1,true);player.setTrackVolume(1,.5);
  const removed=previewEdit(added.project,{type:'removeTrack',track:0});load(removed.score);
  expect([...channels._mutedChannels.keys()].sort()).toEqual([2,3]);
  player.setTrackVolume(0,.3);
  load(buildScore(added.project));expect([...channels._mutedChannels.keys()].sort()).toEqual([2,3]);
  expect(channels.channelGetMixVolume(0)).toBe(1);expect(channels.channelGetMixVolume(2)).toBe(.3);
  expect([...channels._soloChannels.keys()].sort()).toEqual([2,3]);
  load(buildScore(removed.project));expect([...channels._mutedChannels.keys()].sort()).toEqual([2,3]);
  const noBass=previewEdit(added.project,{type:'removeTrack',track:1});load(noBass.score);
  expect([...channels._mutedChannels.keys()]).toEqual([]);expect([...channels._soloChannels.keys()]).toEqual([]);engine.destroy();
});
