import { model, type Settings } from '@coderline/alphatab';

/** A capo over some strings only. `strings` count from 1 for the lowest-pitched string, as notes do; `fret` is where the bar sits. */
export interface PartialCapo {fret:number;strings:number[]}
export const noPartialCapo:PartialCapo={fret:0,strings:[]};

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
/** The same rules as the native `PartialCapo::validate`: both fields, strings ascending without repeats, and fret 0 exactly when no string is covered. */
export function validatePartialCapo(input:unknown,stringCount:number):asserts input is PartialCapo {
  const value=input as PartialCapo;
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'fret')||!Object.hasOwn(value,'strings'))throw new Error('Invalid partial capo.');
  if(!integer(value.fret,0,127)||!Array.isArray(value.strings)||value.strings.length>stringCount||value.strings.some((string,index)=>!integer(string,1,stringCount)||index>0&&string<=value.strings[index-1])||(value.fret===0)!==(value.strings.length===0))throw new Error('Choose a partial capo fret from 1 to 127 over ascending existing strings, or none.');
}

const sources=new WeakMap<model.Staff,PartialCapo>();
/** A copy of a staff's partial capo, or null when it has none. */
export function getPartialCapo(staff:model.Staff):PartialCapo|null {
  const value=sources.get(staff);return value?{fret:value.fret,strings:[...value.strings]}:null;
}
/** Sets or (with null, or a fret of 0) clears a staff's partial capo; the caller has validated it. */
export function setPartialCapo(staff:model.Staff,value:PartialCapo|null):void {
  if(!value||value.fret===0||!value.strings.length){sources.delete(staff);return;}
  sources.set(staff,{fret:value.fret,strings:[...value.strings]});
}
/** The capo that acts on one string: the whole-neck capo, or a higher partial capo covering the string. Fret numbers on that string count from it. */
export function stringCapo(staff:model.Staff,string:number,partial:PartialCapo|null|undefined=sources.get(staff)):number {
  return partial&&partial.strings.includes(string)?Math.max(staff.capo,partial.fret):staff.capo;
}
/** The sounding key of a string played open: tuning, the capo on that string, minus the sounding transposition. */
export function openStringKey(staff:model.Staff,string:number,partial?:PartialCapo|null):number {
  return model.Note.getStringTuning(staff,string)+stringCapo(staff,string,partial)-staff.transpositionPitch;
}
/** One-line description for readouts, such as "Partial capo 5 on strings 1, 2". */
export function describePartialCapo(value:PartialCapo|null|undefined):string {
  return value&&value.fret>0&&value.strings.length?`Partial capo ${value.fret} on string${value.strings.length>1?'s':''} ${value.strings.join(', ')}`:'';
}
/** Maps a partial capo to a new string count; strings that no longer exist drop out. Strings count from the lowest, so keeping the high strings shifts the numbers. */
export function remapPartialCapo(value:PartialCapo|null,from:number,to:number,keep:'high'|'low'):PartialCapo|null {
  if(!value)return null;
  const strings=value.strings.map(string=>keep==='high'?string+to-from:string).filter(string=>string>=1&&string<=to);
  return strings.length?{fret:value.fret,strings}:null;
}
/** How far the partial capo alone lifts a string above the staff capo. */
export const partialLift=(staff:model.Staff,string:number,partial:PartialCapo|null|undefined=sources.get(staff))=>stringCapo(staff,string,partial)-staff.capo;
/** A trill stores an absolute pitch; when the partial capo's lift changes, rebase the trills it covers so their fret interval stays. The staff capo's own change is left as it always was. */
export function rebaseTrills(staff:model.Staff,oldCapo:number,before:PartialCapo|null,after:PartialCapo|null):void {
  const lift=(capo:number,partial:PartialCapo|null,string:number)=>partial?.strings.includes(string)?Math.max(capo,partial.fret)-capo:0;
  for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)
    if(note.trillValue>=0&&note.string>0)note.trillValue+=lift(staff.capo,after,note.string)-lift(oldCapo,before,note.string);
}
/** Runs `action` with trill pitches as the GP file stores them: relative to the staff capo alone, as alphaTab writes them raw. */
export function withPlainTrills<T>(score:model.Score,action:()=>T):T {
  const changed:Array<[model.Note,number]>=[];
  for(const track of score.tracks)for(const staff of track.staves)if(sources.has(staff))for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
    const lift=note.trillValue>=0&&note.string>0?partialLift(staff,note.string):0;
    if(lift){changed.push([note,note.trillValue]);note.trillValue-=lift;}
  }
  try{return action();}finally{for(const [note,value] of changed)note.trillValue=value;}
}

const extensionKey='tabplayerpartialcapo';
type Wire={fret:number;strings:number[]};
const field=(source:unknown,key:string):unknown=>source instanceof Map?source.get(key):source!==null&&typeof source==='object'?(source as Record<string,unknown>)[key]:undefined;
const hooks=Symbol.for('tabplayer.partialCapo.hooks');
/**
 * alphaTab models one capo per staff. Every pitch it derives from a string and fret goes through `Note.stringTuning`,
 * so that getter is the single place a per-string capo has to act, and the score-to-JSON conversion every clone goes
 * through carries the extra field. Both hooks are installed once, when this module loads.
 */
function install():void {
  const prototype=model.Note.prototype as unknown as Record<symbol,unknown>;
  if(prototype[hooks])return;
  prototype[hooks]=true;
  Object.defineProperty(model.Note.prototype,'stringTuning',{configurable:true,get(this:model.Note){
    const staff=this.beat.voice.bar.staff;return model.Note.getStringTuning(staff,this.string)+stringCapo(staff,this.string);
  }});
  const converter=model.JsonConverter as unknown as {
    scoreToJsObject(score:model.Score):unknown;jsObjectToScore(value:unknown,settings?:Settings):model.Score;
  };
  const toObject=converter.scoreToJsObject.bind(converter),toScore=converter.jsObjectToScore.bind(converter);
  converter.scoreToJsObject=score=>{
    const result=toObject(score),tracks=field(result,'tracks');
    if(Array.isArray(tracks))score.tracks.forEach((track,t)=>track.staves.forEach((staff,s)=>{
      const partial=getPartialCapo(staff),wire=field(field(tracks[t],'staves'),String(s))??undefined;
      if(partial&&wire instanceof Map)wire.set(extensionKey,partial satisfies Wire);
      else if(partial&&wire&&typeof wire==='object')(wire as Record<string,unknown>)[extensionKey]=partial;
    }));
    return result;
  };
  converter.jsObjectToScore=(value,settings)=>{
    const prototype=model.Score.prototype,finish=prototype.finish;
    // Attach before alphaTab finishes the score, so the pitch caches it builds there already include the partial capos.
    prototype.finish=function(this:model.Score,...args:Parameters<typeof finish>){
      prototype.finish=finish;
      const tracks=field(value,'tracks');
      if(Array.isArray(tracks))this.tracks.forEach((track,t)=>track.staves.forEach((staff,s)=>{
        const wire=field(field(field(tracks[t],'staves'),String(s)),extensionKey);
        try{validatePartialCapo(wire,staff.tuning.length);setPartialCapo(staff,wire);}catch{setPartialCapo(staff,null);}
      }));
      return finish.apply(this,args);
    };
    try{return toScore(value,settings);}finally{prototype.finish=finish;}
  };
}
install();
