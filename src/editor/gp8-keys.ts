import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { EditCommand, IndexedNoteTarget, NoteTarget, NoteTechniques } from '../edit-types';
import { describeSelection } from '../engine';
import { selectedNote } from './score-entry';
import { nextLinkedNote } from './techniques';

/** The Guitar Pro 8 edit and cursor keys that are not note entry. */
export type Gp8Technique = 'hammerPull' | 'slide' | 'vibrato' | 'palmMute' | 'letRing' | 'dead';

export type Gp8Key =
  | { kind: 'edit'; edit: 'removeNote' | 'deleteBeats' | 'insertBeat' | 'eraseNotes' }
  | { kind: 'cursor'; edge: 'barStart' | 'barEnd' | 'scoreStart' | 'scoreEnd'; extend: boolean }
  | { kind: 'voice'; voiceIndex: number }
  | { kind: 'multivoice' }
  | { kind: 'track'; direction: -1 | 1 }
  | { kind: 'bar'; direction: -1 | 1; extend: boolean }
  | { kind: 'playBar' }
  | { kind: 'goToBar' }
  | { kind: 'technique'; technique: Gp8Technique };

export type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** Which of these keys the event is, or null. Del alone, Ctrl+Shift+Home and unknown modifiers are not theirs. */
export function gp8Key(event: KeyLike): Gp8Key | null {
  const ctrl = event.ctrlKey || event.metaKey, { altKey: alt, shiftKey: shift, key, code } = event;

  // Voice shortcuts: Ctrl+1..4, Alt+1..4, Meta+1..4 (without Shift).
  // Read code or key, clamped strictly to 1..4. (Digits 7..9 with Ctrl/Alt are accidental chords in score-entry).
  if ((ctrl || alt) && !shift) {
    const digitMatch = code ? /^Digit([1-4])$/.exec(code) : null;
    const digitNum = digitMatch ? Number(digitMatch[1]) : (/^[1-4]$/.test(key) ? Number(key) : null);
    if (digitNum !== null) {
      return { kind: 'voice', voiceIndex: digitNum - 1 };
    }
  }

  // Multivoice toggle: Ctrl+M / Meta+M (no Alt, no Shift)
  if (ctrl && !alt && !shift && (key === 'm' || key === 'M')) {
    return { kind: 'multivoice' };
  }

  // Track navigation: Ctrl+Up / Ctrl+Down (no Alt, no Shift)
  if (ctrl && !alt && !shift && (key === 'ArrowUp' || key === 'ArrowDown')) {
    return { kind: 'track', direction: key === 'ArrowUp' ? -1 : 1 };
  }

  // Bar jump: Ctrl+Left / Ctrl+Right or Alt+Left / Alt+Right
  if ((ctrl || alt) && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return { kind: 'bar', direction: key === 'ArrowRight' ? 1 : -1, extend: shift };
  }

  // Transport: Ctrl+Space (play bar), Ctrl+G (go to bar)
  if (ctrl && !alt && !shift) {
    if (key === ' ' || code === 'Space') return { kind: 'playBar' };
    if (key === 'g' || key === 'G') return { kind: 'goToBar' };
  }

  // Technique keys: H, S, V, P, I, X (no Ctrl, no Meta, no Alt)
  if (!ctrl && !alt) {
    const k = key.toLowerCase();
    if (k === 'h') return { kind: 'technique', technique: 'hammerPull' };
    if (k === 's') return { kind: 'technique', technique: 'slide' };
    if (k === 'v') return { kind: 'technique', technique: 'vibrato' };
    if (k === 'p') return { kind: 'technique', technique: 'palmMute' };
    if (k === 'i') return { kind: 'technique', technique: 'letRing' };
    if (k === 'x') return { kind: 'technique', technique: 'dead' };
  }

  // Existing edit and Home/End cursor keys: reject Alt
  if (alt) return null;
  const home = key === 'Home';
  if (key === 'Backspace') return !ctrl && !shift ? { kind: 'edit', edit: 'removeNote' } : null;
  if (key === 'Delete') return shift ? { kind: 'edit', edit: ctrl ? 'eraseNotes' : 'deleteBeats' } : null;
  if (key === 'Insert') return ctrl && !shift ? { kind: 'edit', edit: 'insertBeat' } : null;
  if (key !== 'Home' && key !== 'End') return null;
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

/** Plans a technique toggle on the note at the cursor, or null if inapplicable (no note, not stringed for guitar techniques, etc.). */
export function planTechniqueToggle(
  score: model.Score,
  target: BeatTarget,
  string: number | null,
  noteIndex: number | null,
  technique: Gp8Technique
): EditCommand | null {
  const { staff, beat } = describeSelection(score, target);
  if (!beat) return null;
  const indexed = staff.isPercussion || !staff.tuning.length;
  const note = indexed
    ? (noteIndex !== null ? beat.notes[noteIndex] : (beat.notes.length === 1 ? beat.notes[0] : null))
    : (string !== null ? beat.notes.find(n => n.string === string) : (beat.notes.length === 1 ? beat.notes[0] : null));
  if (!note) return null;

  const address = (current: model.Note): NoteTarget | IndexedNoteTarget => {
    const loc = {
      track: target.track,
      staff: target.staff,
      voice: target.voice,
      bar: current.beat.voice.bar.index,
      beat: current.beat.index,
    };
    return indexed
      ? { target: loc, noteIndex: current.beat.notes.indexOf(current) }
      : { target: loc, string: current.string };
  };

  const patchNote = (patch: NoteTechniques): EditCommand => {
    return indexed && noteIndex !== null
      ? { type: 'setNoteTechniquesByIndex', target, noteIndex, patch }
      : { type: 'setNoteTechniques', target, string: string ?? note.string, patch };
  };

  switch (technique) {
    case 'hammerPull': {
      if (!note.isStringed) return null;
      if (note.isHammerPullOrigin) {
        return indexed && noteIndex !== null
          ? { type: 'setNoteLinkByIndex', from: { target, noteIndex }, to: null, kind: 'hammerPull' }
          : { type: 'setNoteLink', from: { target, string: note.string }, to: null, kind: 'hammerPull' };
      }
      if (note.hammerPullOrigin) {
        const from = address(note.hammerPullOrigin);
        return 'noteIndex' in from
          ? { type: 'setNoteLinkByIndex', from, to: null, kind: 'hammerPull' }
          : { type: 'setNoteLink', from, to: null, kind: 'hammerPull' };
      }
      const dest = nextLinkedNote(note);
      if (!dest) return null;
      const to = address(dest);
      return indexed && noteIndex !== null
        ? { type: 'setNoteLinkByIndex', from: { target, noteIndex }, to: to as IndexedNoteTarget, kind: 'hammerPull' }
        : { type: 'setNoteLink', from: { target, string: note.string }, to: to as NoteTarget, kind: 'hammerPull' };
    }
    case 'slide': {
      if (!note.isStringed) return null;
      const hasSlide = (note.slideOutType ?? 0) !== 0 || (note.slideInType ?? 0) !== 0;
      if (hasSlide) {
        return patchNote({ slideOut: 0, slideIn: 0 });
      }
      const dest = nextLinkedNote(note);
      if (!dest) return null;
      return patchNote({ slideOut: model.SlideOutType.Shift });
    }
    case 'vibrato': {
      if (note.isPercussion) return null;
      const active = (note.vibrato ?? 0) !== 0;
      return patchNote({ vibrato: active ? 0 : model.VibratoType.Slight });
    }
    case 'palmMute': {
      if (!note.isStringed) return null;
      return patchNote({ palmMute: !note.isPalmMute });
    }
    case 'letRing': {
      if (!note.isStringed) return null;
      return patchNote({ letRing: !note.isLetRing });
    }
    case 'dead': {
      if (!note.isStringed) return null;
      return patchNote({ dead: !note.isDead });
    }
  }
}
