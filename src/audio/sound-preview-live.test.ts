import {expect,it,vi} from 'vitest';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge} from './bridge';
import {blankProject} from '../project';
import {buildDocument,trackIdentity} from '../engine';
import {soundPreset} from './sound-model';

/** What a drag heard through previewSound costs the player: a mix change on the running plan, never a new preparation. */
it('applies a run of previews as mix changes, without preparing the plan again or touching the document',async()=>{
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const onEdit=vi.fn(),player=new NativePlaybackController({bridge,onEdit});
  const project=blankProject(),built=buildDocument(project);await player.loadDocument(project,built,0,1);
  const track=trackIdentity(built.score.tracks[0]),saved=structuredClone(built.settings);
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  const commands=vi.mocked(bridge.command).mock.calls.length,started=performance.now();
  for(let step=0;step<40;step++){const sound=soundPreset('lead');sound.effects.amp.gainDb=step*.5;await player.previewSound(track,sound);}
  const elapsed=performance.now()-started;
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  expect(bridge.setMix).toHaveBeenCalledTimes(40);
  expect(vi.mocked(bridge.setMix).mock.calls.at(-1)![0].sounds[track].effects.amp.gainDb).toBe(19.5);
  expect(bridge.command).toHaveBeenCalledTimes(commands);expect(onEdit).not.toHaveBeenCalled();expect(built.settings).toEqual(saved);
  // Ending it sends the saved sound once.
  await player.previewSound(track,null);expect(bridge.setMix).toHaveBeenCalledTimes(41);expect(vi.mocked(bridge.setMix).mock.calls.at(-1)![0].sounds).toEqual(saved.sounds);
  // The JavaScript side of 40 updates is cheap; this bound is generous and only guards against a re-plan sneaking in.
  expect(elapsed).toBeLessThan(2000);
  player.destroy();
});
