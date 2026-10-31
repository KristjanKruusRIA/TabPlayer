import { invoke } from '@tauri-apps/api/core';

export interface SavedTuning { id:string;name:string;tuning:number[] }
export interface TuningLibrary { format:'tabplayer-tuning-library';version:1;entries:SavedTuning[] }

export const MAX_TUNING_NAME_LENGTH=80;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when every code point is valid XML 1.0 character data (unpaired surrogates are rejected). */
export function isXmlText(text:string):boolean {
  for(const char of text){const code=char.codePointAt(0)!;if(!(code===9||code===10||code===13||(code>=0x20&&code<=0xD7FF)||(code>=0xE000&&code<=0xFFFD)||(code>=0x10000&&code<=0x10FFFF)))return false;}
  return true;
}
/** Returns an error message for an invalid personal tuning name, or null when it is valid. */
export function tuningNameError(name:string):string|null {
  if(typeof name!=='string')return 'Tuning name must be text.';
  // JS and Rust trim differ only at U+0085 and U+FEFF, so neither may start or end a name.
  if(name!==name.trim()||/^[\u0085\uFEFF]|[\u0085\uFEFF]$/.test(name)||!name.trim())return name.trim()?'Tuning name cannot start or end with spaces.':'Enter a name for the saved tuning.';
  if([...name].length>MAX_TUNING_NAME_LENGTH)return `Tuning name can be at most ${MAX_TUNING_NAME_LENGTH} characters.`;
  if(!isXmlText(name))return 'Tuning name contains characters that cannot be saved.';
  return null;
}
function validateId(id:unknown):asserts id is string {
  if(typeof id!=='string'||!uuid.test(id))throw new Error('Saved tuning identity must be a UUID.');
}
function validateEntry(entry:unknown):asserts entry is SavedTuning {
  if(!exact(entry,['id','name','tuning']))throw new Error('Invalid saved tuning.');
  validateId(entry.id);
  const nameProblem=tuningNameError(entry.name as string);if(nameProblem)throw new Error(nameProblem);
  const tuning=entry.tuning;
  if(!Array.isArray(tuning)||tuning.length<1||tuning.length>12||Array.from(tuning).some((pitch,index)=>!Object.hasOwn(tuning,index)||!Number.isInteger(pitch)||pitch<0||pitch>127))throw new Error('A saved tuning needs 1 to 12 pitches between 0 and 127.');
}
function checkedLibrary(value:unknown):TuningLibrary {
  if(!exact(value,['format','version','entries'])||value.format!=='tabplayer-tuning-library'||value.version!==1||!Array.isArray(value.entries))throw new Error('Unsupported tuning library format or version.');
  const seen=new Set<string>();
  for(const entry of value.entries){validateEntry(entry);const id=entry.id.toLowerCase();if(seen.has(id))throw new Error('Tuning library identities must be distinct.');seen.add(id);}
  return structuredClone(value) as unknown as TuningLibrary;
}

const listeners=new Set<(library:TuningLibrary)=>void>();
let tail:Promise<unknown>=Promise.resolve();
/** Serializes every read and mutation; a rejection never blocks later operations, and only successes publish. */
function enqueue(operation:()=>Promise<unknown>):Promise<TuningLibrary> {
  const run=tail.then(async()=>{
    const library=checkedLibrary(await operation());
    for(const listener of [...listeners])try{listener(structuredClone(library));}catch{/* a failing subscriber must not fail the operation */}
    return library;
  });
  tail=run.catch(()=>undefined);
  return run.then(library=>structuredClone(library));
}

export const readTuningLibrary=():Promise<TuningLibrary>=>enqueue(()=>invoke('tuning_library_read'));
export function putTuningLibraryEntry(entry:SavedTuning):Promise<TuningLibrary> {
  try{
    if(entry===null||typeof entry!=='object')throw new Error('Invalid saved tuning.');
    const prepared={...entry,name:typeof entry.name==='string'?entry.name.trim():entry.name};validateEntry(prepared);
    const sent=structuredClone(prepared);return enqueue(()=>invoke('tuning_library_put',{entry:sent}));
  }catch(error){return Promise.reject(error);}
}
export function removeTuningLibraryEntry(id:string):Promise<TuningLibrary> {
  try{validateId(id);}catch(error){return Promise.reject(error);}
  return enqueue(()=>invoke('tuning_library_remove',{id}));
}
export function subscribeTuningLibrary(listener:(library:TuningLibrary)=>void):()=>void {
  const own=(library:TuningLibrary)=>listener(library);listeners.add(own);return()=>{listeners.delete(own);};
}
export const newTuningId=()=>crypto.randomUUID();
