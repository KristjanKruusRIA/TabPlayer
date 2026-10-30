import { model, type Settings } from '@coderline/alphatab';
// The pitch hook below wraps the one partial-capo.ts installs, so that module must have loaded first.
import { openStringKey } from './partial-capo';

/**
 * A 5-string banjo's short drone string starts at a neck fret (usually 5) instead of the nut, and banjo tab numbers
 * its frets by the neck. The drone is string 1 of the staff, the last tuning entry. Its fret 0 is the open string;
 * frets 1 to `drone` do not exist on it; fret `f` above that sounds `f - drone` semitones above the open string.
 */
export const droneString=1,standardDroneFret=5,maxDroneFret=12;

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
/** The same rules as the native `StaffSettings::validate` for `droneFret`: 0 for none, otherwise 1 to 12 on a 5-string staff. */
export function validateBanjoDrone(value:unknown,stringCount:number):asserts value is number {
  if(!integer(value,0,maxDroneFret)||value>0&&stringCount!==5)throw new Error('Choose a banjo drone fret from 1 to 12 on a 5-string staff, or 0 for none.');
}

const sources=new WeakMap<model.Staff,number>();
/** The neck fret a staff's drone string starts at, or 0 when it has none. */
export const getBanjoDrone=(staff:model.Staff):number=>sources.get(staff)??0;
/** Sets or (with 0) clears a staff's drone; the caller has validated it. */
export function setBanjoDrone(staff:model.Staff,fret:number):void {if(fret>0)sources.set(staff,fret);else sources.delete(staff);}
/** The change a fret number on the drone string makes to its pitch, relative to a plain string: 0 on every other string and at the open string. */
export const droneShift=(staff:model.Staff,string:number,fret:number,drone=getBanjoDrone(staff)):number=>drone>0&&string===droneString&&fret>drone?-drone:0;
/** Whether a fret number exists on a string: frets 1 to the drone fret are missing from the drone string. */
export const fretExists=(staff:model.Staff,string:number,fret:number,drone=getBanjoDrone(staff)):boolean=>!(drone>0&&string===droneString&&fret>=1&&fret<=drone);
/** The sounding key of a fretted note, including the capo on its string and the drone string's short neck. */
export const fretKey=(staff:model.Staff,string:number,fret:number):number=>openStringKey(staff,string)+fret+droneShift(staff,string,fret);
/** One-line description for readouts, such as "Banjo drone from fret 5". */
export const describeBanjoDrone=(drone:number):string=>drone>0?`Banjo drone from fret ${drone}`:'';

/** Throws when a note sits on a fret the drone string does not have. Every edit is checked with it, so no edit can leave such a note. */
export function assertDroneFrets(score:model.Score):void {
  for(const track of score.tracks)for(const staff of track.staves){
    const drone=getBanjoDrone(staff);if(!drone)continue;
    for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)
      if(note.string===droneString&&!fretExists(staff,note.string,note.fret,drone))throw new Error(`The banjo drone string has no frets 1 to ${drone}: bar ${bar.index+1} has fret ${note.fret} on it.`);
  }
}
/** A trill stores an absolute pitch. When the drone changes, rebase the trills on the drone string so their fret interval stays. */
export function rebaseDroneTrills(staff:model.Staff,before:number,after:number):void {
  for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)
    if(note.trillValue>=0&&note.string===droneString)note.trillValue+=droneShift(staff,note.string,note.fret,after)-droneShift(staff,note.string,note.fret,before);
}
/**
 * Runs `action` with every drone staff as a plain 5-string staff that sounds the same: drone-string frets above the
 * drone fret count from the short string's own start. GP files keep no drone that is known here, so this keeps the pitches.
 */
export function withPlainDrone<T>(score:model.Score,action:()=>T):T {
  const changed:Array<[model.Note,number]>=[],staves:Array<[model.Staff,number]>=[];
  for(const track of score.tracks)for(const staff of track.staves){
    const drone=getBanjoDrone(staff);if(!drone)continue;
    staves.push([staff,drone]);
    for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)
      if(note.string===droneString&&note.fret>drone){changed.push([note,note.fret]);note.fret-=drone;}
  }
  for(const [staff] of staves)setBanjoDrone(staff,0);
  try{return action();}finally{
    for(const [staff,drone] of staves)setBanjoDrone(staff,drone);
    for(const [note,fret] of changed)note.fret=fret;
  }
}

const extensionKey='tabplayerbanjodrone';
const field=(source:unknown,key:string):unknown=>source instanceof Map?source.get(key):source!==null&&typeof source==='object'?(source as Record<string,unknown>)[key]:undefined;
const hooks=Symbol.for('tabplayer.banjoDrone.hooks');
/** Installed once, on top of the per-string capo hooks: the pitch getter and the score-to-JSON conversion every clone goes through. */
function install():void {
  const prototype=model.Note.prototype as unknown as Record<symbol,unknown>;
  if(prototype[hooks])return;
  prototype[hooks]=true;
  const capoTuning=Object.getOwnPropertyDescriptor(model.Note.prototype,'stringTuning')!.get!;
  Object.defineProperty(model.Note.prototype,'stringTuning',{configurable:true,get(this:model.Note){
    return capoTuning.call(this)+droneShift(this.beat.voice.bar.staff,this.string,this.fret);
  }});
  const converter=model.JsonConverter as unknown as {
    scoreToJsObject(score:model.Score):unknown;jsObjectToScore(value:unknown,settings?:Settings):model.Score;
  };
  const toObject=converter.scoreToJsObject.bind(converter),toScore=converter.jsObjectToScore.bind(converter);
  converter.scoreToJsObject=score=>{
    const result=toObject(score),tracks=field(result,'tracks');
    if(Array.isArray(tracks))score.tracks.forEach((track,t)=>track.staves.forEach((staff,s)=>{
      const drone=getBanjoDrone(staff),wire=field(field(tracks[t],'staves'),String(s))??undefined;
      if(drone&&wire instanceof Map)wire.set(extensionKey,drone);
      else if(drone&&wire&&typeof wire==='object')(wire as Record<string,unknown>)[extensionKey]=drone;
    }));
    return result;
  };
  converter.jsObjectToScore=(value,settings)=>{
    const prototype=model.Score.prototype,finish=prototype.finish;
    // Attach before alphaTab finishes the score, so the pitch caches it builds there already include the drone.
    prototype.finish=function(this:model.Score,...args:Parameters<typeof finish>){
      prototype.finish=finish;
      const tracks=field(value,'tracks');
      if(Array.isArray(tracks))this.tracks.forEach((track,t)=>track.staves.forEach((staff,s)=>{
        const wire=field(field(field(tracks[t],'staves'),String(s)),extensionKey);
        try{validateBanjoDrone(wire,staff.tuning.length);setBanjoDrone(staff,wire);}catch{setBanjoDrone(staff,0);}
      }));
      return finish.apply(this,args);
    };
    try{return toScore(value,settings);}finally{prototype.finish=finish;}
  };
}
install();
