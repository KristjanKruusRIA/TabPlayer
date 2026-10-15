import { model } from '@coderline/alphatab';
import { invoke } from '@tauri-apps/api/core';
import type { HarmonyChord,HarmonyLibrary,HarmonyLibraryEntry } from '../editor/harmony-types';
import { getHarmonyChord,setHarmonyChordSource,validateHarmonyChord } from './chord-source';
import { findChordShapes } from './chords';

const integer=(value:number,min:number,max:number)=>Number.isInteger(value)&&value>=min&&value<=max;
const exact=(value:object,keys:string[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validateId(id:string):void {
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('Library entry identity must be a UUID.');
}
function validateEntry(entry:HarmonyLibraryEntry):void {
  if(!exact(entry,['id','label','chord','tuning','capo','transposition'])||typeof entry.label!=='string'||[...entry.label].length<1||[...entry.label].length>200||!Array.isArray(entry.tuning)||entry.tuning.length>12||Array.from(entry.tuning).some((pitch,index)=>!Object.hasOwn(entry.tuning,index)||!integer(pitch,0,127))||!integer(entry.capo,0,127)||!integer(entry.transposition,-127,127))throw new Error('Invalid harmony library label or instrument context.');
  validateId(entry.id);validateHarmonyChord(entry.chord);
}
function checkedLibrary(value:HarmonyLibrary):HarmonyLibrary {
  if(!exact(value,['format','version','entries'])||value.format!=='TabPlayerHarmonyLibrary'||value.version!==1||!Array.isArray(value.entries))throw new Error('Unsupported harmony library format or version.');
  const seen=new Set<string>();for(const entry of value.entries){validateEntry(entry);const id=entry.id.toLowerCase();if(seen.has(id))throw new Error('Harmony library UUIDs must be distinct.');seen.add(id);}
  return structuredClone(value);
}

export async function readHarmonyLibrary():Promise<HarmonyLibrary> {
  return checkedLibrary(await invoke<HarmonyLibrary>('harmony_library_read'));
}
export async function putHarmonyLibraryEntry(entry:HarmonyLibraryEntry):Promise<HarmonyLibrary> {
  validateEntry(entry);return checkedLibrary(await invoke<HarmonyLibrary>('harmony_library_put',{entry:structuredClone(entry)}));
}
export async function removeHarmonyLibraryEntry(id:string):Promise<HarmonyLibrary> {
  validateId(id);return checkedLibrary(await invoke<HarmonyLibrary>('harmony_library_remove',{id}));
}

function effectiveSnapshot(value:HarmonyChord,staff:model.Staff):HarmonyChord {
  const chord=new model.Chord();setHarmonyChordSource(chord,value);
  Object.assign(chord,{staff,name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});
  return getHarmonyChord(chord);
}

export function createHarmonyLibraryEntry(id:string,label:string,chord:HarmonyChord,staff:model.Staff):HarmonyLibraryEntry {
  const entry={id,label,chord:effectiveSnapshot(chord,staff),tuning:[...staff.tuning],capo:staff.capo,transposition:staff.transpositionPitch};
  validateEntry(entry);return entry;
}

export function recallHarmonyLibraryEntry(entry:HarmonyLibraryEntry,staff:model.Staff):HarmonyChord {
  validateEntry(entry);
  const value=entry.chord,matching=entry.tuning.length===staff.tuning.length&&entry.tuning.every((pitch,index)=>pitch===staff.tuning[index])&&entry.capo===staff.capo&&entry.transposition===staff.transpositionPitch&&value.frets.length===staff.tuning.length;
  if(matching&&(value.nameMode==='manual'||effectiveSnapshot(value,staff).nameMode==='theory'))return structuredClone(value);
  if(value.nameMode==='manual'||value.recipe===null)throw new Error('This manual chord needs a matching instrument context.');
  const shape=findChordShapes(staff,value.recipe,{maxFret:24,maxSpan:4,limit:12})[0];
  if(!shape)throw new Error('No chord shape found in this search window.');
  const draft={...shape,showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering};
  const result=createHarmonyLibraryEntry(entry.id,entry.label,draft,staff).chord;
  if(result.nameMode!=='theory')throw new Error('The recalled shape does not match its sounding theory context.');
  return result;
}
