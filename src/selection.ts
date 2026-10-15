import type { model } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import type { BarIndexMap } from './editor/measures-types';

export function repairMeasureSelection(score:model.Score,target:BeatTarget,map:BarIndexMap):BeatTarget {
  const bar=map.oldToNew[target.bar]??map.oldToNew.slice(target.bar+1).find(index=>index!==null)??score.masterBars.length-1;
  return repairSelection(score,{...target,bar});
}

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
