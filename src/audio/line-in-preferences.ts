import type { TrackSound } from '../edit-types';
import { factorySound } from './factory-sounds';
import { soundLibrary } from './sound-library';
import { presetIds, soundPreset } from './sound-model';

/** The Line-In sound and level belong to the player, not to a score, so they are kept per app and never follow a track. */
export interface LineInPreferences {
  /** Where the sound came from: `preset:<id>`, `factory:<id>` or `saved:<name>`. */
  choice:string;
  sound:TrackSound;
  /** Monitoring level, 0 to 1. */
  level:number;
  /** The chosen input, or '' for the system default. */
  inputId:string;
}
const KEY='tabplayer.lineIn';
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
export const DEFAULT_LINE_IN:LineInPreferences={choice:'preset:clean',sound:soundPreset('clean'),level:0.8,inputId:''};

/** The sound a choice names now, or null when it no longer exists (a deleted saved sound). */
export function soundForChoice(choice:string):TrackSound|null {
  const [kind,...rest]=choice.split(':'),id=rest.join(':');
  if(kind==='preset'&&(presetIds as readonly string[]).includes(id))return soundPreset(id as TrackSound['presetId']);
  if(kind==='factory')return factorySound(id);
  if(kind==='saved')return structuredClone(soundLibrary().find(entry=>entry.name===id)?.sound??null);
  return null;
}

export function readLineInPreferences(storage:PreferenceStorage|undefined=browserStorage()):LineInPreferences {
  try{
    const raw=storage?.getItem(KEY);if(!raw)return structuredClone(DEFAULT_LINE_IN);
    const value=JSON.parse(raw) as Partial<LineInPreferences>;
    const level=typeof value.level==='number'&&Number.isFinite(value.level)?Math.min(1,Math.max(0,value.level)):DEFAULT_LINE_IN.level;
    const inputId=typeof value.inputId==='string'?value.inputId:'';
    // The stored sound is what was heard last; it is kept even when its saved source has since been deleted.
    const choice=typeof value.choice==='string'?value.choice:DEFAULT_LINE_IN.choice;
    const sound=value.sound&&typeof value.sound==='object'&&typeof value.sound.presetId==='string'&&value.sound.effects?value.sound:soundForChoice(choice)??DEFAULT_LINE_IN.sound;
    return {choice,sound:structuredClone(sound),level,inputId};
  }catch{return structuredClone(DEFAULT_LINE_IN);}
}

export function saveLineInPreferences(preferences:LineInPreferences,storage:PreferenceStorage|undefined=browserStorage()):void {
  try{storage?.setItem(KEY,JSON.stringify(preferences));}catch{/* Private windows and full storage keep the choice for this session only. */}
}
