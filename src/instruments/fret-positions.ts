import type { model } from '@coderline/alphatab';
import type { PlanNote } from '../audio/types';
import { fretExists, neckFret, plainFret } from '../editor/banjo-drone';

/** What a note needs to be placed on the neck: where it is in the score, its string and its sounding key. */
export type PositionNote = Pick<PlanNote, 'id' | 'key' | 'source'> & { held?: boolean };
/** A mark on the neck: a string (1 is the lowest) and the fret written for it, which counts from the capo on that string. */
export interface FretPosition<N extends PositionNote = PositionNote> { id: string; key: number; string: number; fret: number; note?: N; held?: boolean }

/**
 * Where the shown notes sit on one staff's neck. The instrument view draws these marks and the Fretlight LEDs light them, so
 * both read the same positions. Notes of other staves, notes off the staff's strings and notes with no fret are left out.
 */
export function fretPositions<N extends PositionNote>(staff: model.Staff, notes: readonly N[]): FretPosition<N>[] {
  const positions: FretPosition<N>[] = [];
  for (const note of notes) {
    if (note.source.target.staff !== staff.index) continue;
    const { target, string } = note.source, beat = staff.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
    const source = beat?.notes.find(n => n.string === string);
    if (string < 1 || string > staff.tuning.length || (!source && !beat?.deadSlapped)) continue;
    // Trills and ornaments retain their source string; harmonics retain their
    // authored touch position rather than moving to a guessed sounding fret.
    const fret = beat?.deadSlapped ? 0 : source!.harmonicType === 0 && (!source!.isDead || fretExists(staff, string, source!.fret)) ? neckFret(staff, string, plainFret(staff, string, source!.fret) + note.key - source!.realValue) : source!.fret;
    if (fret >= 0) positions.push({ id: note.id, key: note.key, string, fret, note, held: note.held });
  }
  return positions;
}
