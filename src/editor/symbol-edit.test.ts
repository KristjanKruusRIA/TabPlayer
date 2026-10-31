import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildScore, previewEdit } from '../engine';
import { blankProject, type Project } from '../project';
import type { EditCommand } from '../edit-types';
import type { HarmonyChord } from './harmony-types';
import { readMeasureSettings } from './measure-settings';
import {
  canRemoveTempo, chordNameEdit, clefChoices, clefEdit, parseTempo, removeChordEdit, removeTempoEdit, symbolMenu, symbolText, targetSymbols, tempoEdit, titleEdit, type SymbolBuild,
} from './symbol-edit';

const at = { track: 0, staff: 0, bar: 1, voice: 0, beat: 0 };
const chord = (name: string): HarmonyChord => ({ name, nameMode: 'manual', recipe: null, firstFret: 0, frets: [-1, 0, 2, 2, 1, 0], fingers: [-2, -2, 2, 3, 1, -2], barreFrets: [], showName: true, showDiagram: true, showFingering: false });
const apply = (project: Project, command: EditCommand) => previewEdit(project, command).project;
/** A document with a title, a second tempo mark in measure 2 and a chord on its first beat. */
function prepared() {
  let project: Project = { ...blankProject(), edits: [] };
  project = apply(project, { type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 100 });
  project = apply(project, { type: 'setMeasureSettings', bar: 1, ...readMeasureSettings(buildScore(project), 1), tempos: [{ beat: 0, bpm: 140, linear: false }] });
  project = apply(project, { type: 'setHarmonyChord', target: at, chord: chord('Am'), fillEmptyBeat: false });
  return project;
}
const command = (build: SymbolBuild) => { if (!('command' in build)) throw new Error(`Expected an edit, got ${JSON.stringify(build)}`); return build.command; };

