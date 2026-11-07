import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';

/** The Guitar Pro 8 edit and cursor keys that are not note entry. */
export type Gp8Key =
  | { kind: 'edit'; edit: 'removeNote' | 'deleteBeats' | 'insertBeat' | 'eraseNotes' }
  | { kind: 'cursor'; edge: 'barStart' | 'barEnd' | 'scoreStart' | 'scoreEnd'; extend: boolean };

type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** Which of these keys the event is, or null. Del alone, Ctrl+Shift+Home and anything with Alt are not theirs. */
export function gp8Key(event: KeyLike): Gp8Key | null {
  if (event.altKey) return null;
  const ctrl = event.ctrlKey || event.metaKey, { shiftKey: shift, key } = event;
  if (key === 'Backspace') return !ctrl && !shift ? { kind: 'edit', edit: 'removeNote' } : null;
  if (key === 'Delete') return shift ? { kind: 'edit', edit: ctrl ? 'eraseNotes' : 'deleteBeats' } : null;
  if (key === 'Insert') return ctrl && !shift ? { kind: 'edit', edit: 'insertBeat' } : null;
  if (key !== 'Home' && key !== 'End') return null;
  const home = key === 'Home';
  if (ctrl) return shift ? null : { kind: 'cursor', edge: home ? 'scoreStart' : 'scoreEnd', extend: false };
  return { kind: 'cursor', edge: home ? 'barStart' : 'barEnd', extend: shift };
}

/** Where a cursor key goes: Home and End to the bar's first and last beat, Ctrl+Home to the first bar and Ctrl+End to the last bar's first beat. */
export function gp8CursorTarget(edge: Extract<Gp8Key, { kind: 'cursor' }>['edge'], target: BeatTarget, beatsInBar: number, bars: number): BeatTarget {
  if (edge === 'barStart') return { ...target, beat: 0 };
  if (edge === 'barEnd') return { ...target, beat: Math.max(0, beatsInBar - 1) };
  return { ...target, bar: edge === 'scoreStart' ? 0 : Math.max(0, bars - 1), beat: 0 };
}

/** The address of a beat, as the edits take it. */
export function beatAddress(beat: model.Beat): BeatTarget {
  const voice = beat.voice, bar = voice.bar, staff = bar.staff;
  return { track: staff.track.index, staff: staff.index, bar: bar.index, voice: voice.index, beat: beat.index };
}
