/** MIDI capture is a player's setting, not a score's: it is kept in this window's storage and never saved with a document. */
export type StringMapping='off'|'lowestFirst'|'highestFirst';
export interface MidiCapturePreferences {
  /** The input last chosen. Remembering it never opens it: capture is off at every launch. */
  port:string;
  /** The longest gap between two notes that still count as one chord, 10 to 500 ms. */
  chordWindowMs:number;
  /** Notes softer than this are ignored, 1 to 127. */
  minVelocity:number;
  stringMapping:StringMapping;
}
export const MIDI_CAPTURE_KEY='tabplayer.midiCapture';
export const CHORD_WINDOW_MIN=10;
export const CHORD_WINDOW_MAX=500;
export const VELOCITY_MIN=1;
export const VELOCITY_MAX=127;
const PORT_NAME_MAX=256;
export const DEFAULT_MIDI_CAPTURE:MidiCapturePreferences={port:'',chordWindowMs:60,minVelocity:1,stringMapping:'off'};
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=():PreferenceStorage|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
const MAPPINGS:readonly string[]=['off','lowestFirst','highestFirst'];
const clamp=(value:unknown,min:number,max:number,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.round(Math.min(max,Math.max(min,value))):fallback;

/** A missing or malformed stored value falls back to the default for that field only; a repaired value is written back. */
export function readMidiCapturePreferences(storage:PreferenceStorage|undefined=browserStorage()):MidiCapturePreferences {
  let text:string|null=null,stored:unknown=null;
  try{text=storage?.getItem(MIDI_CAPTURE_KEY)??null;if(text)stored=JSON.parse(text);}catch{/* Unreadable storage keeps the defaults. */}
  const object=stored&&typeof stored==='object'&&!Array.isArray(stored)?stored as Record<string,unknown>:{};
  const port=typeof object.port==='string'&&object.port.length<=PORT_NAME_MAX?object.port:DEFAULT_MIDI_CAPTURE.port;
  const preferences:MidiCapturePreferences={
    port,
    chordWindowMs:clamp(object.chordWindowMs,CHORD_WINDOW_MIN,CHORD_WINDOW_MAX,DEFAULT_MIDI_CAPTURE.chordWindowMs),
    minVelocity:clamp(object.minVelocity,VELOCITY_MIN,VELOCITY_MAX,DEFAULT_MIDI_CAPTURE.minVelocity),
    stringMapping:typeof object.stringMapping==='string'&&MAPPINGS.includes(object.stringMapping)?object.stringMapping as StringMapping:DEFAULT_MIDI_CAPTURE.stringMapping,
  };
  // Only a stored value that needed repair is written back; nothing is stored for a player who never changed a setting.
  if(text&&JSON.stringify(preferences)!==text)saveMidiCapturePreferences(preferences,storage);
  return preferences;
}
/** The mapping chosen when storage refused to keep it: this session's choice stands, so the select and the chords agree. */
let unsaved:StringMapping|null=null;
export function saveMidiCapturePreferences(preferences:MidiCapturePreferences,storage:PreferenceStorage|undefined=browserStorage()):void {
  try{
    // No storage at all (the browser refused to hand it out) keeps nothing either: the session's choice stands.
    if(!storage){unsaved=preferences.stringMapping;return;}
    storage.setItem(MIDI_CAPTURE_KEY,JSON.stringify({port:preferences.port,chordWindowMs:preferences.chordWindowMs,minVelocity:preferences.minVelocity,stringMapping:preferences.stringMapping}));
    unsaved=null;
  }catch{/* Storage can be unavailable; the choice then lasts for this session only. */unsaved=preferences.stringMapping;}
}
/** The string mapping in force now: the stored one, unless the last save failed, when the unsaved choice is. */
export const activeStringMapping=():StringMapping=>unsaved??readMidiCapturePreferences().stringMapping;
