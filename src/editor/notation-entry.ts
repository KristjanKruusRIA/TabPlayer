import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { entryNotes, keyTarget, type EntryAction, type EntryContext } from '../instruments/entry';
import type { BeatTarget } from '../project';

/** What an entered note shows: the key signature's own accidental, or one chosen for this note. */
export type EntryAccidental = 'key' | 'natural' | 'sharp' | 'flat';
export const entryAccidentals: readonly EntryAccidental[] = ['key', 'natural', 'sharp', 'flat'];
export const accidentalLabels: Record<EntryAccidental, string> = { key: 'Key signature', natural: 'Natural', sharp: 'Sharp', flat: 'Flat' };

const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'], letterSemitone = [0, 2, 4, 5, 7, 9, 11];
const sharpOrder = [3, 0, 4, 1, 5, 2, 6], flatOrder = [6, 2, 5, 1, 4, 0, 3];
/** Guitar and bass music is written an octave above where it sounds. */
const frettedShift = 12;

/** Diatonic index (octave * 7 + letter, C = 0) of the bottom staff line for each clef. */
export function bottomLine(clef: model.Clef): number {
  switch (clef) {
    case model.Clef.F4: return 2 * 7 + 4;
    case model.Clef.C3: return 3 * 7 + 3;
    case model.Clef.C4: return 3 * 7 + 1;
    default: return 4 * 7 + 2;
  }
}
/** Staff steps below and above the bottom line that the entry staff offers; the five lines are steps 0, 2, 4, 6 and 8. */
export const lowestStep = -6, highestStep = 14;

export const octaveRange = { min: 0, max: 9 };

/** The alteration (-1, 0 or 1) a key signature gives a letter. */
export function keyAlteration(keySignature: number, letter: number): number {
  const count = Math.max(-7, Math.min(7, Math.trunc(keySignature) || 0));
  if (count > 0) return sharpOrder.slice(0, count).includes(letter) ? 1 : 0;
  if (count < 0) return flatOrder.slice(0, -count).includes(letter) ? -1 : 0;
  return 0;
}

/** A letter and octave with the alteration it will carry. */
export interface EntryPitch { letter: number; octave: number; alteration: number; pitch: number; name: string }

export function entryPitch(letter: number, octave: number, accidental: EntryAccidental, keySignature: number): EntryPitch | null {
  if (!Number.isInteger(letter) || letter < 0 || letter > 6 || !Number.isInteger(octave)) return null;
  const alteration = accidental === 'key' ? keyAlteration(keySignature, letter) : accidental === 'sharp' ? 1 : accidental === 'flat' ? -1 : 0;
  const pitch = (octave + 1) * 12 + letterSemitone[letter] + alteration;
  if (pitch < 0 || pitch > 127) return null;
  return { letter, octave, alteration, pitch, name: `${letters[letter]}${alteration > 0 ? '#' : alteration < 0 ? 'b' : ''}${octave}` };
}

/** The pitch at a step of the entry staff, counted up from its bottom line. */
export function stepPitch(clef: model.Clef, step: number, accidental: EntryAccidental, keySignature: number): EntryPitch | null {
  const index = bottomLine(clef) + step;
  return entryPitch(((index % 7) + 7) % 7, Math.floor(index / 7), accidental, keySignature);
}

/** The step of a letter in an octave, or null when the entry staff does not reach it. */
export function pitchStep(clef: model.Clef, letter: number, octave: number): number | null {
  const step = octave * 7 + letter - bottomLine(clef);
  return step >= lowestStep && step <= highestStep ? step : null;
}

/** The letter a key press names, or -1. */
export function keyLetter(key: string): number {
  return key.length === 1 ? letters.indexOf(key.toUpperCase()) : -1;
}

/** The enharmonic spelling that makes `pitch` read as its entered letter, or Default when automatic spelling already does. */
export function spellingFor(entered: EntryPitch, keySignature: number): model.NoteAccidentalMode {
  if (entered.alteration === 0) return model.NoteAccidentalMode.Default;
  const flatKey = keySignature < 0, pc = entered.pitch % 12;
  const sharpNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], flatNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const automatic = (flatKey ? flatNames : sharpNames)[pc], wanted = `${letters[entered.letter]}${entered.alteration > 0 ? '#' : 'b'}`;
  if (automatic === wanted) return model.NoteAccidentalMode.Default;
  return entered.alteration > 0 ? model.NoteAccidentalMode.ForceSharp : model.NoteAccidentalMode.ForceFlat;
}

export interface NotationEntryContext { staff: model.Staff; beat: model.Beat | null; target: BeatTarget; keySignature: number }
export interface NotationEntryResult {
  /** What the control reads and announces. */
  name: string;
  action: EntryAction | null;
  /** The spelling to set on the new note once it has landed, or null when automatic spelling is right. */
  spelling: model.NoteAccidentalMode | null;
  removes: boolean;
}

/** Why this staff cannot take a pitch, or null when it can. */
export function entryBlock(staff: model.Staff, beat: model.Beat | null): string | null {
  if (staff.isPercussion) return 'Use the drum kit in the instrument view to enter percussion notes.';
  if (!beat) return 'Select a beat in the score to enter notes';
  return null;
}

/** The clef the entry staff is drawn in. */
export function entryClef(bar: model.Bar): model.Clef {
  return bar.clef === model.Clef.Neutral ? model.Clef.G2 : bar.clef;
}

/** Written pitch to the pitch the instrument view works in: the sounding key. */
export function soundingKey(staff: model.Staff, written: number): number {
  return staff.tuning.length ? written - frettedShift : written - staff.transpositionPitch;
}

/**
 * What entering `entered` on the selected beat does: add the note, or remove it when the beat already has it. A fretted
 * staff takes the lowest fret on a free string, exactly as the instrument view's keyboard does.
 */
export function enterPitch(ctx: NotationEntryContext, entered: EntryPitch): NotationEntryResult {
  const block = entryBlock(ctx.staff, ctx.beat);
  if (block || !ctx.beat) return { name: entered.name, action: null, spelling: null, removes: false };
  const context: EntryContext = { target: ctx.target, staff: ctx.staff, notes: entryNotes(ctx.staff, ctx.beat) };
  const key = soundingKey(ctx.staff, entered.pitch), target = keyTarget(context, key);
  if (!target.action) return { name: target.name.startsWith('No free string') ? `No free string can play ${entered.name}` : target.name, action: null, spelling: null, removes: false };
  const command = target.action.command, removes = command.type === 'removeNote' || command.type === 'removeNoteByIndex';
  const follow = command.type === 'setNote' ? { string: command.string, fret: command.fret } : target.action.follow;
  return { name: removes ? `Remove ${entered.name}` : entered.name, action: { command, follow }, spelling: removes ? null : spellingFor(entered, ctx.keySignature), removes };
}

/** The index of the note an entry just wrote, read from the edited beat. */
export function enteredNoteIndex(beat: model.Beat | undefined, command: EditCommand): number {
  if (!beat) return -1;
  if (command.type === 'setNote') return beat.notes.findIndex(note => note.string === command.string);
  if (command.type === 'addPitchedNote') return beat.notes.findIndex(note => note.octave * 12 + note.tone === command.pitch);
  return -1;
}
