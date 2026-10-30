import { invoke } from '@tauri-apps/api/core';
import { isXmlText } from '../tuning/library';
import { defaultEngraving,validateEngraving } from './projection';
import type { EngravingOverrides } from './types';

/** The stylesheet, notation and system spacing of a document. A style never names tracks, so it holds no profiles. */
export type StyleEngraving=EngravingOverrides;
export interface SavedStyle { id:string;name:string;engraving:StyleEngraving }
/** Version 2 added `engraving.typography`. The native store reads version 1 files as version 2 and upgrades them on the next write, so only version 2 ever reaches here. */
export interface StyleLibrary { format:'tabplayer-style-library';version:2;entries:SavedStyle[] }

export const MAX_STYLE_NAME_LENGTH=80;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The style a document carries, without its track-bound staff profiles. */
export const styleOf=(engraving:EngravingOverrides):StyleEngraving=>({...structuredClone(engraving),profiles:[]});
/** The factory style: every choice left to the source or renderer default. */
export const defaultStyle=():StyleEngraving=>styleOf(defaultEngraving());
/** `style` applied to a document, keeping that document's own staff profiles. */
export const styleApplied=(style:StyleEngraving,current:EngravingOverrides):EngravingOverrides=>({...structuredClone(style),profiles:structuredClone(current.profiles)});

/** Returns an error message for an invalid personal style name, or null when it is valid. */
export function styleNameError(name:string):string|null {
  if(typeof name!=='string')return 'Style name must be text.';
  // JS and Rust trim differ only at U+0085 and U+FEFF, so neither may start or end a name.
  if(name!==name.trim()||/^[\u0085﻿]|[\u0085﻿]$/.test(name)||!name.trim())return name.trim()?'Style name cannot start or end with spaces.':'Enter a name for the saved style.';
  if([...name].length>MAX_STYLE_NAME_LENGTH)return `Style name can be at most ${MAX_STYLE_NAME_LENGTH} characters.`;
  if(!isXmlText(name))return 'Style name contains characters that cannot be saved.';
  return null;
}
function validateId(id:unknown):asserts id is string {
  if(typeof id!=='string'||!uuid.test(id))throw new Error('Saved style identity must be a UUID.');
}
function validateEntry(entry:unknown):asserts entry is SavedStyle {
  if(!exact(entry,['id','name','engraving']))throw new Error('Invalid saved style.');
  validateId(entry.id);
  const problem=styleNameError(entry.name as string);if(problem)throw new Error(problem);
  validateEngraving(entry.engraving);
  if(entry.engraving.profiles.length)throw new Error('A saved style cannot hold track profiles.');
}
function checkedLibrary(value:unknown):StyleLibrary {
  if(!exact(value,['format','version','entries'])||value.format!=='tabplayer-style-library'||value.version!==2||!Array.isArray(value.entries))throw new Error('Unsupported style library format or version.');
  const seen=new Set<string>();
  for(const entry of value.entries){validateEntry(entry);const id=entry.id.toLowerCase();if(seen.has(id))throw new Error('Style library identities must be distinct.');seen.add(id);}
  return structuredClone(value) as unknown as StyleLibrary;
}

const listeners=new Set<(library:StyleLibrary)=>void>();
let tail:Promise<unknown>=Promise.resolve();
/** Serializes every read and mutation; a rejection never blocks later operations, and only successes publish. */
function enqueue(operation:()=>Promise<unknown>):Promise<StyleLibrary> {
  const run=tail.then(async()=>{
    const library=checkedLibrary(await operation());
    for(const listener of [...listeners])try{listener(structuredClone(library));}catch{/* a failing subscriber must not fail the operation */}
    return library;
  });
  tail=run.catch(()=>undefined);
  return run.then(library=>structuredClone(library));
}

export const readStyleLibrary=():Promise<StyleLibrary>=>enqueue(()=>invoke('style_library_read'));
export function putStyleLibraryEntry(entry:SavedStyle):Promise<StyleLibrary> {
  try{
    if(entry===null||typeof entry!=='object')throw new Error('Invalid saved style.');
    const prepared={...entry,name:typeof entry.name==='string'?entry.name.trim():entry.name};validateEntry(prepared);
    const sent=structuredClone(prepared);return enqueue(()=>invoke('style_library_put',{entry:sent}));
  }catch(error){return Promise.reject(error);}
}
export function removeStyleLibraryEntry(id:string):Promise<StyleLibrary> {
  try{validateId(id);}catch(error){return Promise.reject(error);}
  return enqueue(()=>invoke('style_library_remove',{id}));
}
export function subscribeStyleLibrary(listener:(library:StyleLibrary)=>void):()=>void {
  const own=(library:StyleLibrary)=>listener(library);listeners.add(own);return()=>{listeners.delete(own);};
}
export const newStyleId=()=>crypto.randomUUID();
