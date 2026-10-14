import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDocument, exportGp, previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge, NativeAudioStatus } from './bridge';
import { buildPlaybackPlan } from './plan';

function fixture() {
  let receive: (status:NativeAudioStatus)=>void=()=>{};
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const onEdit=vi.fn();const player=new NativePlaybackController({bridge,onEdit});
  const emit=(change:Partial<NativeAudioStatus>={})=>receive({generation:player.generation,ready:true,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,error:null,deviceId:null,...change});
  return {bridge,onEdit,player,emit};
}
it('native_state_ack_not_button_intent',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));
  bridge.command=vi.fn(async()=>{throw new Error('Device disconnected');});player.play();
  await vi.waitFor(()=>expect(player.getState().error).toBe('Device disconnected'));expect(player.getState().playing).toBe(false);
  emit();expect(player.getState().error).toBe('Device disconnected');
  bridge.command=vi.fn(async()=>{});emit();player.play();expect(player.getState().playing).toBe(false);emit({playing:true,seconds:1,tick:1920});expect(player.getState()).toMatchObject({playing:true,time:1000});player.destroy();
});
it('a failed prepare can recover when the document settings change',async()=>{
  const {player,bridge}=fixture();const p=blankProject();let built=buildDocument(p);
  bridge.prepare=vi.fn().mockRejectedValueOnce(new Error('Missing voice sample')).mockResolvedValue(undefined);
  await player.loadDocument(p,built);expect(player.getState().ready).toBe(false);expect(player.getState().error).toBe('Missing voice sample');
  built={...built,settings:{...built.settings,sounds:{}}};await player.loadDocument(p,built);
  expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(bridge.setMix).not.toHaveBeenCalled();player.destroy();
});
it('late_generation_cannot_replace_score',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject(),first=buildDocument(p);let release!:(p:ReturnType<typeof buildPlaybackPlan>)=>void;
  const plan=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockImplementation((project,generation)=>Promise.resolve(buildPlaybackPlan(buildDocument(project).score,generation)));
  player.destroy();const next=new NativePlaybackController({bridge,onEdit:()=>{},preparePlan:plan});
  const pending=next.loadDocument(p,first);const old=next.generation;
  const other={...p,base:{...p.base,kind:'blank' as const,title:'Next',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:4}};
  await next.loadDocument(other,buildDocument(other));release(buildPlaybackPlan(first.score,old));await pending;
  expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({generation:next.generation}),expect.anything(),null,'blank',{speed:1,metronome:false});
  emit({generation:old,playing:true});expect(next.getState().playing).toBe(false);next.destroy();
});
it('inclusive_loop_seek_pause_resume',async()=>{
  const {player,bridge,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));emit();
  player.setLoop(1,2);expect(bridge.command).toHaveBeenLastCalledWith({type:'setLoop',startTick:3840,endTick:11520,generation:player.generation});
  player.seekToMeasure(3);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:11520,generation:player.generation});
  player.setSpeed(25);expect(()=>player.setSpeed(24)).toThrow('25%');emit({playing:true,seconds:6,tick:11520,speed:.25});player.pause();expect(player.getState().playing).toBe(true);emit({seconds:6,tick:11520,speed:.25});expect(player.getState()).toMatchObject({playing:false,time:6000,speed:25,measure:3});player.destroy();
});
it('retains acknowledged speed and metronome across musical edit undo and redo in one document',async()=>{
  const {player,bridge,emit}=fixture();const project=blankProject(),built=buildDocument(project);
  bridge.prepare=vi.fn(async(_plan,_settings,_embedded,_sourceKey?:string,practice?:{speed:number;metronome:boolean})=>emit({speed:practice?.speed??1,metronome:practice?.metronome??false}));
  await player.loadDocument(project,built,0,0);player.setSpeed(50);player.setMetronome(.4);emit({speed:.5,metronome:true});
  const edited=previewEdit(project,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});
  for(const document of [{project:edited.project,built:edited},{project,built:buildDocument(project)},{project:edited.project,built:buildDocument(edited.project)}]) {
    player.beforeScoreChange();await player.loadDocument(document.project,document.built,0,0);
    expect(player.getState()).toMatchObject({speed:50,metronome:true,playing:false});
    expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual({speed:.5,metronome:true});
  }
  player.destroy();
});
it.each(['blank','file'])('resets practice after explicit New/Open of the same %s base',async kind=>{
  const {player,bridge,emit}=fixture();const blank=blankProject();const bytes=exportGp(buildDocument(blank).score);
  const project=kind==='blank'?blank:{...blank,base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  const built=buildDocument(project);
  bridge.prepare=vi.fn(async(_plan,_settings,_embedded,_sourceKey?:string,practice?:{speed:number;metronome:boolean})=>emit({speed:practice?.speed??1,metronome:practice?.metronome??false}));
  await player.loadDocument(project,built,0,0);
  for(const epoch of [1,2]) {
    emit({speed:.75,metronome:true});player.beforeScoreChange();await player.loadDocument(project,built,0,epoch);
    expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[4]).toEqual({speed:1,metronome:false});expect(player.getState()).toMatchObject({speed:100,metronome:false});
  }
  player.destroy();
});
it('seeks and inclusively loops the generated variable-meter measure boundaries',async()=>{
  const {player,bridge,emit}=fixture();const target={track:0,staff:0,bar:1,voice:0,beat:3};
  let project=previewEdit(blankProject(),{type:'deleteBeat',target}).project;
  for(let beat=0;beat<3;beat++)project=previewEdit(project,{type:'setBeatRhythm',target:{...target,beat},duration:8,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0}).project;
  project=previewEdit(project,{type:'setMeasureSettings',bar:1,numerator:3,denominator:8,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]}).project;
  await player.loadDocument(project,buildDocument(project));emit();
  player.seekToMeasure(0);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:0,generation:player.generation});
  player.seekToMeasure(3);expect(bridge.command).toHaveBeenLastCalledWith({type:'seekTick',tick:9120,generation:player.generation});
  player.setLoop(1,2);expect(bridge.command).toHaveBeenLastCalledWith({type:'setLoop',startTick:3840,endTick:9120,generation:player.generation});
  player.clearLoop();expect(bridge.command).toHaveBeenLastCalledWith({type:'clearLoop',generation:player.generation});
  expect(()=>player.setLoop(3,1)).toThrow('Loop end');expect(()=>player.seekToMeasure(99)).toThrow('Select a measure');
  emit({tick:5280,seconds:2.75});expect(player.getState().measure).toBe(2);player.destroy();
});
it('restores persisted mixer identity through structural undo redo and clears it on New',async()=>{
  const {player,bridge,onEdit}=fixture();const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  const bassId=trackIdentity(added.score.tracks[1]),mix={gain:.5,pan:-.2,mute:true,solo:true};
  const mixed=previewEdit(added.project,{type:'setTrackMix',trackId:bassId,mix});await player.loadDocument(mixed.project,mixed);
  const removed=previewEdit(mixed.project,{type:'removeTrack',track:0});await player.loadDocument(removed.project,removed);
  expect(player.mix(removed.score.tracks[0])).toEqual({volume:.5,pan:-.2,mute:true,solo:true});
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[0].tracks.map(t=>t.id)).toEqual([bassId]);
  player.setTrackVolume(0,.3);expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackMix',trackId:bassId,mix:{...mix,gain:.3}});
  const volume=previewEdit(removed.project,{type:'setTrackMix',trackId:bassId,mix:{...mix,gain:.3}},removed);await player.loadDocument(volume.project,volume);
  expect(player.mix(volume.score.tracks[0])?.volume).toBe(.3);
  await player.loadDocument(removed.project,removed);expect(player.mix(removed.score.tracks[0])?.volume).toBe(.5);
  const undo=buildDocument(mixed.project);await player.loadDocument(mixed.project,undo);
  expect(player.mix(undo.score.tracks[0])).toMatchObject({volume:1,mute:false,solo:false});expect(player.mix(undo.score.tracks[1])).toMatchObject({volume:.5,mute:true,solo:true});
  const redo=buildDocument(removed.project);await player.loadDocument(removed.project,redo);expect(player.mix(redo.score.tracks[0])).toMatchObject({volume:.5,mute:true,solo:true});
  const deletedSolo=previewEdit(mixed.project,{type:'removeTrack',track:1});await player.loadDocument(deletedSolo.project,deletedSolo);
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[0].tracks.map(t=>t.id)).toEqual(['base/0']);expect(player.mix(deletedSolo.score.tracks[0])).toMatchObject({mute:false,solo:false});
  const fresh=blankProject(),built=buildDocument(fresh);await player.loadDocument(fresh,built);
  expect(player.mix(built.score.tracks[0])).toMatchObject({volume:1,pan:0,mute:false,solo:false});expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[1].mixes).not.toHaveProperty(bassId);player.destroy();
});
it('mix_undo_delete_new_document uses persisted identity and no score preparation',async()=>{
  const {player,bridge,onEdit}=fixture();const p=blankProject();let built=buildDocument(p);await player.loadDocument(p,built);
  player.setMute(0,true);expect(onEdit).toHaveBeenCalledWith({type:'setTrackMix',trackId:trackIdentity(built.score.tracks[0]),mix:{gain:1,pan:0,mute:true,solo:false}});
  built={...built,settings:{...built.settings,mixes:{'base/0':{gain:.4,pan:0,mute:true,solo:false}}}};await player.loadDocument(p,built);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).toHaveBeenCalledWith(built.settings,player.generation);expect(player.mix(built.score.tracks[0])).toMatchObject({mute:true,volume:.4});
  built={...built,settings:buildDocument(p).settings};await player.loadDocument(p,built);expect(player.mix(built.score.tracks[0])?.mute).toBe(false);
  await player.loadDocument(blankProject(),buildDocument(blankProject()));expect(player.mix(built.score.tracks[0])?.solo).toBe(false);player.destroy();
});
it('external_cursor_has_one_audio_clock',async()=>{
  const {player,emit}=fixture();const p=blankProject();await player.loadDocument(p,buildDocument(p));
  const output={handler:undefined,updatePosition:vi.fn()};let ready=()=>{};
  const api={player:{output,updateSyncPoints:vi.fn()},playerReady:{on:(f:()=>void)=>{ready=f;},off:vi.fn()},play:vi.fn(),pause:vi.fn(),renderScore:vi.fn(),isReadyForPlayback:true} as unknown as Parameters<typeof player.attachView>[0];
  player.attachView(api);ready();emit({playing:true,seconds:1.5,tick:2880});expect(output.handler).toBeDefined();expect(output.updatePosition).toHaveBeenLastCalledWith(1500);expect(api.player?.updateSyncPoints).toHaveBeenCalledWith([]);expect(api.play).toHaveBeenCalledTimes(1);player.destroy();
});
it('embedded backing travels once per source and retains sync metadata through rebuilds',async()=>{
  const {bridge,player:unused}=fixture();unused.destroy();const original=buildDocument(blankProject());
  const player=new NativePlaybackController({bridge,onEdit:()=>{},preparePlan:async(_,generation)=>buildPlaybackPlan(original.score,generation)});
  const base=(sha256:string)=>({...blankProject(),base:{kind:'file' as const,filename:'Authored.gp',sha256,bytesBase64:'AA=='}});
  const audio=new Uint8Array([1,2,3]);let built={...original,embeddedBacking:audio,embeddedBackingSettings:{offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:100}],mix:{gain:1,pan:0,mute:false,solo:false}}};
  const first=base('a'.repeat(64)),second=base('b'.repeat(64));
  await player.loadDocument(first,built);expect(bridge.prepare).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({backing:{assetId:'embedded',...built.embeddedBackingSettings}}),audio,first.base.sha256,{speed:1,metronome:false});
  built={...built,settings:{...built.settings,mixes:{'base/0':{gain:.4,pan:0,mute:false,solo:false}}}};await player.loadDocument(first,built);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(bridge.setMix).toHaveBeenCalledTimes(1);
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(first,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBeNull();
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(second,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBe(audio);
  built={...built,score:buildDocument(blankProject()).score};await player.loadDocument(first,built);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)?.[2]).toBe(audio);player.destroy();
});
it('cosmetic view renders do not forward external media stop or seek to native audio',async()=>{
  const {player,bridge}=fixture();const p=blankProject(),built=buildDocument(p);await player.loadDocument(p,built);
  const output:{handler?:{seekTo:(time:number)=>void;pause:()=>void};updatePosition:()=>void}={updatePosition:()=>{}};
  let ready=()=>{};const map=vi.fn();
  const api={player:{output,updateSyncPoints:map},playerReady:{on:(listener:()=>void)=>{ready=listener;},off:()=>{}},renderScore:()=>{ready();map(['upstream source sync']);output.handler?.pause();output.handler?.seekTo(0);}} as unknown as Parameters<typeof player.attachView>[0];
  player.attachView(api);vi.mocked(bridge.command).mockClear();player.replaceScore(built.score);expect(bridge.command).not.toHaveBeenCalled();
  expect(map).toHaveBeenLastCalledWith([]);
  await player.loadDocument(p,built,1);expect(bridge.setMix).not.toHaveBeenCalled();player.destroy();
});
it('webview reload generation starts after the native pending preparation',async()=>{
  const {player,bridge}=fixture();bridge.status=vi.fn(async()=>({generation:10000,desiredGeneration:10002,ready:false,playing:false,tick:0,seconds:0,durationSeconds:0,speed:1,metronome:false,error:null,deviceId:null}));
  const p=blankProject();await player.loadDocument(p,buildDocument(p));expect(player.generation).toBeGreaterThan(10002);expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({generation:player.generation}),expect.anything(),null,'blank',{speed:1,metronome:false});player.destroy();
});
