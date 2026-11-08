import { completeSound, defaultEffects, laterFields, soundProblem } from '../document-settings';
import type { EffectBlock, FxSettings, TrackSound } from '../edit-types';

/** A sound the user saved by name, reusable on any track of any score, like GP8's user presets. */
export interface SoundPresetEntry {name:string;sound:TrackSound}
export type SoundLibraryResult={ok:true;replaced?:boolean;stored?:boolean}|{ok:false;error:string};

const key='tabplayer.soundLibrary';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const same=(a:string,b:string)=>a.toLocaleLowerCase()===b.toLocaleLowerCase();
const byName=(a:SoundPresetEntry,b:SoundPresetEntry)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'});

function nameProblem(name:string):string|null {
  if(!name)return 'Name the sound.';
  return name.length>60?'Use a name of 60 characters or fewer.':null;
}
/** A stored pedalboard, with any missing blocks or fields filled from the defaults, or null when it is unusable. */
function repairEffects(stored:Record<string,unknown>):Record<string,unknown>|null {
  const defaults=defaultEffects() as unknown as Record<string,Record<string,unknown>>,effects:Record<string,unknown>={...defaults};
  for(const [block,settings] of Object.entries(stored)){
    // The order is kept as stored and checked with the rest of the sound.
    if(block==='order'){effects.order=settings;continue;}
    // A second pedalboard with nothing switched on is dropped, as the Sound task drops it.
    if(block==='second'){if(settings===null)continue;const second=isRecord(settings)?repairEffects(settings):null;if(!second)return null;if(Object.values(second).some(item=>isRecord(item)&&item.enabled===true))effects.second=second;continue;}
    if(!Object.hasOwn(defaults,block)||!isRecord(settings))return null;
    // Fields this version does not know are dropped; missing ones take their defaults.
    effects[block]=Object.fromEntries([...Object.entries(defaults[block]).map(([field,fallback])=>[field,Object.hasOwn(settings,field)?settings[field]:fallback]),...laterFields(block as EffectBlock).filter(field=>Object.hasOwn(settings,field)).map(field=>[field,settings[field]])]);
  }
  return effects;
}
/** A stored sound, with any missing blocks or fields filled from the defaults, or null when it is unusable. */
function repairSound(value:unknown):TrackSound|null {
  if(!isRecord(value)||!isRecord(value.effects))return null;
  const effects=repairEffects(value.effects);if(!effects)return null;
  const voiceId=typeof value.voiceId==='string'?value.voiceId:null;
  const sound=completeSound({voiceId,presetId:value.presetId as TrackSound['presetId'],effects:effects as unknown as FxSettings});
  return soundProblem(sound)?null:sound;
}
/** A stored library: the usable entries, and named entries this version cannot use, such as a newer version's sounds. */
interface StoredLibrary {entries:SoundPresetEntry[];unusable:{name:string}[]}
/** Keeps each well-formed entry with a usable sound; a later entry with an existing name is dropped. */
function repair(value:unknown):StoredLibrary {
  const library:StoredLibrary={entries:[],unusable:[]};
  for(const item of Array.isArray(value)?value:[]){
    if(!isRecord(item)||typeof item.name!=='string')continue;
    const name=item.name.trim(),sound=repairSound(item.sound);
    if(nameProblem(name)||[...library.entries,...library.unusable].some(entry=>same(entry.name,name)))continue;
    if(sound)library.entries.push({name,sound});else library.unusable.push({...item,name});
  }
  library.entries.sort(byName);
  return library;
}
function readStored(storage:PreferenceStorage|undefined):StoredLibrary {
  if(session)return {entries:session,unusable:[]};
  try{return repair(JSON.parse(storage?.getItem(key)??'null'));}catch{return {entries:[],unusable:[]};}
}
/** The stored library, read afresh each time so a save never overwrites what another TabPlayer window stored. */
export function readSoundLibrary(storage:PreferenceStorage|undefined=browserStorage()):SoundPresetEntry[] {
  return readStored(storage).entries;
}

