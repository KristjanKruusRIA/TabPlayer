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
  it('keeps the sounding tempo typed on a mark written in another unit', () => {
    let project = prepared();
    project = apply(project, { type: 'setMeasureSettings', bar: 1, ...readMeasureSettings(buildScore(project), 1), tempos: [{ beat: 0, bpm: 100, linear: false, unit: 3 }] });
    const score = buildScore(project), ref = { kind: 'tempo', bar: 1, index: 0 } as const;
    expect(score.masterBars[1].tempoAutomations[0].value).toBe(150);
    const edited = buildScore(apply(project, command(tempoEdit(score, ref, '160')))).masterBars[1].tempoAutomations[0];
    expect(edited.value).toBeCloseTo(160, 9);
    expect(readMeasureSettings(buildScore(apply(project, command(tempoEdit(score, ref, '160')))), 1).tempos[0].unit).toBe(3);
  });
  it('parses tempo like the command palette', () => {
    expect([' 96 ', '96.5', '1', '999'].map(parseTempo)).toEqual([96, 96.5, 1, 999]);
    expect(['', '0', '1000', 'fast', '-5', '9e2'].map(parseTempo)).toEqual([null, null, null, null, null, null]);
  });

  it('renames the title with setScoreInfo and records nothing for the current title', () => {
    const project = prepared(), score = buildScore(project);
    expect(titleEdit(score, 'Etude')).toEqual({ unchanged: true });
    expect(titleEdit(score, '  Etude  ')).toEqual({ unchanged: true });
    const edit = command(titleEdit(score, ' Nocturne '));
    expect(edit).toEqual({ type: 'setScoreInfo', title: 'Nocturne', artist: 'Ann', tempo: 100, preserveOpeningMark: true });
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

  it('renames a score whatever its opening tempo mark is, and the mark comes through untouched', () => {
    for (const damage of [(a: model.Automation) => { a.text = 'Moderato'; }, (a: model.Automation) => { a.isLinear = true; }, (a: model.Automation) => { a.isVisible = false; }]) {
      const project = prepared(), score = buildScore(project);
      damage(score.masterBars[0].tempoAutomations[0]);
      const edit = command(titleEdit(score, 'Other'));
      expect(edit).toMatchObject({ type: 'setScoreInfo', title: 'Other', preserveOpeningMark: true });
    }
    expect(titleEdit(buildScore(prepared()), 'Etude')).toEqual({ unchanged: true });
  });

  it('keeps an opening mark with a label, a gradual change or no display when the title or tempo is set with preserveOpeningMark', () => {
    let project = prepared();
    // A real labelled, gradual, hidden opening mark in the document itself, written by an earlier edit.
    project = apply(project, { type: 'setMeasureSettings', bar: 0, ...readMeasureSettings(buildScore(project), 0), tempos: [{ beat: 0, bpm: 100, linear: true }] });
    const marked = (p: Project) => buildScore(p).masterBars[0].tempoAutomations[0];
    expect(marked(project).isLinear).toBe(true);
    const renamed = previewEdit(project, { type: 'setScoreInfo', title: 'New', artist: 'Ann', tempo: 100, preserveOpeningMark: true }).project;
    const mark = marked(renamed);
    expect([mark.isLinear, mark.value, mark.isVisible, buildScore(renamed).title]).toEqual([true, 100, true, 'New']);
    const retempo = marked(previewEdit(project, { type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 80, preserveOpeningMark: true }).project);
    expect([retempo.isLinear, retempo.value]).toEqual([true, 80]);
    // Without the field, the edit behaves as it always did and rebuilds a plain mark, so old logs replay the same.
    const old = marked(previewEdit(project, { type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 80 }).project);
    expect([old.isLinear, old.value]).toEqual([false, 80]);
    expect(JSON.stringify({ type: 'setScoreInfo', title: 'T', artist: 'A', tempo: 96 })).toBe('{"type":"setScoreInfo","title":"T","artist":"A","tempo":96}');
  });

  it('accepts setScoreInfo with or without the optional field and rejects a bad one', () => {
    const project = prepared();
    expect(() => previewEdit(project, { type: 'setScoreInfo', title: 'a', artist: 'b', tempo: 90 })).not.toThrow();
    expect(() => previewEdit(project, { type: 'setScoreInfo', title: 'a', artist: 'b', tempo: 90, preserveOpeningMark: true })).not.toThrow();
    expect(() => previewEdit(project, { type: 'setScoreInfo', title: 'a', artist: 'b', tempo: 90, preserveOpeningMark: 'yes' } as never)).toThrow();
    expect(() => previewEdit(project, { type: 'setScoreInfo', title: 'a', artist: 'b', tempo: 90, preserveOpeningMark: null } as never)).toThrow();
  });

  it('a score with no opening mark keeps having none when it is renamed with preserveOpeningMark', () => {
    const project = prepared(), score = buildScore(project);
    score.masterBars[0].tempoAutomations = [];
    const doc = { ...project };
    const built = previewEdit(doc, { type: 'setScoreInfo', title: 'X', artist: 'A', tempo: 100, preserveOpeningMark: true });
    expect(built.score.title).toBe('X');
  });

  it('retempo of a labelled or gradual opening mark goes through setScoreInfo with preserveOpeningMark', () => {
    const score = buildScore(prepared());
    score.masterBars[0].tempoAutomations[0].text = 'Largo';
    expect(tempoEdit(score, { kind: 'tempo', bar: 0, index: 0 }, '60')).toEqual({ command: { type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 60, preserveOpeningMark: true } });
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
    expect(initial).toEqual({ type: 'setScoreInfo', title: 'Etude', artist: 'Ann', tempo: 90, preserveOpeningMark: true });
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

  it('refuses to rewrite a measure whose tempo it could not rebuild', () => {
    const score = buildScore(prepared());
    score.masterBars[1].tempoAutomations[0].text = 'Allegro';
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 2 } } });
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
  });

  it('rewrites a measure whose first beat is empty when the mark is at the start', () => {
    const project = prepared(), score = buildScore(project);
    for (const beat of score.tracks[0].staves[0].bars[1].voices[0].beats) beat.isEmpty = true;
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(true);
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toMatchObject({ command: { type: 'setMeasureSettings', bar: 1 } });
    // A mark that sits on a later beat of an empty measure still cannot be rebuilt.
    score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 140, 2), model.Automation.buildTempoAutomation(false, 0.5, 150, 2)];
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
  });

  it('will not rewrite a measure whose section is a marker with no text, and keeps a section with text', () => {
    const score = buildScore(prepared());
    const section = new model.Section();
    section.marker = 'A';
    section.text = '';
    score.masterBars[1].section = section;
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toEqual({ error: { key: 'symbol.tempo_inexact', params: { bar: 2 } } });
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
    section.text = 'Intro';
    expect(tempoEdit(score, { kind: 'tempo', bar: 1, index: 0 }, '120')).toMatchObject({ command: { type: 'setMeasureSettings', section: 'Intro' } });
  });

  it('will not rewrite a measure with two tempo marks on one beat', () => {
    const score = buildScore(prepared());
    score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 140, 2), model.Automation.buildTempoAutomation(false, 0.0001, 150, 2)];
    expect(canRemoveTempo(score, { kind: 'tempo', bar: 1, index: 0 })).toBe(false);
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
