import type { PlanNote } from '../audio/types';
import type { PerformedBeat, PlaybackSpan } from '../audio/selection-playback-types';
import type { BeatTarget } from '../project';

export type InstrumentFocus = 'playing' | 'beat' | 'bar' | 'next';
export interface ScheduledNotes {
  /** Every planned note of the viewed track. */
  notes: readonly PlanNote[];
  /** Where each written beat sounds in the performance. */
  beats: readonly PerformedBeat[];
  /** The playback tick while playing, paused or counting in; null when stopped or finished. */
  tick: number | null;
  /** True while the count-in plays before the notes at `tick`. */
  counting: boolean;
  loop: PlaybackSpan | null;
  range: PlaybackSpan | null;
}
export interface FocusInput extends ScheduledNotes {
  /** Notes sounding at the playback position. */
  active: readonly PlanNote[];
  target: BeatTarget | null;
}

/** The measure a note sounds in: a repeat-bar ("%") note belongs to the bar that repeats it. */
const playedBar = (note: PlanNote) => note.playedBar ?? note.source.target.bar;
/** Keeps the notes of the first performance of a repeated passage. */
function firstPass(notes: readonly PlanNote[]) {
  const occurrence = Math.min(...notes.map(note => note.occurrence));
  return notes.filter(note => note.occurrence === occurrence);
}
/** The notes that start at the first onset at or after `from` and before `until`. */
function onset(notes: readonly PlanNote[], from: number, until: number) {
  let next = Infinity;
  for (const note of notes) if (note.startTick >= from && note.startTick < until && note.startTick < next) next = note.startTick;
  return notes.filter(note => note.startTick === next);
}

/** Picks the notes the instrument view shows for the chosen focus. */
export function focusNotes(focus: InstrumentFocus, {active,notes,beats,tick,counting,loop,range,target}: FocusInput): readonly PlanNote[] {
  if (focus === 'playing') return active;
  if (!target) return [];
  const staff = notes.filter(note => note.source.target.track === target.track && note.source.target.staff === target.staff);
  const inBar = staff.filter(note => playedBar(note) === target.bar);
  const inBeat = () => firstPass(inBar.filter(({source:{target:at}}) => at.voice === target.voice && at.beat === target.beat));
  if (focus === 'bar') return firstPass(inBar);
  if (focus === 'beat') return inBeat();
  if (tick !== null) {
    // A count-in leads to the notes at the playback position; otherwise the next onset follows it.
    const from = counting ? tick : tick + 1e-6;
    if (loop && tick < loop.endTick) {
      const ahead = onset(staff, from, loop.endTick);
      return ahead.length ? ahead : onset(staff, loop.startTick, loop.endTick);
    }
    return onset(staff, from, range?.endTick ?? Infinity);
  }
  // Stopped: the beat after the selected beat's first performance, from its own start rather than its grace notes.
  let start = Infinity;
  for (const row of beats) {
    const at = row.target;
    if (at.track === target.track && at.staff === target.staff && at.bar === target.bar && at.voice === target.voice && at.beat === target.beat) start = Math.min(start, row.startTick);
  }
  if (start === Infinity) start = Math.min(...inBeat().map(note => note.startTick));
  return start === Infinity ? [] : onset(staff, start + 1e-6, Infinity);
}
