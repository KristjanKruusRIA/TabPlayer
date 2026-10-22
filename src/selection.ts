import type { model } from '@coderline/alphatab';
import { trackIdentity } from './engine';
import type { BeatTarget } from './project';
import type { BarIndexMap } from './editor/measures-types';

export function repairMeasureSelection(score:model.Score,target:BeatTarget,map:BarIndexMap):BeatTarget {
  const bar=map.oldToNew[target.bar]??map.oldToNew.slice(target.bar+1).find(index=>index!==null)??score.masterBars.length-1;
  return repairSelection(score,{...target,bar});
}

export function validSelectionIndices(target: BeatTarget): boolean {
  return [target.track,target.staff,target.bar,target.voice,target.beat].every(n=>Number.isInteger(n) && n>=0);
}

/** Where a track index ends up after a move: the moved track lands on `to`, the ones it passed shift by one. */
export function movedTrackIndex(index:number,move:{track:number;to:number}):number {
  if(index===move.track)return move.to;
  if(move.track<move.to&&index>move.track&&index<=move.to)return index-1;
  if(move.to<move.track&&index>=move.to&&index<move.track)return index+1;
  return index;
}

/** Keeps the selection on the same track when Undo or Redo reorders tracks. */
export function followSelectedTrack(before:model.Score,after:model.Score,target:BeatTarget):BeatTarget {
  const track=before.tracks[target.track];if(!track)return target;
  const id=trackIdentity(track),index=after.tracks.findIndex(candidate=>trackIdentity(candidate)===id);
  return index<0?target:{...target,track:index};
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
