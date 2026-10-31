import { model } from '@coderline/alphatab';

/** A voice whose rhythm does not fill its measure: too short (incomplete) or too long (overfull). */
export interface ScoreError {track:number;staff:number;bar:number;voice:number;
  /** The first sounding beat of the voice, which the inspector selects. */
  beat:number;kind:'incomplete'|'overfull';ticks:number;
  /** Track name, plus the staff when the track has several. */
  place:string}

const quarter=960;
type Fraction=[number,number];
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
const add=([a,b]:Fraction,[c,d]:Fraction):Fraction=>{const top=a*d+c*b,bottom=b*d,divisor=gcd(Math.abs(top),bottom)||1;return [top/divisor,bottom/divisor];};
/** Written length in exact ticks: playback lengths lend grace-note time to neighbours and round tuplets down. */
function writtenTicks(beat:model.Beat,measure:number):Fraction {
  if(beat.graceType!==model.GraceType.None)return [0,1];
  if(beat.isFullBarRest)return [measure,1];
  if(beat.overrideDisplayDuration!==undefined)return [beat.overrideDisplayDuration,1];
  const base=beat.duration<0?3840*-beat.duration:3840/beat.duration,dotted=2**beat.dots;
  let fraction:Fraction=[base*(2*dotted-1),dotted];
  if(beat.tupletNumerator>0&&beat.tupletDenominator>0)fraction=[fraction[0]*beat.tupletDenominator,fraction[1]*beat.tupletNumerator];
  return add(fraction,[0,1]);
}
/** Voices holding only empty beats are unused, not errors; an empty filler beat before a late entry still takes its time. */
function voiceTicks(voice:model.Voice,measure:number):Fraction|null {
  if(voice.beats.every(beat=>beat.isEmpty))return null;
  return voice.beats.reduce<Fraction>((total,beat)=>add(total,writtenTicks(beat,measure)),[0,1]);
}
export function findScoreErrors(score:model.Score):ScoreError[] {
  const errors:ScoreError[]=[];
  for(const master of score.masterBars){
    // Free-time measures hold any length, as the editor's capacity checks allow.
    if(master.isFreeTime)continue;
    const expected=master.calculateDuration(false);
    for(const track of score.tracks)for(const staff of track.staves){
      const bar=staff.bars[master.index];
      for(const voice of bar?.voices??[]){
        const total=voiceTicks(voice,expected);if(!total)continue;
        const ticks=total[0]/total[1];if(ticks===expected)continue;
        // A pickup measure may be shorter than its time signature.
        if(ticks<expected&&master.isAnacrusis)continue;
        const beat=voice.beats.findIndex(value=>!value.isEmpty&&value.graceType===model.GraceType.None);
        errors.push({track:track.index,staff:staff.index,bar:master.index,voice:voice.index,beat:Math.max(0,beat),kind:ticks<expected?'incomplete':'overfull',ticks:Math.max(1,Math.round(Math.abs(expected-ticks))),place:`${track.name||`Track ${track.index+1}`}${track.staves.length>1?` · Staff ${staff.index+1}`:''}`});
      }
    }
  }
  return errors;
}
function quarters(ticks:number) {
  const divisor=gcd(ticks,quarter),top=ticks/divisor,bottom=quarter/divisor;
  return `${bottom===1?top:`${top}/${bottom}`} quarter ${ticks>quarter?'notes':'note'}`;
}
export function describeScoreError(error:ScoreError):string {
  return `Measure ${error.bar+1} · ${error.place} · Voice ${error.voice+1}: ${quarters(error.ticks)} ${error.kind==='incomplete'?'missing':'too long'}`;
}

const key='tabplayer.scoreErrors.mark';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
/** Whether error measures are marked in the score; this viewer-level preference defaults to on. */
export function readScoreErrorDisplay(storage:PreferenceStorage|undefined=browserStorage()):boolean {
  try{return storage?.getItem(key)!=='off';}catch{return true;}
}
export function writeScoreErrorDisplay(mark:boolean,storage:PreferenceStorage|undefined=browserStorage()):void {
  try{storage?.setItem(key,mark?'on':'off');}catch{/* Storage can be unavailable; the choice then lasts for this session only. */}
}
