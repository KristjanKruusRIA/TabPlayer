import { useState } from 'react';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';

/** Viewer-level score-input choices, kept in this window's storage. Hearing entered notes is a separate, older preference (audition.ts). */
export interface InputPreferences {
  /** A note written on a rest first gives that rest the current entry duration. */
  autoDuration:boolean;
  /** Keypad 1-7 set the selected beat's duration and keypad . toggles its dot, instead of typing a fret. */
  numpadDurations:boolean;
  /** Copy and paste start with chord and scale diagrams included. */
  pasteDiagrams:boolean;
}
export const DEFAULT_INPUT_PREFERENCES:InputPreferences={autoDuration:false,numpadDurations:false,pasteDiagrams:true};
/** The duration last chosen from the keypad or last written onto, which auto-duration applies. */
export interface EntryDuration {duration:number;dots:number}
/** The part of a beat these rules read. */
export interface EntryBeat {duration:number;dots:number;isEmpty:boolean;notes:{length:number};tupletNumerator?:number}
export type NumpadKey={duration:number}|{dot:true};

const storageKey='tabplayer.input.preferences';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
/** Keypad digit to duration: 1 whole, 2 half, 3 quarter, 4 eighth, 5 sixteenth, 6 thirty-second, 7 sixty-fourth. */
const NUMPAD_DURATIONS=[1,2,4,8,16,32,64];

/** A malformed or missing stored value falls back to the default for that field only. */
export function readInputPreferences(storage:PreferenceStorage|undefined=browserStorage()):InputPreferences {
  let stored:unknown=null;
  try{const text=storage?.getItem(storageKey);if(text)stored=JSON.parse(text);}catch{/* Unreadable storage keeps the defaults. */}
  const object=stored&&typeof stored==='object'?stored as Record<string,unknown>:{};
  const read=(key:keyof InputPreferences)=>typeof object[key]==='boolean'?object[key] as boolean:DEFAULT_INPUT_PREFERENCES[key];
  return {autoDuration:read('autoDuration'),numpadDurations:read('numpadDurations'),pasteDiagrams:read('pasteDiagrams')};
}
export function writeInputPreferences(preferences:InputPreferences,storage:PreferenceStorage|undefined=browserStorage()):void {
  try{storage?.setItem(storageKey,JSON.stringify(preferences));}catch{/* Storage can be unavailable; the choice then lasts for this session only. */}
}
export function useInputPreferences():[InputPreferences,(change:Partial<InputPreferences>)=>void] {
  const [preferences,setPreferences]=useState(readInputPreferences);
  return [preferences,change=>setPreferences(old=>{const next={...old,...change};writeInputPreferences(next);return next;})];
}

/** What a keypad key means under the preferences. Null when the key is not claimed, so it types as before. Modified keys are never claimed. */
export function numpadKey(event:{code:string;ctrlKey:boolean;metaKey:boolean;altKey:boolean;shiftKey:boolean},preferences:InputPreferences):NumpadKey|null {
  if(!preferences.numpadDurations||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return null;
  if(event.code==='NumpadDecimal')return {dot:true};
  const match=/^Numpad([1-7])$/.exec(event.code);
  return match?{duration:NUMPAD_DURATIONS[Number(match[1])-1]}:null;
}
const entryOf=(beat:EntryBeat):EntryDuration=>({duration:beat.duration,dots:beat.dots});
const plain=(beat:EntryBeat)=>!(beat.tupletNumerator&&beat.tupletNumerator>1);

/** The one edit a keypad key makes on the selected beat, and the entry duration it leaves. Null for a beat whose rhythm is not a plain one. */
export function numpadDurationEdit(key:NumpadKey,target:BeatTarget,beat:EntryBeat):{command:EditCommand;entry:EntryDuration}|null {
  if(beat.isEmpty||!plain(beat))return null;
  const entry='dot' in key?{duration:beat.duration,dots:beat.dots>0?0:1}:{duration:key.duration,dots:beat.dots};
  return {command:{type:'setDuration',target,...entry},entry};
}

/**
 * With auto-duration on, writing a note on a rest whose rhythm differs from the entry duration first sets that duration.
 * Null when off, with no entry duration yet, on a placeholder beat, on a beat that already has notes, or when the rhythm already matches.
 */
export function autoDurationEdit(preferences:InputPreferences,target:BeatTarget,beat:EntryBeat|null|undefined,entry:EntryDuration|null):EditCommand|null {
  if(!preferences.autoDuration||!entry||!beat||beat.isEmpty||beat.notes.length>0||!plain(beat))return null;
  if(beat.duration===entry.duration&&beat.dots===entry.dots)return null;
  return {type:'setDuration',target,duration:entry.duration,dots:entry.dots};
}
/** The entry duration after writing onto a beat directly: that beat's own rhythm. Unchanged for a placeholder. */
export const entryAfterWrite=(beat:EntryBeat|null|undefined,entry:EntryDuration|null):EntryDuration|null=>beat&&!beat.isEmpty&&plain(beat)?entryOf(beat):entry;

export interface InputPreferencesPanelProps {
  preferences:InputPreferences;onChange:(change:Partial<InputPreferences>)=>void;
  preview:boolean;onPreview:(play:boolean)=>void;
}
/** The View menu's score-input choices. They are viewer settings, so they stay usable on a finalized document. */
export function InputPreferencesPanel({preferences,onChange,preview,onPreview}:InputPreferencesPanelProps):React.JSX.Element {
  return <fieldset className="input-preferences"><legend>Score input</legend>
    <label className="check"><input type="checkbox" checked={preview} onChange={event=>onPreview(event.target.checked)}/>Play notes while editing</label>
    <label className="check"><input type="checkbox" checked={preferences.autoDuration} onChange={event=>onChange({autoDuration:event.target.checked})}/>Auto-duration: a note written on a rest takes the last duration</label>
    <label className="check"><input type="checkbox" checked={preferences.numpadDurations} onChange={event=>onChange({numpadDurations:event.target.checked})}/>Keypad sets duration (1-7, . for dot)</label>
    <label className="check"><input type="checkbox" checked={preferences.pasteDiagrams} onChange={event=>onChange({pasteDiagrams:event.target.checked})}/>Paste includes chord diagrams</label>
  </fieldset>;
}
