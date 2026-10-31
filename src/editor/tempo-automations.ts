import {model} from '@coderline/alphatab';
import type {RatioTempoPoint} from './tempo-types';
import {validateRatioTempoPoints} from './tempo-types';
import {buildTempo,quarterUnit,tempoUnitOf,type TempoUnit} from './tempo-unit';

export function applyTempoAutomations(score:model.Score,points:readonly RatioTempoPoint[]):void {
  validateRatioTempoPoints(points);
  const arrays=score.masterBars.map(()=>[] as model.Automation[]);
  for(const point of points) {
    if(!score.masterBars[point.bar])throw new Error('Score tempo refers to a missing bar.');
    arrays[point.bar].push(buildTempo(point.linear,point.ratio,point.bpm,(point.unit??quarterUnit) as TempoUnit));
  }
  const same=score.masterBars.every((bar,index)=>bar.tempoAutomations.length===arrays[index].length&&bar.tempoAutomations.every((old,position)=>{
    const next=arrays[index][position];
    return old.type===next.type&&old.value===next.value&&old.ratioPosition===next.ratioPosition&&old.isLinear===next.isLinear&&old.isVisible===next.isVisible&&(old.text??'')===next.text&&old.syncPointValue===undefined&&tempoUnitOf(old)===tempoUnitOf(next);
  }));
  if(!same)score.masterBars.forEach((bar,index)=>{bar.tempoAutomations=arrays[index];});
}
