import type { PracticeSettings } from './practice-types';

function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid practice settings object.');
  return value as Record<string,unknown>;
}
function exact(value:unknown,keys:string[]) {
  const result=object(value);
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))throw new Error('Invalid practice settings fields.');
  return result;
}
function number(value:unknown,min:number,max:number,message:string):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(message);
  return value;
}
function flag(value:unknown) {if(typeof value!=='boolean')throw new Error('Invalid practice setting flag.');}

export function validatePractice(settings:PracticeSettings,hasBacking:boolean):void {
  const value=exact(settings,['tempo','metronome','countIn']),tempo=object(value.tempo);
  if(tempo.kind==='relative'){
    exact(tempo,['kind','ratio']);number(tempo.ratio,.1,3,'Relative speed must be between 10% and 300%.');
  }else if(tempo.kind==='fixed'){
    exact(tempo,['kind','bpm']);number(tempo.bpm,10,300,'Fixed tempo must be between 10 and 300 BPM.');
  }else if(tempo.kind==='progressive'){
    exact(tempo,['kind','start','end','step','repetitions']);
    const start=number(tempo.start,.1,3,'Starting speed must be between 10% and 300%.'),end=number(tempo.end,.1,3,'Finishing speed must be between 10% and 300%.');
    if(end<start)throw new Error('Finishing speed must be at least the starting speed.');
    if(number(tempo.step,0,2.9,'Increment must be greater than 0 and at most 290 percentage points.')===0)throw new Error('Increment must be greater than 0 and at most 290 percentage points.');
    if(!Number.isInteger(number(tempo.repetitions,1,100,'Repetitions per speed must be a whole number from 1 to 100.')))throw new Error('Repetitions per speed must be a whole number from 1 to 100.');
  }else throw new Error('Invalid practice tempo mode.');
  const metronome=exact(value.metronome,['enabled','volume','visual']);flag(metronome.enabled);flag(metronome.visual);number(metronome.volume,0,1,'Metronome volume must be between 0% and 100%.');
  const count=exact(value.countIn,['bars','betweenLoops']);flag(count.betweenLoops);
  if(!Number.isInteger(number(count.bars,0,16,'Count-in bars must be a whole number from 0 to 16.')))throw new Error('Count-in bars must be a whole number from 0 to 16.');
  if(hasBacking&&tempo.kind==='fixed')throw new Error('Fixed tempo is unavailable while a backing track is present.');
}

export function practiceForBacking(settings:PracticeSettings,hasBacking:boolean):{settings:PracticeSettings;notice:string|null} {
  validatePractice(settings,false);
  const disabled=hasBacking&&settings.tempo.kind==='fixed';
  return {settings:{tempo:disabled?{kind:'relative',ratio:1}:{...settings.tempo},metronome:{...settings.metronome},countIn:{...settings.countIn}},notice:disabled?'Fixed tempo disabled because this score has backing audio.':null};
}