/** The library as last changed in this run, kept only while storage refuses it. */
let session:SoundPresetEntry[]|null=null;
const listeners=new Set<()=>void>();
const changed=()=>{snapshot=null;listeners.forEach(listener=>listener());};
const storedElsewhere=(event:StorageEvent)=>{if(event.key===key||event.key===null)changed();};
export const subscribeSoundLibrary=(listener:()=>void)=>{
  if(!listeners.size&&typeof window!=='undefined'){window.addEventListener('storage',storedElsewhere);window.addEventListener('focus',changed);}
  listeners.add(listener);
  return()=>{listeners.delete(listener);if(!listeners.size&&typeof window!=='undefined'){window.removeEventListener('storage',storedElsewhere);window.removeEventListener('focus',changed);}};
};
let snapshot:SoundPresetEntry[]|null=null;
/** The current library; the same array until the library changes, for React's external store. */
export const soundLibrary=():SoundPresetEntry[]=>snapshot??=readSoundLibrary();
/** Test isolation only: forgets the library kept in this run. */
export const forgetSessionSoundLibrary=()=>{session=null;snapshot=null;};
/** Stores `entries`, keeping stored entries this version cannot use unless one of `entries` now has their name. */
function write(entries:SoundPresetEntry[],storage:PreferenceStorage|undefined):boolean {
  entries.sort(byName);
  const unusable=readStored(storage).unusable.filter(item=>!entries.some(entry=>same(entry.name,item.name)));
  let stored=false;
  try{if(storage){storage.setItem(key,JSON.stringify([...entries,...unusable]));stored=true;}}catch{/* kept below for this run */}
  session=stored?null:entries;
  changed();
  return stored;
}

/** Saves a copy of `sound` under `name`, replacing a saved sound with the same name in any letter case. */
export function saveSoundPreset(name:string,sound:TrackSound,storage:PreferenceStorage|undefined=browserStorage()):SoundLibraryResult {
  const trimmed=name.trim(),problem=nameProblem(trimmed)??soundProblem(sound);
  if(problem)return {ok:false,error:problem};
  const {entries,unusable}=readStored(storage),replaced=[...entries,...unusable].some(entry=>same(entry.name,trimmed));
  const stored=write([...entries.filter(entry=>!same(entry.name,trimmed)),{name:trimmed,sound:structuredClone(completeSound(sound))}],storage);
  return {ok:true,replaced,stored};
}
export function renameSoundPreset(from:string,to:string,storage:PreferenceStorage|undefined=browserStorage()):SoundLibraryResult {
  const trimmed=to.trim(),problem=nameProblem(trimmed);
  if(problem)return {ok:false,error:problem};
  const {entries,unusable}=readStored(storage),entry=entries.find(item=>item.name===from);
  if(!entry)return {ok:false,error:`No saved sound is named “${from}”.`};
  if([...entries,...unusable].some(item=>item!==entry&&same(item.name,trimmed)))return {ok:false,error:`A saved sound named “${trimmed}” already exists.`};
  return {ok:true,stored:write(entries.map(item=>item===entry?{...item,name:trimmed}:item),storage)};
}
export function deleteSoundPreset(name:string,storage:PreferenceStorage|undefined=browserStorage()):SoundLibraryResult {
  const entries=readSoundLibrary(storage);
  if(!entries.some(entry=>entry.name===name))return {ok:false,error:`No saved sound is named “${name}”.`};
  return {ok:true,stored:write(entries.filter(entry=>entry.name!==name),storage)};
}

/** The copied sound and pedal, shared by every track's Sound panel in this run. */
export type CopiedPedal={[Block in EffectBlock]:{block:Block;settings:FxSettings[Block]}}[EffectBlock];
let clipboard:{sound:TrackSound|null;pedal:CopiedPedal|null}={sound:null,pedal:null};
const clipboardListeners=new Set<()=>void>();
export const subscribeSoundClipboard=(listener:()=>void)=>{clipboardListeners.add(listener);return()=>{clipboardListeners.delete(listener);};};
export const soundClipboard=()=>clipboard;
const setClipboard=(next:typeof clipboard)=>{clipboard=next;clipboardListeners.forEach(listener=>listener());};
export const copySound=(sound:TrackSound)=>{const completed=structuredClone(completeSound(sound));delete completed.plugin;setClipboard({...clipboard,sound:completed});};
export const copiedSound=()=>clipboard.sound;
export const copyPedal=<Block extends EffectBlock>(block:Block,settings:FxSettings[Block])=>setClipboard({...clipboard,pedal:{block,settings:structuredClone(settings)} as CopiedPedal});
export const copiedPedal=()=>clipboard.pedal;
/** Test isolation only: empties the sound clipboard. */
export const forgetSoundClipboard=()=>setClipboard({sound:null,pedal:null});
