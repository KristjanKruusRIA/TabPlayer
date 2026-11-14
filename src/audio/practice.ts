import { CLICK_SOUNDS,type ClickSound,type PracticeSettings } from './practice-types';
import type { PracticeNotice } from './types';
import type { MessageKey } from '../i18n';

/** The checks a person can fail by typing in the Practice settings. The message is the English source; the panel shows `practice.error_<code>`. */
const PRACTICE_MESSAGES={
  relative:'Relative speed must be between 10% and 300%.',
  fixed:'Fixed tempo must be between 10 and 300 BPM.',
  start:'Starting speed must be between 10% and 300%.',
  end:'Finishing speed must be between 10% and 300%.',
  order:'Finishing speed must be at least the starting speed.',
  step:'Increment must be greater than 0 and at most 290 percentage points.',
  repetitions:'Repetitions per speed must be a whole number from 1 to 100.',
  volume:'Metronome volume must be between 0% and 100%.',
  count_in:'Count-in bars must be a whole number from 0 to 16.',
  tonality:'Key shift must be a whole number of semitones from -12 to 12.',
  fixed_backing_range:'Fixed tempo {bpm} BPM would stretch the backing track outside 10% to 300% of its speed. For this score choose {low} to {high} BPM. A muted backing counts too.',
  fixed_backing_span:'No fixed tempo suits this score while a backing track is present: its tempos are too far apart to keep the backing within 10% to 300% of its speed. A muted backing counts too.',
} as const;
export type PracticeErrorCode=keyof typeof PRACTICE_MESSAGES;
/** The numbers a message names: the fixed tempo that was asked for and the fixed tempos this score allows with a backing. */
export interface PracticeErrorDetail {bpm:number;low:number;high:number}
export class PracticeError extends Error {
  constructor(readonly code:PracticeErrorCode,readonly detail?:PracticeErrorDetail){super(detail?PRACTICE_MESSAGES[code].replace('{bpm}',String(detail.bpm)).replace('{low}',String(detail.low)).replace('{high}',String(detail.high)):PRACTICE_MESSAGES[code]);this.name='PracticeError';}
}

/** The slowest and fastest authored tempo (BPM) a score plays at, which decide how far a fixed tempo stretches its backing. Mirrors `AuthoredTempos` in `practice.rs`. */
export interface AuthoredTempos {min:number;max:number}
/** The tempos that govern some tick of the played range (the first always does). */
export function authoredTemposOf(plan:{tempos:{tick:number;bpm:number}[];durationTick:number;playbackEndTick?:number}):AuthoredTempos {
  const end=plan.playbackEndTick??plan.durationTick;let min=Infinity,max=0;
  plan.tempos.forEach((tempo,index)=>{if(index===0||tempo.tick<end){min=Math.min(min,tempo.bpm);max=Math.max(max,tempo.bpm);}});
  return {min,max};
}
const tenth=(value:number,up:boolean)=>(up?Math.ceil(value*10-1e-6):Math.floor(value*10+1e-6))/10;
/** The fixed tempos (BPM, to a tenth, rounded inwards from the exact limits) that keep the backing within 10% to 300% of its speed at every tempo of the score, or null when none does. The same two numbers are what the message names and what `checkFixedBacking` compares against, so a tempo inside the stated range is always accepted and the first one outside it refused. Mirrors `AuthoredTempos::fixed_limits`. */
export function fixedLimits(authored:AuthoredTempos):{low:number;high:number}|null {
  const low=tenth(Math.max(10,authored.max*.1),true),high=tenth(Math.min(300,authored.min*3),false);
  return low<=high?{low,high}:null;
}
function checkFixedBacking(bpm:number,authored:AuthoredTempos):void {
  const limits=fixedLimits(authored);
  if(!limits)throw new PracticeError('fixed_backing_span');
  if(bpm<limits.low||bpm>limits.high)throw new PracticeError('fixed_backing_range',{bpm,...limits});
}

function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid practice settings object.');
  return value as Record<string,unknown>;
}
function exact(value:unknown,keys:string[]) {
  const result=object(value);
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))throw new Error('Invalid practice settings fields.');
  return result;
}
function number(value:unknown,min:number,max:number,code:PracticeErrorCode):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new PracticeError(code);
  return value;
}
function flag(value:unknown) {if(typeof value!=='boolean')throw new Error('Invalid practice setting flag.');}

/** `authored` is the score's tempo range when a backing track is present, else null. */
export function validatePractice(settings:PracticeSettings,authored:AuthoredTempos|null):void {
  const value=exact(settings,Object.hasOwn(settings,'tonality')?['tempo','metronome','countIn','tonality']:['tempo','metronome','countIn']),tempo=object(value.tempo);
  if(tempo.kind==='relative'){
    exact(tempo,['kind','ratio']);number(tempo.ratio,.1,3,'relative');
  }else if(tempo.kind==='fixed'){
    exact(tempo,['kind','bpm']);number(tempo.bpm,10,300,'fixed');
  }else if(tempo.kind==='progressive'){
    exact(tempo,['kind','start','end','step','repetitions']);
    const start=number(tempo.start,.1,3,'start'),end=number(tempo.end,.1,3,'end');
    if(end<start)throw new PracticeError('order');
    if(number(tempo.step,0,2.9,'step')===0)throw new PracticeError('step');
    if(!Number.isInteger(number(tempo.repetitions,1,100,'repetitions')))throw new PracticeError('repetitions');
  }else throw new Error('Invalid practice tempo mode.');
  const metronomeValue=object(value.metronome),metronome=exact(metronomeValue,Object.hasOwn(metronomeValue,'sound')?['enabled','volume','visual','sound']:['enabled','volume','visual']);
  if(Object.hasOwn(metronome,'sound')&&!CLICK_SOUNDS.includes(metronome.sound as ClickSound))throw new Error('Invalid metronome sound.');
  flag(metronome.enabled);flag(metronome.visual);number(metronome.volume,0,1,'volume');
  const count=exact(value.countIn,['bars','betweenLoops']);flag(count.betweenLoops);
  if(!Number.isInteger(number(count.bars,0,16,'count_in')))throw new PracticeError('count_in');
  if(Object.hasOwn(value,'tonality')&&!Number.isInteger(number(value.tonality,-12,12,'tonality')))throw new PracticeError('tonality');
  if(authored&&tempo.kind==='fixed')checkFixedBacking(tempo.bpm as number,authored);
}

/** The message for a practice change that could not be made, in the interface's language: a validation code has its own text, anything else gets one plain sentence rather than the raw error. */
export function practiceProblem(error:unknown,t:(key:MessageKey,params?:Record<string,string|number>)=>string):string {
  return error instanceof PracticeError?t(`practice.error_${error.code}` as MessageKey,error.detail&&{...error.detail}):t('palette.error_key_failed');
}

/** A fixed tempo the backing cannot follow is replaced by 100% speed, with a notice. `authored` is null without a backing (or before the plan is known), and nothing then changes. */
export function practiceForBacking(settings:PracticeSettings,authored:AuthoredTempos|null):{settings:PracticeSettings;notice:PracticeNotice|null} {
  validatePractice(settings,null);
  let refused=false;
  if(authored&&settings.tempo.kind==='fixed')try{checkFixedBacking(settings.tempo.bpm,authored);}catch{refused=true;}
  return {settings:{tempo:refused?{kind:'relative',ratio:1}:{...settings.tempo},metronome:{...settings.metronome},countIn:{...settings.countIn},...(settings.tonality===undefined?{}:{tonality:settings.tonality})},notice:refused?'fixed_tempo_backing_range':null};
}
