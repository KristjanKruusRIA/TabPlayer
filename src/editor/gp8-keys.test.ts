import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { gp8CursorTarget, gp8Key, planTechniqueToggle } from './gp8-keys';
import { blankProject, type BeatTarget } from '../project';
import { buildDocument } from '../engine';

const key = (name: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}, code?: string) => gp8Key({ key: name, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('GP8 keys', () => {
  it('names each key and leaves Del alone', () => {
    expect(key('Backspace')).toEqual({ kind: 'edit', edit: 'removeNote' });
    expect(key('Delete', { shiftKey: true })).toEqual({ kind: 'edit', edit: 'deleteBeats' });
    expect(key('Delete', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'edit', edit: 'eraseNotes' });
    expect(key('Insert', { metaKey: true })).toEqual({ kind: 'edit', edit: 'insertBeat' });
    expect(key('Delete')).toBeNull();
    expect(key('Backspace', { shiftKey: true })).toBeNull();
    expect(key('Home', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('End', { altKey: true })).toBeNull();
    expect(key('End', { shiftKey: true })).toEqual({ kind: 'cursor', edge: 'barEnd', extend: true });
  });
  it('recognises voice shortcuts (Ctrl+1..4, Alt+1..4, Meta+1..4)', () => {
    expect(key('1', { ctrlKey: true })).toEqual({ kind: 'voice', voiceIndex: 0 });
    expect(key('&', { altKey: true }, 'Digit1')).toEqual({ kind: 'voice', voiceIndex: 0 });
    expect(key('2', { metaKey: true })).toEqual({ kind: 'voice', voiceIndex: 1 });
    expect(key('3', { ctrlKey: true })).toEqual({ kind: 'voice', voiceIndex: 2 });
    expect(key('4', { altKey: true })).toEqual({ kind: 'voice', voiceIndex: 3 });
    // Plain digits, 5-9, or shift combinations are not voice keys
    expect(key('1')).toBeNull();
    expect(key('5', { ctrlKey: true })).toBeNull();
    expect(key('7', { ctrlKey: true })).toBeNull();
    expect(key('1', { ctrlKey: true, shiftKey: true })).toBeNull();
  });
  it('leaves Ctrl+M alone: there is no multivoice editing mode to toggle', () => {
    expect(key('m', { ctrlKey: true })).toBeNull();
    expect(key('M', { metaKey: true })).toBeNull();
  });
  it('recognises track navigation (Ctrl+Up/Down, Meta+Up/Down)', () => {
    expect(key('ArrowUp', { ctrlKey: true })).toEqual({ kind: 'track', direction: -1 });
    expect(key('ArrowDown', { metaKey: true })).toEqual({ kind: 'track', direction: 1 });
    // Note moves with Alt or Shift are not track navigation
    expect(key('ArrowUp', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('ArrowDown', { altKey: true, shiftKey: true })).toBeNull();
    expect(key('ArrowUp', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('ArrowUp')).toBeNull();
  });
  it('recognises bar jump shortcuts (Ctrl+Left/Right, Alt+Left/Right)', () => {
    expect(key('ArrowLeft', { ctrlKey: true })).toEqual({ kind: 'bar', direction: -1, extend: false });
    expect(key('ArrowRight', { altKey: true })).toEqual({ kind: 'bar', direction: 1, extend: false });
    expect(key('ArrowRight', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'bar', direction: 1, extend: true });
    expect(key('ArrowLeft')).toBeNull();
  });
  it('recognises transport shortcuts (Ctrl+Space, Ctrl+G)', () => {
    expect(key(' ', { ctrlKey: true })).toEqual({ kind: 'playBar' });
    expect(key(' ', { metaKey: true })).toEqual({ kind: 'playBar' });
    expect(key('g', { ctrlKey: true })).toEqual({ kind: 'goToBar' });
    expect(key('G', { metaKey: true })).toEqual({ kind: 'goToBar' });
    expect(key(' ')).toBeNull();
    expect(key('g')).toBeNull();
  });
  it('recognises technique letter shortcuts (H, S, V, P, I, X)', () => {
    expect(key('h')).toEqual({ kind: 'technique', technique: 'hammerPull' });
    expect(key('H', { shiftKey: true })).toEqual({ kind: 'technique', technique: 'hammerPull' });
    expect(key('s')).toEqual({ kind: 'technique', technique: 'slide' });
    expect(key('v')).toEqual({ kind: 'technique', technique: 'vibrato' });
    expect(key('p')).toEqual({ kind: 'technique', technique: 'palmMute' });
    expect(key('i')).toEqual({ kind: 'technique', technique: 'letRing' });
    expect(key('x')).toEqual({ kind: 'technique', technique: 'dead' });
    // Modifiers like Ctrl or Alt mean document shortcuts (Ctrl+S save, Ctrl+P palette, Ctrl+V paste, etc.)
    expect(key('s', { ctrlKey: true })).toBeNull();
    expect(key('v', { metaKey: true })).toBeNull();
    expect(key('p', { ctrlKey: true })).toBeNull();
    expect(key('h', { altKey: true })).toBeNull();
  });
  it('finds the cursor targets', () => {
    const at = { track: 0, staff: 0, bar: 2, voice: 0, beat: 1 };
    expect(gp8CursorTarget('barStart', at, 4, 5)).toEqual({ ...at, beat: 0 });
    expect(gp8CursorTarget('barEnd', at, 4, 5)).toEqual({ ...at, beat: 3 });
    expect(gp8CursorTarget('scoreStart', at, 4, 5)).toEqual({ ...at, bar: 0, beat: 0 });
    expect(gp8CursorTarget('scoreEnd', at, 4, 5)).toEqual({ ...at, bar: 4, beat: 0 });
  });

  it('plans technique toggles on notes', () => {
    const target: BeatTarget = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
    const nextTarget: BeatTarget = { track: 0, staff: 0, bar: 0, voice: 0, beat: 1 };
    const project = {
      ...blankProject(),
      edits: [
        { type: 'setNote', target, string: 1, fret: 5 },
        { type: 'setNote', target: nextTarget, string: 1, fret: 7 },
      ],
    };
    const { score } = buildDocument(project as any);

    // Palm mute toggle
    expect(planTechniqueToggle(score, target, 1, null, 'palmMute')).toEqual({
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { palmMute: true },
    });

    // Let ring toggle
    expect(planTechniqueToggle(score, target, 1, null, 'letRing')).toEqual({
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { letRing: true },
    });

    // Vibrato toggle
    expect(planTechniqueToggle(score, target, 1, null, 'vibrato')).toEqual({
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { vibrato: 1 },
    });

    // Dead note toggle
    expect(planTechniqueToggle(score, target, 1, null, 'dead')).toEqual({
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { dead: true },
    });

    // Slide toggle to next note
    expect(planTechniqueToggle(score, target, 1, null, 'slide')).toEqual({
      type: 'setNoteTechniques',
      target,
      string: 1,
      patch: { slideOut: 1 },
    });

    // Hammer-on/pull-off to next note
    expect(planTechniqueToggle(score, target, 1, null, 'hammerPull')).toEqual({
      type: 'setNoteLink',
      from: { target, string: 1 },
      to: { target: nextTarget, string: 1 },
      kind: 'hammerPull',
    });

    // When beat has no note on string 2
    expect(planTechniqueToggle(score, target, 2, null, 'palmMute')).toBeNull();
  });
  it('addresses the only note of a staff without strings by its index', () => {
    const score = music(), staff = score.tracks[0].staves[0];
    staff.stringTuning.tunings = [];
    for (const bar of staff.bars) for (const beat of bar.voices[0].beats) for (const note of beat.notes) { note.string = -1; note.fret = -1; note.octave = 5; note.tone = 0; }
    score.finish(new Settings());
    const target: BeatTarget = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
    expect(planTechniqueToggle(score, target, null, null, 'vibrato')).toEqual({
      type: 'setNoteTechniquesByIndex', target, noteIndex: 0, patch: { vibrato: model.VibratoType.Slight },
    });
  });
});
