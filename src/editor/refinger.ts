import { model } from '@coderline/alphatab';
import type { PartialCapo } from './partial-capo';
import { getPartialCapo, stringCapo } from './partial-capo';
import { getBanjoDrone, neckFret, fretExists, droneShift } from './banjo-drone';
import { allNotes, captureNoteLinks } from './links';
import { placeBeat, maxRelocatedFret, holds, linked, type Place } from './structure';
import { formatPitch } from '../tuning';
import { getMessage, getResolvedLanguage } from '../i18n';
import type { MessageKey } from '../i18n';

export interface RefingerStaffTarget {
  tuning: readonly number[];
  capo?: number;
  partialCapo?: PartialCapo | null;
  droneFret?: number;
  transposition?: number;
}

/** Whether two beats of different voices sound at the same time. */
const sounding = (a: model.Beat, b: model.Beat) =>
  a.playbackStart < b.playbackStart + b.playbackDuration && b.playbackStart < a.playbackStart + a.playbackDuration;

/** A note keep pitch could not place, named so the user can find it. Numbers count from 1; `beat` skips grace beats. */
export interface Unreachable {
  staff: number; voice: number; bar: number; beat: number; grace: boolean; string: number; pitch: string;
  reason: 'range' | 'harmonic' | 'linked' | 'conflict';
}

const beatNumber = (beat: model.Beat) => beat.voice.beats.filter(b => b.index < beat.index && b.graceType === model.GraceType.None).length + 1;

const reasonKeys: Record<Unreachable['reason'], MessageKey> = {
  range: 'refinger.reason_range',
  harmonic: 'refinger.reason_harmonic',
  linked: 'refinger.reason_linked',
  conflict: 'refinger.reason_conflict',
};

/** The message listing every note that could not be placed, in the interface language. */
export function describeUnreachable(list: readonly Unreachable[]): string {
  const language = getResolvedLanguage();
  const items = list.map(item => getMessage(language, item.grace ? 'refinger.where_grace' : 'refinger.where', {
    staff: item.staff, voice: item.voice, bar: item.bar, beat: item.beat, string: item.string, pitch: item.pitch,
  }) + ': ' + getMessage(language, reasonKeys[item.reason]));
  return getMessage(language, 'refinger.cannot_place', { list: items.join('; ') });
}

export function planStaffRefinger(
  staff: model.Staff,
  target: RefingerStaffTarget
): { moves: Array<{ note: model.Note } & Place>; unreachable: Unreachable[] } {
  const to = target.tuning.length;
  if (to !== staff.tuning.length) {
    throw new Error('Retuning must keep the current string count.');
  }

  const targetTuning = target.tuning;
  const targetCapo = target.capo ?? staff.capo;
  const targetPartial = target.partialCapo === undefined ? getPartialCapo(staff) : target.partialCapo;
  const targetDrone = target.droneFret === undefined ? getBanjoDrone(staff) : target.droneFret;
  // Keep pitch compensates for tuning, capo and drone only: a changed transposition changes what sounds, as it always has.
  const targetTransposition = target.transposition ?? staff.transpositionPitch;

  const currentPartial = getPartialCapo(staff);
  const currentDrone = getBanjoDrone(staff);
  const currentTransposition = staff.transpositionPitch;

  const targetOpenPitch = (s: number) => {
    const capo = targetPartial && targetPartial.strings.includes(s) ? Math.max(targetCapo, targetPartial.fret) : targetCapo;
    return targetTuning[to - s] + capo - currentTransposition;
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
  const unreachable: Unreachable[] = [];

  for (const bar of staff.bars) {
    // Beats already placed in this bar, so a note in another voice that sounds at the same time keeps off their strings.
    const placed: Array<{ beat: model.Beat; strings: Map<model.Note, number> }> = [];
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const notes = beat.notes.filter(n => n.string > 0);
        if (!notes.length) continue;
        const where = `bar ${bar.index + 1}, beat ${beat.index + 1}`;
        const overlapping = placed.filter(other => other.beat.voice !== voice && sounding(other.beat, beat));
        // A string two voices already shared before the edit may stay shared.
        const taken = (note: model.Note) =>
          new Set(overlapping.flatMap(other => [...other.strings].filter(([from]) => from.string !== note.string).map(([, string]) => string)));
        const keptHere = (note: model.Note) => {
          const place = kept(note);
          return place && taken(note).has(place.string) ? null : place;
        };
        const choicesHere = (note: model.Note) => {
          const busy = taken(note);
          return choices(note).filter(choice => !busy.has(choice.string));
        };
        const fail = () => {
          const blocked = new Map<model.Note, Unreachable['reason']>();
          for (const note of notes) {
            const place = keptHere(note);
            const stays = place !== null && place.fret >= 0 && place.fret <= Math.max(maxRelocatedFret, note.fret) && (!note.harmonicType || place.fret === note.fret);
            if (stays) continue;
            if (note.harmonicType) blocked.set(note, 'harmonic');
            else if (linked(note)) blocked.set(note, 'linked');
            else if (!choicesHere(note).length) blocked.set(note, 'range');
          }
          // No single note is at fault: the notes of the beat compete for the strings.
          if (!blocked.size) for (const note of notes) blocked.set(note, 'conflict');
          for (const [note, reason] of blocked) {
            unreachable.push({
              staff: staff.index + 1, voice: voice.index + 1, bar: bar.index + 1, beat: beatNumber(beat),
              grace: beat.graceType !== model.GraceType.None, string: note.string,
              pitch: note.isDead ? 'x' : formatPitch(notePitch(note)), reason,
            });
          }
        };
        try {
          const planned = placeBeat(notes, keptHere, choicesHere, false, where) ?? placeBeat(notes, keptHere, choicesHere, true, where);
          if (!planned) {
            fail();
          } else {
            for (const [note, place] of planned) {
              moves.push({ note, ...place });
            }
            placed.push({ beat, strings: new Map([...planned].map(([note, place]) => [note, place.string])) });
          }
        } catch {
          fail();
        }
      }
    }
  }

  // The moved notes keep their pitch only for the old transposition; check what they sound at the new one.
  for (const { note, string, fret } of moves) {
    const sounding = targetOpenPitch(string) + currentTransposition - targetTransposition + fret + droneShift(staff, string, fret, targetDrone) + note.harmonicPitch;
    if (!Number.isFinite(sounding) || sounding < 0 || sounding > 127) {
      throw new Error('Staff settings put a note outside the playable MIDI pitch range.');
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
    throw new Error(describeUnreachable(unreachable));
  }
  validateNoteLinks(staff.track.score, moves);
  for (const { note, string, fret } of moves) {
    note.string = string;
    note.fret = fret;
  }
}

export function refingerTrack(track: model.Track, target: RefingerStaffTarget): void {
  const allMoves: Array<{ note: model.Note } & Place> = [];
  const allUnreachable: Unreachable[] = [];

  for (const staff of track.staves) {
    const { moves, unreachable } = planStaffRefinger(staff, target);
    allMoves.push(...moves);
    allUnreachable.push(...unreachable);
  }

  if (allUnreachable.length > 0) {
    throw new Error(describeUnreachable(allUnreachable));
  }

  validateNoteLinks(track.score, allMoves);
  for (const { note, string, fret } of allMoves) {
    note.string = string;
    note.fret = fret;
  }
}