describe('symbol edits reuse the existing edits', () => {
  it('parses tempo like the command palette', () => {
    expect([' 96 ', '96.5', '1', '999'].map(parseTempo)).toEqual([96, 96.5, 1, 999]);
    expect(['', '0', '1000', 'fast', '-5', '9e2'].map(parseTempo)).toEqual([null, null, null, null, null, null]);
  });

  it('renames the title with setScoreInfo and records nothing for the current title', () => {
    const project = prepared(), score = buildScore(project);
    expect(titleEdit(score, 'Etude')).toEqual({ unchanged: true });
    expect(titleEdit(score, '  Etude  ')).toEqual({ unchanged: true });
    const edit = command(titleEdit(score, ' Nocturne '));
    expect(edit).toEqual({ type: 'setScoreInfo', title: 'Nocturne', artist: 'Ann', tempo: 100 });
    const next = previewEdit(project, edit);
    expect(next.project.edits.length).toBe(project.edits.length + 1);
    expect(next.score.title).toBe('Nocturne');
    expect(next.score.artist).toBe('Ann');
    expect(next.score.masterBars[1].tempoAutomations.map(a => a.value)).toEqual([140]);
  });

  it('keeps the opening tempo mark, not the cached score tempo, when renaming', () => {
    const score = buildScore(prepared());
    Object.defineProperty(score, 'tempo', { value: 77 });
    expect(command(titleEdit(score, 'Other'))).toMatchObject({ type: 'setScoreInfo', tempo: 100 });
  });

  it('refuses to rename a score whose opening tempo mark setScoreInfo would rebuild', () => {
    for (const damage of [(a: model.Automation) => { a.text = 'Moderato'; }, (a: model.Automation) => { a.isLinear = true; }, (a: model.Automation) => { a.isVisible = false; }]) {
      const score = buildScore(prepared());
      damage(score.masterBars[0].tempoAutomations[0]);
      expect(titleEdit(score, 'Other')).toEqual({ error: { key: 'symbol.title_inexact' } });
      expect(titleEdit(score, 'Etude')).toEqual({ unchanged: true });
    }
    const none = buildScore(prepared());
    none.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0.5, 80, 2)];
    expect(titleEdit(none, 'Other')).toEqual({ error: { key: 'symbol.title_inexact' } });
  });

  it('treats an imported title or chord name with stray spaces as unchanged when the same text is typed back', () => {
    const score = buildScore(prepared());
    score.title = 'Etude ';
    expect(titleEdit(score, 'Etude ')).toEqual({ unchanged: true });
    score.tracks[0].staves[0].bars[1].voices[0].beats[0].chord!.name = 'Am ';
    expect(chordNameEdit(score, { kind: 'chord', target: at }, 'Am ')).toEqual({ unchanged: true });
  });

  it('will not rewrite a measure that holds a hidden tempo mark', () => {
    const score = buildScore(prepared());
    score.masterBars[1].tempoAutomations[0].isVisible = false;
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 2 } } });
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
    expect(removeTempoEdit(score, { kind: 'tempo', bar: 1, index: 0 })).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 2 } } });
  });

  it('says so when a chord has only a name and no diagram for the staff', () => {
    const score = buildScore(prepared());
    score.tracks[0].staves[0].bars[1].voices[0].beats[0].chord!.strings = [];
    expect(chordNameEdit(score, { kind: 'chord', target: at }, 'Am7')).toEqual({ error: { key: 'symbol.chord_shape' } });
  });

  it('sets the initial tempo with setScoreInfo and a later tempo with setMeasureSettings', () => {
    const project = prepared(), score = buildScore(project);
    expect(tempoEdit(score, { kind: 'tempo', bar: 0, index: 0 }, '100')).toEqual({ unchanged: true });
    const initial = command(tempoEdit(score, { kind: 'tempo', bar: 0, index: 0 }, '90'));
    expect(initial).toEqual({ type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 90 });
    expect(previewEdit(project, initial).score.masterBars[0].tempoAutomations[0].value).toBe(90);
    const later = command(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120'));
    expect(later).toMatchObject({ type: 'setMeasureSettings', bar: 1, tempos: [{ beat: 0, bpm: 120, linear: false }] });
    const built = previewEdit(project, later);
    expect(built.project.edits.length).toBe(project.edits.length + 1);
    expect(built.score.masterBars[1].tempoAutomations.map(a => a.value)).toEqual([120]);
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '140')).toEqual({ unchanged: true });
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, 'fast')).toEqual({ error: { key: 'symbol.tempo_invalid' } });
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 4 }, '120')).toEqual({ error: { key: 'symbol.stale' } });
  });

  it('refuses to rewrite a measure whose tempo it could not rebuild, and keeps a labelled initial tempo out of setScoreInfo', () => {
    const score = buildScore(prepared());
    score.masterBars[1].tempoAutomations[0].text = 'Allegro';
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 2 } } });
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
    score.masterBars[0].tempoAutomations[0].text = 'Largo';
    expect(tempoEdit(score, { kind: 'tempo', bar: 0, index: 0 }, '60')).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 1 } } });
  });

  it('removes a tempo change but never the initial tempo', () => {
    const project = prepared(), score = buildScore(project);
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 0, index: 0 })).toBe(false);
    expect(removeTempoEdit(score, { kind: 'tempo', bar: 0, index: 0 })).toEqual({ error: { key: 'symbol.tempo_initial' } });
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(true);
    const built = previewEdit(project, command(removeTempoEdit(score, { kind: 'tempo', bar: 1, index: 0 })));
    expect(built.score.masterBars[1].tempoAutomations).toHaveLength(0);
    expect(built.project.edits.length).toBe(project.edits.length + 1);
  });

  it('renames a chord with setHarmonyChord, keeps its diagram, and records nothing for the same name', () => {
    const project = prepared(), score = buildScore(project), ref = { kind: 'chord' as const, target: at };
    expect(symbolText(score, ref)).toBe('Am');
    expect(chordNameEdit(score, ref, 'Am')).toEqual({ unchanged: true });
    expect(chordNameEdit(score, ref, '  ')).toEqual({ error: { key: 'symbol.chord_empty' } });
    expect(chordNameEdit(score, ref, 'x'.repeat(65))).toEqual({ error: { key: 'symbol.chord_long', params: { max: 64 } } });
    expect(chordNameEdit(score, ref, 'A\u0007m')).toEqual({ error: { key: 'symbol.chord_chars' } });
    const edit = command(chordNameEdit(score, ref, 'Am7'));
    expect(edit).toMatchObject({ type: 'setHarmonyChord', target: at, fillEmptyBeat: false, chord: { name: 'Am7', nameMode: 'manual', recipe: null, frets: [-1, 0, 2, 2, 1, 0], showName: true, showDiagram: true } });
    const built = previewEdit(project, edit);
    expect(built.score.tracks[0].staves[0].bars[1].voices[0].beats[0].chord?.name).toBe('Am7');
    expect(built.project.edits.length).toBe(project.edits.length + 1);
  });

  it('removes a chord with setHarmonyChord', () => {
    const project = prepared(), score = buildScore(project), ref = { kind: 'chord' as const, target: at };
    const built = previewEdit(project, command(removeChordEdit(score, ref)));
    expect(built.score.tracks[0].staves[0].bars[1].voices[0].beats[0].chord).toBeNull();
    expect(removeChordEdit(built.score, ref)).toEqual({ error: { key: 'symbol.stale' } });
  });

  it('changes a measure clef with setBarNotation and records nothing for the current clef', () => {
    const project = prepared(), score = buildScore(project), ref = { kind: 'clef' as const, track: 0, staff: 0, bar: 1 };
    const current = score.tracks[0].staves[0].bars[1].clef;
    expect(clefEdit(score, ref, current)).toEqual({ unchanged: true });
    const target = clefChoices.find(choice => choice.value !== current)!.value;
    const edit = command(clefEdit(score, ref, target));
    expect(edit).toMatchObject({ type: 'setBarNotation', track: 0, staff: 0, bar: 1, clef: target });
    const built = previewEdit(project, edit);
    expect(built.score.tracks[0].staves[0].bars[1].clef).toBe(target);
    expect(built.score.tracks[0].staves[0].bars[0].clef).toBe(score.tracks[0].staves[0].bars[0].clef);
    expect(clefChoices.map(choice => choice.value)).toEqual([model.Clef.G2, model.Clef.F4, model.Clef.C3, model.Clef.C4, model.Clef.Neutral]);
  });

  it('offers the actions that fit each symbol', () => {
    const score = buildScore(prepared());
    expect(symbolMenu(score, { kind: 'title' }).map(item => item.action)).toEqual(['editTitle']);
    expect(symbolMenu(score, { kind: 'tempo', bar: 0, index: 0 }).map(item => item.action)).toEqual(['editTempo']);
    expect(symbolMenu(score, { kind: 'tempo', bar: 1, index: 0 }).map(item => item.action)).toEqual(['editTempo', 'removeTempo']);
    expect(symbolMenu(score, { kind: 'chord', target: at }).map(item => item.action)).toEqual(['editChord', 'openChordEditor', 'removeChord']);
    expect(symbolMenu(score, { kind: 'clef', track: 0, staff: 0, bar: 0 }).map(item => item.action)).toEqual(['chooseClef']);
    // The keyboard menu lists several symbols, so its labels say where each one is.
    expect(symbolMenu(score, { kind: 'tempo', bar: 1, index: 0 }, true)).toMatchObject([{ label: 'symbol.edit_tempo_at', params: { bar: 2, value: '140' } }, { label: 'symbol.remove_tempo_at', params: { bar: 2, value: '140' } }]);
    expect(symbolMenu(score, { kind: 'chord', target: at }, true)[0]).toMatchObject({ label: 'symbol.edit_chord_name_at', params: { name: 'Am' } });
    expect(symbolMenu(score, { kind: 'clef', track: 0, staff: 0, bar: 3 }, true)[0]).toMatchObject({ label: 'symbol.change_clef_at', params: { bar: 4 } });
  });

  it('lists the symbols a keyboard user reaches from the edit target', () => {
    const score = buildScore(prepared());
    expect(targetSymbols(score, at, [0]).map(ref => ref.kind)).toEqual(['title', 'tempo', 'chord', 'clef']);
    const two = buildScore(prepared());
    two.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 140, 2), model.Automation.buildTempoAutomation(false, 0.5, 150, 2)];
    expect(targetSymbols(two, at, [0]).filter(ref => ref.kind === 'tempo')).toEqual([{ kind: 'tempo', bar: 1, index: 0 }, { kind: 'tempo', bar: 1, index: 1 }]);
    // A measure with no tempo mark of its own offers the initial tempo.
    expect(targetSymbols(score, { ...at, bar: 2 }, [0])).toEqual([{ kind: 'title' }, { kind: 'tempo', bar: 0, index: 0 }, { kind: 'clef', track: 0, staff: 0, bar: 2 }]);
    expect(targetSymbols(score, at, [1]).map(ref => ref.kind)).toEqual(['title', 'tempo']);
  });
});
