import { model } from '@coderline/alphatab';

/**
 * A description of a score that does not depend on how it was made: the serialized model with its object ids numbered by
 * position, followed by every plain field and object link of the bars, voices, beats and notes (links as positions), which
 * covers the derived state the serializer leaves out (beat chain, timings, tie and slide links). Two scores with the same
 * description are the same document. Used to prove an edit applied in place equals the document a full rebuild gives.
 */
export function describeScore(score:model.Score):unknown {
  const steps=describeScoreSteps(score);
  for(;;){const step=steps.next();if(step.done)return step.value;}
}
/** `describeScore` in steps (a `yield` between slices of the work), for the check that must not stall typing. */
export function* describeScoreSteps(score:model.Score,skip:readonly string[]=[]):Generator<void,unknown> {
  const paths=new Map<object,string>();
  score.tracks.forEach((track,t)=>{
    paths.set(track,`t${t}`);
    track.staves.forEach((staff,s)=>{paths.set(staff,`t${t}s${s}`);staff.bars.forEach((bar,b)=>{paths.set(bar,`t${t}s${s}b${b}`);bar.voices.forEach((voice,v)=>{
      paths.set(voice,`t${t}s${s}b${b}v${v}`);voice.beats.forEach((beat,i)=>{paths.set(beat,`t${t}s${s}b${b}v${v}e${i}`);beat.notes.forEach((note,n)=>paths.set(note,`t${t}s${s}b${b}v${v}e${i}n${n}`));});
    });});});
  });
  score.masterBars.forEach((master,m)=>paths.set(master,`m${m}`));
  const value=(input:unknown,depth=0):unknown=>{
    if(input===null||input===undefined)return input===null?null:'undefined';
    if(typeof input==='number')return Number.isNaN(input)?'NaN':input;
    if(typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='function'||typeof input==='symbol'||typeof input==='bigint')return typeof input;
    const known=paths.get(input as object);if(known)return `->${known}`;
    if(depth>2)return `<${(input as object).constructor?.name??'object'}>`;
    if(Array.isArray(input))return input.map(item=>value(item,depth+1));
    if(input instanceof Map)return [...input].map(([key,item])=>[value(key,depth+1),value(item,depth+1)]);
    if(input instanceof Set)return [...input].map(item=>value(item,depth+1));
    const name=(input as object).constructor?.name??'object';
    if(name==='Slur'){const slur=input as {originNote:object;destinationNote:object;segments:{fromNote:object;toNote:object;kind:number}[]};return {slur:[value(slur.originNote),value(slur.destinationNote),slur.segments.map(s=>[value(s.fromNote),value(s.toNote),s.kind])]};}
    if(depth>=1)return `<${name}>`;
    // Plain value objects (a bend point, an automation) are compared by content; model objects were handled above.
    return Object.fromEntries(Object.entries(input as object).filter(([key])=>key!=='id').map(([key,item])=>[key,value(item,depth+1)]));
  };
  const fields=(object:object)=>Object.fromEntries(Object.entries(object).filter(([key])=>key!=='id'&&!skip.includes(key)).map(([key,item])=>[key,value(item)]));
  const rows:Record<string,unknown>={};
  let counted=0;
  for(const [object,path] of paths){rows[path]=fields(object);if(++counted%1500===0)yield;}
  yield;
  // Ids differ between two builds of one document, so they are numbered by position, wherever they occur in the JSON.
  const text=model.JsonConverter.scoreToJson(score);
  yield;
  const json=JSON.parse(text) as unknown;
  yield;
  // Ids differ between two builds of one document: an object is named by its position instead, wherever its id occurs in the JSON.
  // A new note takes the next id of a counter that has no knowledge of loaded files, so two objects can share an id; a reference names all of them.
  const notes=new Map<number,string[]>();
  for(const [object,path] of paths)if(object instanceof model.Note)notes.set(object.id,[...notes.get(object.id)??[],path]);
  const named=(id:number)=>(notes.get(id)??['unknown']).join('|');
  const walk=(node:unknown,kind:string):unknown=>{
    if(Array.isArray(node))return node.map(item=>walk(item,kind));
    if(node&&typeof node==='object')return Object.fromEntries(Object.entries(node).map(([key,item])=>{
      if(typeof item==='number'&&item>=0){
        if(key==='id')return [key,'#'];
        if(/noteid$/.test(key))return [key,named(item)];
      }
      return [key,walk(item,key)];
    }));
    return node;
  };
  // The same walk, one track at a time, so that no slice is longer than a track's worth.
  const top:Record<string,unknown>={};
  for(const [key,item] of Object.entries(json as Record<string,unknown>)){
    if(typeof item==='number'&&item>=0){top[key]=key==='id'?'#':/noteid$/.test(key)?named(item):item;continue;}
    if(key==='tracks'&&Array.isArray(item)){const walked:unknown[]=[];for(const track of item){walked.push(walk(track,key));yield;}top[key]=walked;continue;}
    top[key]=walk(item,key);
  }
  return {json:top,links:rows};
}

