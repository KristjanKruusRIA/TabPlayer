import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { previewEdit } from '../engine';
import { blankProject, type BeatTarget, type EditCommand, type Project } from '../project';
import { paletteGroups, type PaletteControl, type PaletteItem } from './palette-actions';

const at = (beat: number, bar = 0): BeatTarget => ({ track: 0, staff: 0, bar, voice: 0, beat });

/** Bar 1 (a blank score's four quarter beats): four quarter notes, each a two-string chord at frets 5 and 7, every note at dynamic mf; bar 2 untouched. */
function build(): Project {
  let project: Project = blankProject();
  const apply = (edit: EditCommand) => { project = previewEdit(project, edit).project; };
  for (let beat = 0; beat < 4; beat++) {
    apply({ type: 'setNote', target: at(beat), string: 3, fret: 5 });
    apply({ type: 'setNote', target: at(beat), string: 2, fret: 7 });
  }
  return project;
}
const base = build();
const scoreOf = (project: Project) => previewEdit(project, { type: 'setScoreMetadata', fields: { subTitle: '', album: '', words: '', music: '', copyright: '', tab: '', notices: '', instructions: '' } }).score;
const controls = (score: model.Score, target = at(0), string = 3) => paletteGroups(score, target, string, null).flatMap(group => group.controls);
const find = (list: PaletteControl[], id: string) => { const control = list.find(c => c.id === id); if (!control) throw new Error(`no ${id}`); return control; };
const editOf = (item: PaletteItem) => { const result = item.activate(); if (!result || !('edit' in result)) throw new Error(`${item.id} gave no edit`); return result.edit; };

