import type { model } from '@coderline/alphatab';
import type { BeatTarget } from './project';

export function validSelectionIndices(target: BeatTarget): boolean {
  return [target.track,target.staff,target.bar,target.voice,target.beat].every(n=>Number.isInteger(n) && n>=0);
}

export function repairSelection(score: model.Score, target: BeatTarget): BeatTarget {
  const clamp=(index:number,count:number)=>Number.isInteger(index) && index>=0 ? Math.min(index,Math.max(0,count-1)) : 0;
  const track=clamp(target.track,score.tracks.length);
  const staff=clamp(target.staff,score.tracks[track].staves.length);
  const bars=score.tracks[track].staves[staff].bars;
  const bar=clamp(target.bar,bars.length);
  const voice=clamp(target.voice,bars[bar].voices.length);
  const beat=clamp(target.beat,bars[bar].voices[voice].beats.length);
  return {track,staff,bar,voice,beat};
}