/** The first place two descriptions differ, as a readable path, or null when they are the same. */
export function firstDifference(a:unknown,b:unknown,path='$'):string|null {
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if(Array.isArray(a)!==Array.isArray(b))return `${path}: array mismatch`;
  const keys=new Set([...Object.keys(a as object),...Object.keys(b as object)]);
  for(const key of keys){const found=firstDifference((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],`${path}.${key}`);if(found)return found;}
  return null;
}

/** `firstDifference` in steps (a `yield` every few thousand values compared), for the check that must not stall typing. */
export function* firstDifferenceSteps(a:unknown,b:unknown,path='$',count={n:0}):Generator<void,string|null> {
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if(Array.isArray(a)!==Array.isArray(b))return `${path}: array mismatch`;
  const keys=new Set([...Object.keys(a as object),...Object.keys(b as object)]);
  for(const key of keys){
    if(++count.n%3000===0)yield;
    const found=yield* firstDifferenceSteps((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],`${path}.${key}`,count);if(found)return found;
  }
  return null;
}

/** Two objects of one kind (notes, beats, bars, voices) that share an id, as a readable message, or null. Ids are how links between notes are written and found, so a document that has a repeated one can attach a tie to the wrong note. */
export function duplicateIds(score:model.Score):string|null {
  const seen={note:new Map<number,string>(),beat:new Map<number,string>(),bar:new Map<number,string>(),voice:new Map<number,string>()};
  const see=(kind:keyof typeof seen,id:number,path:string)=>{const earlier=seen[kind].get(id);if(earlier!==undefined)return `${kind} id ${id} at ${earlier} and ${path}`;seen[kind].set(id,path);return null;};
  for(const [t,track] of score.tracks.entries())for(const [s,staff] of track.staves.entries())for(const [b,bar] of staff.bars.entries()){
    const barPath=`t${t}s${s}b${b}`,bad=see('bar',bar.id,barPath);if(bad)return bad;
    for(const [v,voice] of bar.voices.entries()){
      const voicePath=`${barPath}v${v}`,wrong=see('voice',voice.id,voicePath);if(wrong)return wrong;
      for(const [e,beat] of voice.beats.entries()){
        const beatPath=`${voicePath}e${e}`,off=see('beat',beat.id,beatPath);if(off)return off;
        for(const [n,note] of beat.notes.entries()){const clash=see('note',note.id,`${beatPath}n${n}`);if(clash)return clash;}
      }
    }
  }
  return null;
}

/** Lets what is waiting (a key, a click, a paint) go first: one macrotask, and more of them while input is still pending (a bounded number). */
export async function yieldToInput():Promise<void> {
  const scheduling=(globalThis as {navigator?:{scheduling?:{isInputPending?:()=>boolean}}}).navigator?.scheduling;
  for(let attempt=0;attempt<30;attempt++){
    await new Promise<void>(resolve=>setTimeout(resolve,attempt===0?0:16));
    if(!scheduling?.isInputPending?.())return;
  }
}

/**
 * A pause for work somebody is waiting for (an export, a copy): it goes on without waiting while the current run of work is shorter than `budgetMs`, and lets input
 * go first (`yieldToInput`) once it is longer. A small document is checked in one go, a large one in slices.
 */
export function yieldAfter(budgetMs=40):()=>Promise<void> {
  let since=performance.now();
  return async()=>{if(performance.now()-since<budgetMs)return;await yieldToInput();since=performance.now();};
}
