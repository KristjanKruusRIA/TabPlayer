import {expect,it,vi} from 'vitest';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge} from './bridge';
import {blankProject} from '../project';
import {buildDocument,previewEdit,trackIdentity} from '../engine';
import type {ChannelMix} from '../edit-types';

function fixture(onEdit=vi.fn(async()=>{})){
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  return {bridge,onEdit,player:new NativePlaybackController({bridge,onEdit})};
}
const base:ChannelMix={gain:1,pan:0,mute:false,solo:false};

it('sends an edited drum map to native as a mix change, once, with no new plan, and resends nothing for an unchanged map',async()=>{
  const {player,bridge}=fixture();
  const added=previewEdit(blankProject(),{type:'addPercussionTrack',name:'Drums',program:0}),built=buildDocument(added.project);
  await player.loadDocument(added.project,built,0,1);
  const drums=trackIdentity(built.score.tracks[1]),mixes=()=>vi.mocked(bridge.setMix).mock.calls;
  expect(vi.mocked(bridge.prepare).mock.calls[0][1].mixes[drums]?.drumMap).toBeUndefined();
  const before=mixes().length;
  const mapped=previewEdit(added.project,{type:'setTrackMix',trackId:drums,mix:{...base,drumMap:{preset:'gm',keys:[[91,40]]}}},built);
  await player.loadDocument(mapped.project,mapped,0,1);
  // Payload carries the map; no new plan was prepared.
  expect(mixes().length).toBe(before+1);
  expect(mixes().at(-1)![0].mixes[drums]?.drumMap).toEqual({preset:'gm',keys:[[91,40]]});
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  // The same map again (a selection reload) sends nothing.
  await player.loadDocument(mapped.project,mapped,0,1);
  expect(mixes().length).toBe(before+1);
  // Another row changes the key, so it is sent.
  const again=previewEdit(mapped.project,{type:'setTrackMix',trackId:drums,mix:{...base,drumMap:{preset:'gm',keys:[[91,41]]}}},mapped);
  await player.loadDocument(again.project,again,0,1);
  expect(mixes().length).toBe(before+2);
  expect(mixes().at(-1)![0].mixes[drums]?.drumMap).toEqual({preset:'gm',keys:[[91,41]]});
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  // Taking the map away is sent too.
  const none=previewEdit(again.project,{type:'setTrackMix',trackId:drums,mix:base},again);
  await player.loadDocument(none.project,none,0,1);
  expect(mixes().length).toBe(before+3);
  expect(mixes().at(-1)![0].mixes[drums]?.drumMap).toBeUndefined();
  player.destroy();
});

it('reads a track\'s drum map back with its mix, and keeps it while a gain is dragged',async()=>{
  const {player,bridge}=fixture();
  const added=previewEdit(blankProject(),{type:'addPercussionTrack',name:'Drums',program:0}),built0=buildDocument(added.project);
  const drums=trackIdentity(built0.score.tracks[1]);
  const mapped=previewEdit(added.project,{type:'setTrackMix',trackId:drums,mix:{...base,drumMap:{preset:'gm',keys:[[91,40]]}}},built0);
  await player.loadDocument(mapped.project,mapped,0,1);
  expect(player.mix(mapped.score.tracks[1])?.drumMap).toEqual({preset:'gm',keys:[[91,40]]});
  await player.previewMix(1,{gain:.5});
  expect(vi.mocked(bridge.setMix).mock.calls.at(-1)![0].mixes[drums]).toMatchObject({gain:.5,drumMap:{preset:'gm',keys:[[91,40]]}});
  player.destroy();
});
