import { model, type Settings } from '@coderline/alphatab';

/**
 * How one note sounds, apart from how it is written: its length as a percentage of the planned sounding length,
 * a shift of its start in ticks (960 to a quarter note), and a velocity added to the one its dynamics give it.
 */
export interface NoteAudio {length:number;offset:number;velocity:number}
export const plainNoteAudio:NoteAudio={length:100,offset:0,velocity:0};
export const noteAudioLimits={length:{min:10,max:400},offset:{min:-480,max:480},velocity:{min:-64,max:64}} as const;
export const isPlainNoteAudio=(value:NoteAudio)=>value.length===100&&value.offset===0&&value.velocity===0;

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
/** The same rules as the native `NoteAudio::validate`: exactly the three fields, whole numbers within their limits. */
export function validateNoteAudio(input:unknown):asserts input is NoteAudio {
  const value=input as NoteAudio;
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!Object.hasOwn(value,'length')||!Object.hasOwn(value,'offset')||!Object.hasOwn(value,'velocity'))throw new Error('Invalid note audio settings.');
  const {length,offset,velocity}=noteAudioLimits;
  if(!integer(value.length,length.min,length.max)||!integer(value.offset,offset.min,offset.max)||!integer(value.velocity,velocity.min,velocity.max))
    throw new Error(`Choose a length of ${length.min} to ${length.max} percent, an offset of ${offset.min} to ${offset.max} ticks and a velocity change of ${velocity.min} to ${velocity.max}.`);
}

const sources=new WeakMap<model.Note,NoteAudio>();
// Set once any note has had settings, so a score that never had any is never scanned.
let used=false;
/** A copy of a note's audio settings, or null when it plays as written. */
export function getNoteAudio(note:model.Note):NoteAudio|null {
  const value=sources.get(note);return value?{...value}:null;
}
/** Sets, or with null or the plain values clears, a note's audio settings; the caller has validated them. */
export function setNoteAudio(note:model.Note,value:NoteAudio|null):void {
  if(!value||isPlainNoteAudio(value)){sources.delete(note);return;}
  used=true;sources.set(note,{length:value.length,offset:value.offset,velocity:value.velocity});
}
const eachNote=(score:model.Score,action:(note:model.Note,track:number,staff:number,bar:number,voice:number,beat:number,index:number)=>void)=>{
  score.tracks.forEach((track,t)=>track.staves.forEach((staff,s)=>staff.bars.forEach((bar,b)=>bar.voices.forEach((voice,v)=>voice.beats.forEach((beat,i)=>beat.notes.forEach((note,n)=>action(note,t,s,b,v,i,n)))))));
};
/** Whether any note of the score has audio settings. */
export function hasNoteAudio(score:model.Score):boolean {
  if(!used)return false;
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes)if(sources.has(note))return true;
  return false;
}

/**
 * Whether the note, or a note tied on to it, carries something that alphaTab turns into pitch-wheel events: a bend, a whammy bar,
 * a slide or vibrato. Those events are not attached to the note, so moving or stretching the note would leave them behind.
 */
export function hasPitchEvents(note:model.Note):boolean {
  for(let link:model.Note|null=note;link;link=link.tieDestination)
    if(link.hasBend||link.beat.hasWhammyBar||link.slideInType!==model.SlideInType.None||link.slideOutType!==model.SlideOutType.None||link.vibrato!==model.VibratoType.None)return true;
  return false;
}

const extensionKey='tabplayernoteaudio';
const field=(source:unknown,key:string):unknown=>source instanceof Map?source.get(key):source!==null&&typeof source==='object'?(source as Record<string,unknown>)[key]:undefined;
const list=(source:unknown,key:string):unknown[]=>{const value=field(source,key);return Array.isArray(value)?value:[];};
/** The JSON object of one note, found by its position in the score. */
function noteWire(root:unknown,...path:number[]):unknown {
  let node=root;
  ['tracks','staves','bars','voices','beats','notes'].forEach((key,level)=>{node=list(node,key)[path[level]];});
  return node;
}
const hooks=Symbol.for('tabplayer.noteAudio.hooks');
/**
 * alphaTab has nowhere to keep this, and every clone of a score goes through the score-to-JSON conversion, so the
 * settings ride along on the note's own JSON object as an extra field, written only for a note that has them.
 * Both hooks are installed once, when this module loads.
 */
function install():void {
  const prototype=model.Score.prototype as unknown as Record<symbol,unknown>;
  if(prototype[hooks])return;
  prototype[hooks]=true;
  const converter=model.JsonConverter as unknown as {
    scoreToJsObject(score:model.Score):unknown;jsObjectToScore(value:unknown,settings?:Settings):model.Score;
  };
  const toObject=converter.scoreToJsObject.bind(converter),toScore=converter.jsObjectToScore.bind(converter);
  converter.scoreToJsObject=score=>{
    const result=toObject(score);
    if(!used)return result;
    eachNote(score,(note,t,s,b,v,i,n)=>{
      const audio=sources.get(note),wire=audio&&noteWire(result,t,s,b,v,i,n);
      if(wire instanceof Map)wire.set(extensionKey,{...audio});
      else if(wire&&typeof wire==='object')(wire as Record<string,unknown>)[extensionKey]={...audio};
    });
    return result;
  };
  converter.jsObjectToScore=(value,settings)=>{
    const prototype=model.Score.prototype,finish=prototype.finish;
    // Attach before alphaTab finishes the score, in the same pass that attaches its other extra fields.
    prototype.finish=function(this:model.Score,...args:Parameters<typeof finish>){
      prototype.finish=finish;
      eachNote(this,(note,t,s,b,v,i,n)=>{
        const wire=field(noteWire(value,t,s,b,v,i,n),extensionKey);
        if(wire===undefined)return;
        try{validateNoteAudio(wire);setNoteAudio(note,wire);}catch{setNoteAudio(note,null);}
      });
      return finish.apply(this,args);
    };
    try{return toScore(value,settings);}finally{prototype.finish=finish;}
  };
}
install();
