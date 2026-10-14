import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { NoteTarget } from '../edit-types';

export const integer=(value:number,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isInteger(value)&&value>=min&&value<=max;
export function enumValue(value:number,enumeration:object,label:string) {
  if(!Number.isInteger(value)||!Object.values(enumeration).includes(value))throw new Error(`Invalid ${label}.`);
}
export function trackAt(score:model.Score,index:number) {
  if(!integer(index)||!score.tracks[index])throw new Error('Select an existing track.');return score.tracks[index];
}
export function staffAt(score:model.Score,track:number,index:number) {
  const staff=trackAt(score,track).staves[index];if(!integer(index)||!staff)throw new Error('Select an existing staff.');return staff;
}
export function locationAt(score:model.Score,target:BeatTarget) {
  if(!target||Object.values(target).some(n=>!integer(n)))throw new Error('Invalid beat selection.');
  const staff=staffAt(score,target.track,target.staff),bar=staff.bars[target.bar],voice=bar?.voices[target.voice];
  if(!bar||!voice)throw new Error('Select an existing measure and voice.');return {staff,bar,voice};
}
export function beatAt(score:model.Score,target:BeatTarget) {
  const beat=locationAt(score,target).voice.beats[target.beat];if(!beat||beat.isEmpty)throw new Error('Select an existing beat.');return beat;
}
export function noteAt(score:model.Score,target:NoteTarget) {
  const beat=beatAt(score,target.target),note=beat.notes.find(n=>n.string===target.string);
  if(!integer(target.string,1)||!note)throw new Error('Select an existing note on this string.');return note;
}
export const durationValues=[-4,-2,1,2,4,8,16,32,64,128,256] as const;
export const durationLabel=(duration:number)=>duration===-4?'Quadruple whole':duration===-2?'Double whole':`1/${duration}`;
const durationDenominator=(duration:number)=>duration<0?1/-duration:duration;
export function tremoloMarks(duration:number,speed:number) {
  const marks=Math.log2(durationDenominator(speed)/durationDenominator(duration));
  return durationValues.includes(speed as never)&&integer(marks,1,model.TremoloPickingEffect.maxMarks)?marks:null;
}
export function tremoloSpeed(beat:model.Beat|undefined) {
  if(!beat?.tremoloPicking)return null;const speed=durationDenominator(beat.duration)*2**Math.max(1,beat.tremoloPicking.marks);return speed<1?-1/speed:speed;
}
export function rhythmTicks(beat:model.Beat,measureTicks=beat.voice.bar.masterBar.calculateDuration(false)) {
  if(beat.isEmpty||beat.graceType!==model.GraceType.None)return 0;
  if(beat.isFullBarRest)return measureTicks;
  if(beat.overrideDisplayDuration!==undefined)return beat.overrideDisplayDuration;
  const base=Math.trunc(3840/(beat.duration<0?1/-beat.duration:beat.duration));
  let ticks=base;for(let dot=1;dot<=beat.dots;dot++)ticks+=Math.trunc(base/2**dot);
  if(beat.tupletNumerator>0&&beat.tupletDenominator>0)ticks=Math.trunc(ticks*beat.tupletDenominator/beat.tupletNumerator);
  return ticks;
}
export function validateCapacity(voice:model.Voice,measureTicks=voice.bar.masterBar.calculateDuration(false),freeTime=voice.bar.masterBar.isFreeTime) {
  if(!freeTime&&voice.beats.reduce((sum,b)=>sum+rhythmTicks(b,measureTicks),0)>measureTicks)throw new Error('That rhythm would overfill this measure. Shorten or remove another beat first.');
}
