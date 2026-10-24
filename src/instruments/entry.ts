import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { percussionChoices, resolvePercussionArticulation } from '../editor/percussion-catalog';
import type { BeatTarget } from '../project';
import { formatPitch } from '../tuning';

/** What the app should select once an instrument-view edit has landed. */
export interface EntryFollow { string?: number; fret?: number; note?: { pitch: number } | { articulation: number } | null }
export interface EntryAction { command: EditCommand; follow: EntryFollow }
export interface EntryTarget { name: string; action: EntryAction | null }
/** A note of the selected beat as the instrument view shows it. */
export interface EntryNote { id: string; index: number; key: number; string: number; fret: number; written: number | null; articulation: number | null }
/** Everything a click rule needs about the selected beat. */
export interface EntryContext { target: BeatTarget; staff: model.Staff; notes: readonly EntryNote[] }

export const maxEntryFret = 24;
export const noBeatHint = 'Select a beat in the score to edit it';
export const busyHint = 'Editing is unavailable while another operation is running';

/** The selected beat, or null for no selection, a missing beat or the empty placeholder of an empty bar. */
export function entryBeat(score: model.Score, target: BeatTarget | null): model.Beat | null {
  if (!target) return null;
  const beat = score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
  return beat && !beat.isEmpty ? beat : null;
}

const openKey = (staff: model.Staff, string: number) => staff.tuning[staff.tuning.length - string] + staff.capo - staff.transpositionPitch;
/** The sounding key of a fretted note. */
export const frettedKey = (staff: model.Staff, string: number, fret: number) => openKey(staff, string) + fret;

/** The written notes of a beat with their sounding keys; notes this staff cannot show are left out. */
export function entryNotes(staff: model.Staff, beat: model.Beat): EntryNote[] {
  const result: EntryNote[] = [];
  beat.notes.forEach((note, index) => {
    const id = `entry/${index}`;
    if (staff.isPercussion) {
      const articulation = resolvePercussionArticulation(staff.track, note.percussionArticulation);
      if (articulation) result.push({ id, index, key: articulation.outputMidiNumber, string: 0, fret: 0, written: null, articulation: note.percussionArticulation });
    } else if (staff.tuning.length) {
      if (Number.isInteger(note.string) && note.string >= 1 && note.string <= staff.tuning.length && note.fret >= 0) result.push({ id, index, key: frettedKey(staff, note.string, note.fret), string: note.string, fret: note.fret, written: null, articulation: null });
    } else {
      const written = note.octave * 12 + note.tone;
      result.push({ id, index, key: written - staff.transpositionPitch, string: 0, fret: 0, written, articulation: null });
    }
  });
  return result;
}

export function fretTarget(ctx: EntryContext, string: number, fret: number): EntryTarget {
  const { staff, target } = ctx, label = `${string}, fret ${fret} (${formatPitch(frettedKey(staff, string, fret))})`;
  if (ctx.notes.some(note => note.string === string && note.fret === fret)) return { name: `Remove string ${label}`, action: { command: { type: 'removeNote', target, string }, follow: { string, fret } } };
  return { name: `String ${label}`, action: { command: { type: 'setNote', target, string, fret }, follow: { string, fret } } };
}

export function keyTarget(ctx: EntryContext, key: number): EntryTarget {
  const { staff, target } = ctx, name = formatPitch(key);
  if (staff.isPercussion) return { name, action: null };
  if (staff.tuning.length) {
    const present = ctx.notes.find(note => note.key === key);
    if (present) return { name: `Remove ${name}`, action: { command: { type: 'removeNote', target, string: present.string }, follow: {} } };
    let best: { string: number; fret: number } | null = null;
    for (let string = 1; string <= staff.tuning.length; string++) {
      if (ctx.notes.some(note => note.string === string)) continue;
      const fret = key - openKey(staff, string);
      if (fret >= 0 && fret <= maxEntryFret && (!best || fret < best.fret)) best = { string, fret };
    }
    if (!best) return { name: `No free string can play ${name}`, action: null };
    return { name, action: { command: { type: 'setNote', target, ...best }, follow: {} } };
  }
  const pitch = key + staff.transpositionPitch, present = ctx.notes.find(note => note.written === pitch);
  if (present) return { name: `Remove ${name}`, action: { command: { type: 'removeNoteByIndex', target, noteIndex: present.index }, follow: { note: null } } };
  return { name, action: { command: { type: 'addPitchedNote', target, pitch }, follow: { note: { pitch } } } };
}

/** The default articulation of a kit piece on this track, if the track has one. The track's own table comes first, in
 *  the piece's key order. Otherwise the standard plain hit, whose id is the piece's key (such as 38, not the rim
 *  shot 91, for the snare), is preferred over the standard variants that share its output. */
export function defaultArticulation(track: model.Track, keys: readonly number[]): number | null {
  const choices = percussionChoices(track), custom = choices.filter(choice => choice.id < track.percussionArticulations.length);
  const pick = (list: typeof choices) => keys.map(key => list.find(choice => choice.outputMidiNumber === key)).find(Boolean);
  const plain = keys.map(key => choices.find(choice => choice.id === key && choice.outputMidiNumber === key)).find(Boolean);
  return (pick(custom) ?? plain ?? pick(choices))?.id ?? null;
}

export function drumTarget(ctx: EntryContext, label: string, keys: readonly number[]): EntryTarget {
  const { staff, target } = ctx;
  if (!staff.isPercussion) return { name: label, action: null };
  const present = ctx.notes.find(note => keys.includes(note.key));
  if (present) return { name: `Remove ${label}`, action: { command: { type: 'removeNoteByIndex', target, noteIndex: present.index }, follow: { note: null } } };
  const articulation = defaultArticulation(staff.track, keys);
  if (articulation === null) return { name: `${label} (no articulation on this track)`, action: null };
  return { name: label, action: { command: { type: 'addPercussionNote', target, articulation }, follow: { note: { articulation } } } };
}

/** A pad for a note outside the kit: clicking it removes the first such note. */
export function padTarget(ctx: EntryContext, key: number, label: string): EntryTarget {
  if (!ctx.staff.isPercussion) return { name: label, action: null };
  const present = ctx.notes.find(note => note.key === key);
  return present ? { name: `Remove ${label}`, action: { command: { type: 'removeNoteByIndex', target: ctx.target, noteIndex: present.index }, follow: { note: null } } } : { name: label, action: null };
}

/** The selection an edit leaves behind, read from the edited score. */
export function followEntry(score: model.Score, target: BeatTarget, follow: EntryFollow): { string?: number; fret?: number; noteIndex?: number | null } {
  const result: { string?: number; fret?: number; noteIndex?: number | null } = {};
  if (follow.string !== undefined) { result.string = follow.string; result.fret = follow.fret; }
  if (follow.note === null) result.noteIndex = null;
  else if (follow.note) {
    const notes = score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]?.notes ?? [];
    const wanted = follow.note, index = notes.findIndex(note => 'pitch' in wanted ? note.octave * 12 + note.tone === wanted.pitch : note.percussionArticulation === wanted.articulation);
    result.noteIndex = index >= 0 ? index : null;
  }
  return result;
}
