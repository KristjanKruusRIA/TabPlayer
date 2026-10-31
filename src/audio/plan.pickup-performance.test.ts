import {afterEach,expect,it,vi} from 'vitest';
import {model} from '@coderline/alphatab';
import {buildPlaybackPlan} from './plan';
import {unequalPickupScore} from './pickup.performance.fixture';
import legacy from './pickup.performance.legacy.json';

afterEach(()=>vi.restoreAllMocks());
it('preserves the exact legacy tied-bend curve when another track has a longer silent pickup',()=>{
  const score=unequalPickupScore(),source=model.JsonConverter.scoreToJson(score);expect(score.masterBars.map(bar=>bar.start)).toEqual([0,1920]);const plan=buildPlaybackPlan(score,17);
  expect(model.JsonConverter.scoreToJson(score)).toBe(source);expect(plan.midi).toEqual(legacy.plan.midi);expect(plan.notes.map(note=>[note.startTick,note.endTick])).toEqual([[0,2880]]);expect(plan).toEqual(legacy.plan);
});
it('uses the full-score lane finish for pickup context even when the longer track has no source notes',()=>{
  const score=unequalPickupScore();expect(score.tracks[1].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))).toEqual([]);const convert=vi.spyOn(model.JsonConverter,'jsObjectToScore');buildPlaybackPlan(score,17);
  const bars=convert.mock.calls.map(([value])=>{const tracks=(value instanceof Map?value.get('tracks'):(value as {tracks:unknown}).tracks) as {staves:{bars:unknown[]}[]}[];return tracks.reduce((sum,track)=>sum+track.staves.reduce((total,staff)=>total+staff.bars.length,0),0);});expect(bars).toEqual([4,4]);expect(score.masterBars[1].start).toBe(1920);
});
