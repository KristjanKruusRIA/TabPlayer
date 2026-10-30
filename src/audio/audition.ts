import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { resolvePercussionArticulation } from '../editor/percussion-catalog';
import type { AuditionNote } from './bridge';
import { openStringKey } from '../editor/partial-capo';

/** Which sound an audition uses: a track's own (by identity), or the automatic sound for a program (a track not yet added). */
export type AuditionSource={trackId:string}|{program:number};
/** Plays the strings of a tuning draft (high to low, as typed) through `source`; `strum` plays them all, low to high. */
export type TuningAudition=(source:AuditionSource,pitches:number[],strum:boolean)=>void;

export const AUDITION_VELOCITY=96;
export const TUNING_HOLD_MS=1500;
export const STRUM_SPACING_MS=60;
export const EDIT_HOLD_MS=800;
export const MAX_AUDITION_NOTES=12;

/** One open string, or a strum of every string from the lowest to the highest. Capo and transposition do not apply: open strings sound at the tuning pitch. */
export function tuningAudition(pitches:readonly number[],strum:boolean):{notes:AuditionNote[];durationMs:number} {
  const ordered=strum?[...pitches].reverse():[...pitches];
  return {notes:ordered.slice(0,MAX_AUDITION_NOTES).map((key,index)=>({key,startMs:strum?index*STRUM_SPACING_MS:0,velocity:AUDITION_VELOCITY})),durationMs:TUNING_HOLD_MS};
}

/** What an edit sounds like once applied: the track's identity index and the keys of the notes it set. Null for every other edit. */
export function editAudition(score:model.Score,command:EditCommand):{track:number;percussion:boolean;notes:AuditionNote[];durationMs:number}|null {
  if(command.type!=='setNote'&&command.type!=='addPitchedNote'&&command.type!=='setPitchedNote'&&command.type!=='addPercussionNote'&&command.type!=='setPercussionNote')return null;
  const track=score.tracks[command.target.track],staff=track?.staves[command.target.staff];
  if(!track||!staff)return null;
  let key:number|undefined,percussion=false;
  if(command.type==='setNote')key=openStringKey(staff,command.string)+command.fret;
  else if(command.type==='addPitchedNote'||command.type==='setPitchedNote')key=command.pitch-staff.transpositionPitch;
  else {percussion=true;key=resolvePercussionArticulation(track,command.articulation)?.outputMidiNumber;}
  if(key===undefined||!Number.isInteger(key)||key<0||key>127)return null;
  return {track:command.target.track,percussion,notes:[{key,startMs:0,velocity:AUDITION_VELOCITY}],durationMs:EDIT_HOLD_MS};
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
