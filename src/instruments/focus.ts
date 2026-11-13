import type { model } from '@coderline/alphatab';
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
const chordStarts = new WeakMap<readonly PlanNote[], ReadonlyMap<PlanNote, number>>();
/**
 * Where each note's onset counts from: a chord is one onset even when a brush spreads its notes in time, so a note
 * counts from the earliest first attack of its beat. Worked out once per plan, not on every status update.
 */
export function onsetStarts(notes: readonly PlanNote[]): ReadonlyMap<PlanNote, number> {
  let starts = chordStarts.get(notes);
  if (starts) return starts;
  const beatOf = (note: PlanNote) => { const at = note.source.target; return `${at.track}/${at.staff}/${at.bar}/${at.voice}/${at.beat}/${note.occurrence}/${note.playedBar ?? ''}`; };
  const first = (note: PlanNote) => note.id.endsWith('/0');
  const beats = new Map<string, number>();
  for (const note of notes) if (first(note)) { const key = beatOf(note); beats.set(key, Math.min(beats.get(key) ?? Infinity, note.startTick)); }
  starts = new Map(notes.map(note => [note, first(note) ? beats.get(beatOf(note))! : note.startTick]));
  chordStarts.set(notes, starts);
  return starts;
}
/** The notes of the first onset at or after `from` and before `until`. */
function onset(notes: readonly PlanNote[], starts: ReadonlyMap<PlanNote, number>, from: number, until: number) {
  let next = Infinity;
  for (const note of notes) { const at = starts.get(note)!; if (at >= from && at < until && at < next) next = at; }
  return notes.filter(note => starts.get(note) === next);
}

/** Picks the notes the instrument view shows for the chosen focus. */
export function focusNotes(focus: InstrumentFocus, {active,notes,beats,tick,counting,loop,range,target}: FocusInput): readonly PlanNote[] {
  if (focus === 'playing') return active;
  if (!target) return [];
  // Only the next-notes focus needs them, and they are kept per plan.
  const starts = () => onsetStarts(notes);
  const staff = notes.filter(note => note.source.target.track === target.track && note.source.target.staff === target.staff);
  const inBar = staff.filter(note => playedBar(note) === target.bar);
  const inBeat = () => firstPass(inBar.filter(({source:{target:at}}) => at.voice === target.voice && at.beat === target.beat));
  if (focus === 'bar') return firstPass(inBar);
  if (focus === 'beat') return inBeat();
  if (tick !== null) {
    // A count-in leads to the notes at the playback position; otherwise the next onset follows it.
    const from = counting ? tick : tick + 1e-6;
    if (loop && tick < loop.endTick) {
      const ahead = onset(staff, starts(), from, loop.endTick);
      return ahead.length ? ahead : onset(staff, starts(), loop.startTick, loop.endTick);
    }
    return onset(staff, starts(), from, range?.endTick ?? Infinity);
  }
  // Stopped: the beat after the selected beat's first performance, from its own start rather than its grace notes.
  let start = Infinity;
  for (const row of beats) {
    const at = row.target;
    if (at.track === target.track && at.staff === target.staff && at.bar === target.bar && at.voice === target.voice && at.beat === target.beat) start = Math.min(start, row.startTick);
  }
  if (start === Infinity) start = Math.min(...inBeat().map(note => note.startTick));
  return start === Infinity ? [] : onset(staff, starts(), start + 1e-6, Infinity);
}

/** A note the view shows as held: the continuation of an earlier note by a tie. */
export type HeldNote = Pick<PlanNote, 'id' | 'key' | 'source'> & { /** Its place in the beat's notes. */ index: number };
/**
 * The tied continuations of the selected beat or bar. The playback plan sounds a tied note once, at its first attack, so
 * a beat that only continues a tie has no planned note of its own; the score still has it. Playing and next-beat views follow
 * the plan, where the earlier note is still sounding, and show none.
 */
export function heldNotes(score: model.Score, focus: InstrumentFocus, target: BeatTarget | null): HeldNote[] {
  if (!target || (focus !== 'beat' && focus !== 'bar')) return [];
  const bar = score.tracks[target.track]?.staves[target.staff]?.bars[target.bar];
  if (!bar) return [];
  const held: HeldNote[] = [];
  bar.voices.forEach((voice, voiceIndex) => {
    if (focus === 'beat' && voiceIndex !== target.voice) return;
    voice.beats.forEach((beat, beatIndex) => {
      if (focus === 'beat' && beatIndex !== target.beat) return;
      beat.notes.forEach((note, index) => {
        if (!note.isTieDestination) return;
        held.push({ index, id: `held/${target.track}/${target.staff}/${target.bar}/${voiceIndex}/${beatIndex}/${index}`, key: note.realValue, source: { target: { track: target.track, staff: target.staff, bar: target.bar, voice: voiceIndex, beat: beatIndex }, string: Math.max(0, note.string) } });
      });
    });
  });
  return held;
}
