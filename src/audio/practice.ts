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
  fixed_backing:'Fixed tempo is unavailable while a backing track is present.',
} as const;
export type PracticeErrorCode=keyof typeof PRACTICE_MESSAGES;
export class PracticeError extends Error {
  constructor(readonly code:PracticeErrorCode){super(PRACTICE_MESSAGES[code]);this.name='PracticeError';}
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

export function validatePractice(settings:PracticeSettings,hasBacking:boolean):void {
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
  if(hasBacking&&tempo.kind==='fixed')throw new PracticeError('fixed_backing');
}

/** The message for a practice change that could not be made, in the interface's language: a validation code has its own text, anything else gets one plain sentence rather than the raw error. */
export function practiceProblem(error:unknown,t:(key:MessageKey)=>string):string {
  return error instanceof PracticeError?t(`practice.error_${error.code}` as MessageKey):t('palette.error_key_failed');
}

export function practiceForBacking(settings:PracticeSettings,hasBacking:boolean):{settings:PracticeSettings;notice:PracticeNotice|null} {
  validatePractice(settings,false);
  const disabled=hasBacking&&settings.tempo.kind==='fixed';
  return {settings:{tempo:disabled?{kind:'relative',ratio:1}:{...settings.tempo},metronome:{...settings.metronome},countIn:{...settings.countIn},...(settings.tonality===undefined?{}:{tonality:settings.tonality})},notice:disabled?'fixed_tempo_disabled_backing':null};
}