describe('edition palette controls', () => {
  const score = scoreOf(base);

  it('offers note effects only where a note is selected', () => {
    // String 6 has no note at this beat: note effects are off, beat and bar controls stay on.
    const empty = controls(score, at(0), 6);
    for (const id of ['heavy-accent', 'slur', 'slide-in-below', 'trill', 'string-number', 'flat', 'turn']) expect(find(empty, id).enabled).toBe(false);
    for (const id of ['repeat-start', 'double-bar', '8va', 'fermata', 'triplet', 'tap', 'brush-down', 'fade-in']) expect(find(empty, id).enabled).toBe(true);
    const onNote = controls(score);
    for (const id of ['heavy-accent', 'slur', 'slide-in-below', 'trill', 'string-number', 'flat', 'turn', 'legato-slide', 'rasgueado', 'barre', 'crescendo']) expect(find(onNote, id).enabled).toBe(true);
  });

  it('turns every enabled control and list entry into one edit the engine accepts', () => {
    const tried: string[] = [];
    for (const control of controls(score)) {
      const items: PaletteItem[] = control.menu ?? (control.prompt ? [] : [control]);
      for (const item of items) {
        const result = item.enabled ? item.activate() : null;
        if (!result || !('edit' in result)) continue;
        expect(() => previewEdit(base, result.edit), `${item.id}: ${JSON.stringify(result.edit)}`).not.toThrow();
        tried.push(item.id);
      }
      if (control.prompt) {
        const result = control.prompt.submit('Intro');
        expect(result && 'edit' in result && (() => previewEdit(base, result.edit))).toBeTruthy();
        tried.push(control.id);
      }
    }
    expect(tried.length).toBeGreaterThan(90);
  });

  it('highlights a toggle once applied, and a second click restores the score', () => {
    const toggles = ['heavy-accent', 'tenuto', 'slur', 'pedal-down', 'dead-slap', 'wide-vibrato', 'whammy-vibrato', 'pick-slide-down', 'legato-slide', 'slide-in-below',
      'slide-out-up', 'left-hand-tap', 'tap', 'slap', 'pop', 'golpe-thumb', 'string-number', 'brush-up', 'arpeggio-down', 'rasgueado', 'pick-down', 'trill',
      'tremolo-picking', 'upper-mordent', 'turn', 'fade-in', 'volume-swell', 'wah-open', 'slash', 'barre', 'timer', 'triplet', 'fermata', 'grace-before',
      'sharp', '8va', '15mb', 'repeat-start', 'repeat-end', 'double-bar', 'free-time'];
    for (const id of toggles) {
      let once: Project;
      try { once = previewEdit(base, editOf(find(controls(score), id))).project; } catch (error) { throw new Error(`${id}: ${String(error)}`); }
      const after = find(controls(scoreOf(once)), id);
      expect(after.pressed, id).toBe(true);
      let twice: Project;
      try { twice = previewEdit(once, editOf(after)).project; } catch (error) { throw new Error(`${id} off: ${String(error)}`); }
      expect(find(controls(scoreOf(twice)), id).pressed, id).toBe(false);
    }
  });

  it('records nothing when the current value is chosen', () => {
    const list = controls(score);
    expect(find(list, 'stem-auto').pressed).toBe(true);
    expect(find(list, 'stem-auto').activate()).toBeNull();
    expect(find(list, 'beam-auto').activate()).toBeNull();
    expect(find(list, 'auto-spelling').activate()).toBeNull();
    expect(find(list, 'tuplet').menu!.find(item => item.id === 'tuplet-none')!.activate()).toBeNull();
    expect(find(list, 'triplet-feel').menu!.find(item => item.id === 'feel-none')!.activate()).toBeNull();
    expect(find(list, 'harmonics').menu!.find(item => item.id === 'harmonic-none')!.activate()).toBeNull();
    expect(find(list, 'beat-text').prompt!.submit('')).toBeNull();
  });

  it('adds a hairpin to the next attack one dynamic step on, and clears its whole run', () => {
    const add = editOf(find(controls(score), 'crescendo'));
    expect(add).toEqual({ type: 'setCrescendo', from: at(0), to: at(1), crescendo: model.CrescendoType.Crescendo, targetDynamics: 6 });
    const once = previewEdit(base, add).project, marked = scoreOf(once);
    expect(find(controls(marked, at(1)), 'crescendo').pressed).toBe(true);
    expect(editOf(find(controls(marked, at(1)), 'crescendo'))).toEqual({ type: 'setCrescendo', from: at(0), to: at(1), crescendo: 0, targetDynamics: null });
  });

  it('applies a tuplet, harmonic, whammy, ending and direction from their lists', () => {
    const list = controls(score);
    const pick = (id: string, item: string) => editOf(find(list, id).menu!.find(entry => entry.id === item)!);
    expect(pick('tuplet', 'tuplet-5-4')).toMatchObject({ type: 'setBeatRhythm', tupletNumerator: 5, tupletDenominator: 4 });
    expect(pick('harmonics', `harmonic-${model.HarmonicType.Pinch}`)).toEqual({ type: 'setNoteTechniques', target: at(0), string: 3, patch: { harmonic: { type: model.HarmonicType.Pinch, value: 12 } } });
    expect(pick('whammy', `whammy-${model.WhammyType.Dip}`)).toMatchObject({ type: 'setBeatTechniques', patch: { whammy: { type: model.WhammyType.Dip } } });
    expect(pick('endings', 'ending-2')).toMatchObject({ type: 'setMeasureSettings', bar: 0, endings: [2] });
    expect(pick('directions', 'direction-3')).toEqual({ type: 'setDirections', bar: 0, directions: [3] });
    expect(pick('triplet-feel', 'feel-2')).toMatchObject({ type: 'setMasterBarGestures', bar: 0, tripletFeel: 2 });
  });

  it('opens the measure, chord and scale panels from their buttons', () => {
    const list = controls(score);
    expect(find(list, 'clef').activate()).toEqual({ open: 'measure' });
    expect(find(list, 'key').activate()).toEqual({ open: 'measure' });
    expect(find(list, 'chord-diagram').activate()).toEqual({ open: 'chord' });
    expect(find(list, 'scale-diagram').activate()).toEqual({ open: 'scales' });
  });

  it('keeps stringed-only effects off on a percussion staff', () => {
    let project = previewEdit(base, { type: 'addPercussionTrack', name: 'Drums', program: 0 }).project;
    project = previewEdit(project, { type: 'addPercussionNote', target: { ...at(0), track: 1 }, articulation: 38 }).project;
    const drums = paletteGroups(scoreOf(project), { ...at(0), track: 1 }, 1, 0).flatMap(group => group.controls);
    for (const id of ['slide-in-below', 'string-number', 'tap', 'brush-down', 'pick-down', 'trill', 'turn', 'flat', 'barre']) expect(find(drums, id).enabled, id).toBe(false);
    for (const id of ['heavy-accent', 'fermata', 'fade-in', 'triplet']) expect(find(drums, id).enabled, id).toBe(true);
  });
});
