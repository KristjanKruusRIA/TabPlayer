import {expect,it,vi} from 'vitest';
import {NativePlaybackController} from './NativePlaybackController';
import type {AuditionRequest,NativeAudioBridge} from './bridge';
import {blankProject} from '../project';
import {buildDocument,previewEdit,trackIdentity} from '../engine';
import {completeSound,defaultEffects,defaultMix} from '../document-settings';
import {soundPreset} from './SoundPanel';

const notes=[{key:45,startMs:0,velocity:96}];
function fixture(audition:NativeAudioBridge['audition']=vi.fn(async()=>({played:true}))){
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null),audition};
  return {bridge,player:new NativePlaybackController({bridge,onEdit:vi.fn()})};
}
const lastRequest=(bridge:NativeAudioBridge)=>vi.mocked(bridge.audition!).mock.calls.at(-1)![0] as AuditionRequest;

it('auditions with the track sound, mix and program that prepare uses, without a prepared plan or generation',async()=>{
  const {player,bridge}=fixture();const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}),sound=soundPreset('bass','darkblack-bass');
  const bassId=trackIdentity(added.score.tracks[1]),withSound=previewEdit(added.project,{type:'setTrackSound',trackId:bassId,sound},added);
  const mixed=previewEdit(withSound.project,{type:'setTrackMix',trackId:bassId,mix:{gain:.4,pan:-.5,mute:true,solo:false}},withSound);
  const built=buildDocument(mixed.project);const bass=trackIdentity(built.score.tracks[1]);
  // Nothing has been loaded: the request is dropped quietly rather than sent with a guess.
  player.audition({trackId:bass},notes,800);expect(bridge.audition).not.toHaveBeenCalled();
  void player.loadDocument(mixed.project,built,0,1);await Promise.resolve();
  player.audition({trackId:bass},notes,800);
  expect(lastRequest(bridge)).toEqual({voice:completeSound(sound),program:33,percussion:false,mix:{gain:.4,pan:-.5,mute:true,solo:false},notes,durationMs:800});
  player.audition({trackId:trackIdentity(built.score.tracks[0])},notes,800);
  expect(lastRequest(bridge)).toMatchObject({voice:{voiceId:null,presetId:'gm'},program:built.score.tracks[0].playbackInfo.program,mix:{gain:1,pan:0}});
  player.destroy();
});

it('uses a sound being previewed, a document newer than the loaded one, and the automatic sound for a program',async()=>{
  const {player,bridge}=fixture();const project=blankProject(),built=buildDocument(project),guitar=trackIdentity(built.score.tracks[0]);
  await player.loadDocument(project,built,0,1);
  await player.previewSound(guitar,soundPreset('lead'));player.audition({trackId:guitar},notes,800);expect(lastRequest(bridge).voice).toEqual(soundPreset('lead'));
  const later=previewEdit(project,{type:'setTrackMix',trackId:guitar,mix:{gain:.25,pan:.5,mute:false,solo:false}},built);
  player.audition({trackId:guitar},notes,800,{project:later.project,built:later});expect(lastRequest(bridge).mix).toEqual({gain:.25,pan:.5,mute:false,solo:false});
  player.audition({program:33},notes,1500);
  expect(lastRequest(bridge)).toEqual({voice:completeSound({voiceId:null,presetId:'gm',effects:defaultEffects()}),program:33,percussion:false,mix:defaultMix(),notes,durationMs:1500});
  player.audition({trackId:'missing'},notes,800);expect(bridge.audition).toHaveBeenCalledTimes(3);
  player.destroy();
});

it('is a no-op without bridge support and swallows failures and a destroyed controller',async()=>{
  const plain=fixture(undefined);expect(()=>plain.player.audition({program:24},notes,800)).not.toThrow();plain.player.destroy();
  const rejecting=fixture(vi.fn(async()=>{throw new Error('no output');}));
  expect(()=>rejecting.player.audition({program:24},notes,800)).not.toThrow();await new Promise(resolve=>setTimeout(resolve,0));expect(rejecting.bridge.audition).toHaveBeenCalledTimes(1);
  const throwing=fixture(vi.fn(()=>{throw new Error('sync');}));expect(()=>throwing.player.audition({program:24},notes,800)).not.toThrow();
  rejecting.player.destroy();rejecting.player.audition({program:24},notes,800);expect(rejecting.bridge.audition).toHaveBeenCalledTimes(1);
  throwing.player.destroy();
});
