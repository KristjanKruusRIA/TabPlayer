import { model } from '@coderline/alphatab';
import type { PartialCapo } from './partial-capo';
import { getPartialCapo, stringCapo } from './partial-capo';
import { getBanjoDrone, neckFret, fretExists, droneShift } from './banjo-drone';
import { allNotes, captureNoteLinks } from './links';
import { placeBeat, maxRelocatedFret, holds, type Place } from './structure';

export interface RefingerStaffTarget {
  tuning: readonly number[];
  capo?: number;
  partialCapo?: PartialCapo | null;
  droneFret?: number;
  transposition?: number;
}

export function planStaffRefinger(
  staff: model.Staff,
  target: RefingerStaffTarget
): { moves: Array<{ note: model.Note } & Place>; unreachable: string[] } {
  const to = target.tuning.length;
  if (to !== staff.tuning.length) {
    throw new Error('Retuning must keep the current string count.');
  }

  const targetTuning = target.tuning;
  const targetCapo = target.capo ?? staff.capo;
  const targetPartial = target.partialCapo === undefined ? getPartialCapo(staff) : target.partialCapo;
  const targetDrone = target.droneFret === undefined ? getBanjoDrone(staff) : target.droneFret;
  const targetTransposition = target.transposition ?? staff.transpositionPitch;

  const currentPartial = getPartialCapo(staff);
  const currentDrone = getBanjoDrone(staff);
  const currentTransposition = staff.transpositionPitch;

  const targetOpenPitch = (s: number) => {
    const capo = targetPartial && targetPartial.strings.includes(s) ? Math.max(targetCapo, targetPartial.fret) : targetCapo;
    return targetTuning[to - s] + capo - targetTransposition;
  };

  const notePitch = (note: model.Note) => {
    return (
      staff.tuning[staff.tuning.length - note.string] +
      note.fret +
      stringCapo(staff, note.string, currentPartial) +
      droneShift(staff, note.string, note.fret, currentDrone) -
      currentTransposition
    );
  };

  const choices = (note: model.Note): Place[] => {
    if (note.isDead) {
      return Array.from({ length: to }, (_, i) => to - i).map(s => ({
        string: s,
        fret: Math.min(note.fret, maxRelocatedFret),
      }));
    }
    const p = notePitch(note);
    const result: Place[] = [];
    for (let s = 1; s <= to; s++) {
      const open = targetOpenPitch(s);
      const plain = p - open;
      if (plain < 0) continue;
      const fret = neckFret(staff, s, plain, targetDrone);
      if (fret >= 0 && fret <= Math.max(maxRelocatedFret, note.fret) && fretExists(staff, s, fret, targetDrone)) {
        result.push({ string: s, fret });
      }
    }
    return result.sort((a, b) => {
      if (a.string === note.string && b.string !== note.string) return -1;
      if (b.string === note.string && a.string !== note.string) return 1;
      const distA = Math.abs(a.string - note.string);
      const distB = Math.abs(b.string - note.string);
      if (distA !== distB) return distA - distB;
      return a.fret - b.fret;
    });
  };

  const kept = (note: model.Note): Place | null => {
    if (note.isDead) return { string: note.string, fret: note.fret };
    const p = notePitch(note);
    const open = targetOpenPitch(note.string);
    const plain = p - open;
    if (plain < 0) return null;
    const fret = neckFret(staff, note.string, plain, targetDrone);
    if (fret >= 0 && fret <= Math.max(maxRelocatedFret, note.fret) && fretExists(staff, note.string, fret, targetDrone)) {
      return { string: note.string, fret };
    }
    return null;
  };

  const moves: Array<{ note: model.Note } & Place> = [];
  const unreachable: string[] = [];

  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const notes = beat.notes.filter(n => n.string > 0);
        if (!notes.length) continue;
        const where = `bar ${bar.index + 1}, beat ${beat.index + 1}`;
        try {
          const planned = placeBeat(notes, kept, choices, false, where) ?? placeBeat(notes, kept, choices, true, where);
          if (!planned) {
            unreachable.push(where);
          } else {
            for (const [note, place] of planned) {
              moves.push({ note, ...place });
            }
          }
        } catch {
          unreachable.push(where);
        }
      }
    }
  }

  return { moves, unreachable };
}

export function validateNoteLinks(
  score: model.Score,
  moves: Array<{ note: model.Note } & Place>
): void {
  const proposed = new Map(moves.map(m => [m.note, m]));
  const lookup = new Map(allNotes(score).map(n => [n.id, n]));

  for (const link of captureNoteLinks(score)) {
    if (link.kind === 'slur') continue;
    const from = lookup.get(link.from)!, to = lookup.get(link.to)!;
    if (!from || !to) continue;
    if (
      holds(from, to, n => n.string) &&
      !holds(from, to, n => proposed.get(n)?.string ?? n.string)
    ) {
      throw new Error(
        `The edit would break the next-note relationship from bar ${from.beat.voice.bar.index + 1}, beat ${from.beat.index + 1} on its string.`
      );
    }
  }
}

export function refingerStaff(staff: model.Staff, target: RefingerStaffTarget): void {
  const { moves, unreachable } = planStaffRefinger(staff, target);
  if (unreachable.length > 0) {
    throw new Error(`Notes cannot be reached in the new tuning or capo: ${unreachable.join('; ')}.`);
  }
  validateNoteLinks(staff.track.score, moves);
  for (const { note, string, fret } of moves) {
    note.string = string;
    note.fret = fret;
  }
}

export function refingerTrack(track: model.Track, target: RefingerStaffTarget): void {
  const allMoves: Array<{ note: model.Note } & Place> = [];
  const allUnreachable: string[] = [];

  for (const staff of track.staves) {
    const { moves, unreachable } = planStaffRefinger(staff, target);
    allMoves.push(...moves);
    allUnreachable.push(...unreachable);
  }

  if (allUnreachable.length > 0) {
    throw new Error(`Notes cannot be reached in the new tuning or capo: ${allUnreachable.join('; ')}.`);
  }

  validateNoteLinks(track.score, allMoves);
  for (const { note, string, fret } of allMoves) {
    note.string = string;
    note.fret = fret;
  }
}
