import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { displayedBpm, quarterUnit, tempoUnitOf } from './tempo-unit';

export type MeasureSettings=Omit<Extract<EditCommand,{type:'setMeasureSettings'}>,'type'|'bar'>;

/** The current settings of one measure, in the form setMeasureSettings takes, so a change can keep everything else. */
export function readMeasureSettings(score:model.Score,bar:number):MeasureSettings {
  const master=score.masterBars[bar],reference=score.tracks[0].staves[0].bars[bar].voices[0];
  return {numerator:master.timeSignatureNumerator,denominator:master.timeSignatureDenominator,pickup:master.isAnacrusis,freeTime:master.isFreeTime,repeatStart:master.isRepeatStart,repeatCount:master.repeatCount,
    endings:Array.from({length:8},(_,i)=>i+1).filter(n=>master.alternateEndings&(1<<(n-1))),section:master.section?.text??'',
    tempos:master.tempoAutomations.map(a=>({beat:Math.max(0,reference.beats.findIndex(b=>Math.abs(b.playbackStart-a.ratioPosition*master.calculateDuration(false))<1)),bpm:displayedBpm(a),linear:a.isLinear,...tempoUnitOf(a)!==quarterUnit?{unit:tempoUnitOf(a)}:{}}))};
}

/**
 * Whether setMeasureSettings can rewrite this measure without changing it: every tempo change starts exactly on a
 * beat of the first track and has no text label, the only form the edit can rebuild.
 */
export function measureSettingsExact(score:model.Score,bar:number):boolean {
  const master=score.masterBars[bar],reference=score.tracks[0].staves[0].bars[bar].voices[0],length=master.calculateDuration(false);
  return master.tempoAutomations.every(automation=>!automation.text&&reference.beats.some(beat=>!beat.isEmpty&&Math.abs(beat.playbackStart-automation.ratioPosition*length)<1));
}
