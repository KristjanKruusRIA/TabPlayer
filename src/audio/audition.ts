import type { model } from '@coderline/alphatab';
import type { EditCommand, TrackSound } from '../edit-types';
import { resolvePercussionArticulation } from '../editor/percussion-catalog';
import type { AuditionNote } from './bridge';
import { fretKey } from '../editor/banjo-drone';
import { kitSound } from './kit-sound';

/** Which sound an audition uses: a track's own (by identity), or the automatic sound for a program (a track not yet added). */
export type AuditionSource={trackId:string}|{program:number;percussion?:boolean;sound?:TrackSound};
/** Plays the strings of a tuning draft (high to low, as typed) through `source`; `strum` plays them all, low to high. */
export type TuningAudition=(source:AuditionSource,pitches:number[],strum:boolean)=>void;

export const AUDITION_VELOCITY=96;
export const TUNING_HOLD_MS=1500;
export const STRUM_SPACING_MS=60;
export const EDIT_HOLD_MS=800;
export const MAX_AUDITION_NOTES=12;
/** The native request refuses a note that starts later than this. */
const MAX_START_MS=1000;
export const SCALE_SPACING_MS=120;
export const SCALE_HOLD_MS=600;
/** Frets above the highest open string that a scale may climb to when it is moved into the instrument's range. */
const RANGE_FRETS=24;

/** One open string, or a strum of every string from the lowest to the highest. Capo and transposition do not apply: open strings sound at the tuning pitch. */
export function tuningAudition(pitches:readonly number[],strum:boolean):{notes:AuditionNote[];durationMs:number} {
  const ordered=strum?[...pitches].reverse():[...pitches];
  return {notes:ordered.slice(0,MAX_AUDITION_NOTES).map((key,index)=>({key,startMs:strum?index*STRUM_SPACING_MS:0,velocity:AUDITION_VELOCITY})),durationMs:TUNING_HOLD_MS};
}

/** A chord diagram (string positions from the highest string down, -1 muted) strummed from the lowest sounding string to the highest, through the staff's own keys. Null when nothing sounds. */
export function chordAudition(staff:model.Staff,frets:readonly number[]):{notes:AuditionNote[];durationMs:number}|null {
  if(staff.isPercussion||!staff.tuning.length||staff.tuning.length!==frets.length)return null;
  const keys=frets.flatMap((fret,index)=>{if(!Number.isInteger(fret)||fret<0)return [];const key=fretKey(staff,frets.length-index,fret);return Number.isInteger(key)&&key>=0&&key<=127?[key]:[];}).sort((a,b)=>a-b).slice(0,MAX_AUDITION_NOTES);
  if(!keys.length)return null;
  return {notes:keys.map((key,index)=>({key,startMs:index*STRUM_SPACING_MS,velocity:AUDITION_VELOCITY})),durationMs:TUNING_HOLD_MS};
}

/** Scale pitches (ascending, root to the octave) played one after another, moved by whole octaves so they sit in the staff's range. Null when nothing can sound. */
export function scaleAudition(staff:model.Staff|undefined,pitches:readonly number[]):{notes:AuditionNote[];durationMs:number}|null {
  if(!staff||staff.isPercussion||!pitches.length||pitches.some(pitch=>!Number.isInteger(pitch)))return null;
  const opens=staff.tuning.map((_,index)=>fretKey(staff,index+1,0)),low=opens.length?Math.min(...opens):36,high=opens.length?Math.max(...opens)+RANGE_FRETS:96;
  let shift=0;const top=Math.max(...pitches),bottom=Math.min(...pitches);
  while(top+shift>high&&bottom+shift-12>=low)shift-=12;
  while(bottom+shift<low&&top+shift+12<=127)shift+=12;
  const keys=pitches.slice(0,MAX_AUDITION_NOTES).map(pitch=>pitch+shift);
  if(keys.some(key=>key<0||key>127))return null;
  const spacing=Math.min(SCALE_SPACING_MS,Math.floor(MAX_START_MS/Math.max(1,keys.length-1)));
  return {notes:keys.map((key,index)=>({key,startMs:index*spacing,velocity:AUDITION_VELOCITY})),durationMs:SCALE_HOLD_MS};
}

/** What an edit sounds like once applied: the track's identity index and the keys of the notes it set. Null for every other edit. */
export function editAudition(score:model.Score,command:EditCommand):{track:number;percussion:boolean;notes:AuditionNote[];durationMs:number}|null {
  // A sequence sounds like the note it writes.
  if(command.type==='sequence'){for(const step of command.commands){const heard=editAudition(score,step);if(heard)return heard;}return null;}
  if(command.type!=='setNote'&&command.type!=='addPitchedNote'&&command.type!=='setPitchedNote'&&command.type!=='addPercussionNote'&&command.type!=='setPercussionNote')return null;
  const track=score.tracks[command.target.track],staff=track?.staves[command.target.staff];
  if(!track||!staff)return null;
  let key:number|undefined,percussion=false,kit:{kitSound?:number}={};
  if(command.type==='setNote')key=fretKey(staff,command.string,command.fret);
  else if(command.type==='addPitchedNote'||command.type==='setPitchedNote')key=command.pitch-staff.transpositionPitch;
  else {percussion=true;key=resolvePercussionArticulation(track,command.articulation)?.outputMidiNumber;if(key!==undefined){const sound=kitSound(track,command.articulation,key).kitSound;if(sound!==undefined)kit={kitSound:sound};}}
  if(key===undefined||!Number.isInteger(key)||key<0||key>127)return null;
  return {track:command.target.track,percussion,notes:[{key,startMs:0,velocity:AUDITION_VELOCITY,...kit}],durationMs:EDIT_HOLD_MS};
}

const storageKey='tabplayer.audition.whileEditing';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
/** Whether entering a note plays it; this viewer-level preference defaults to on. */
export function readAuditionWhileEditing(storage:PreferenceStorage|undefined=browserStorage()):boolean {
  try{return storage?.getItem(storageKey)!=='off';}catch{return true;}
}
export function writeAuditionWhileEditing(play:boolean,storage:PreferenceStorage|undefined=browserStorage()):void {
  try{storage?.setItem(storageKey,play?'on':'off');}catch{/* Storage can be unavailable; the choice then lasts for this session only. */}
}
