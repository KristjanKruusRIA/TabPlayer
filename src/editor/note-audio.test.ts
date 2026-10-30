import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildDocument, buildScore, exportGp, previewEdit } from '../engine';
import { blankProject, type EditCommand, type Project } from '../project';
import { validateParityCommand } from '../parity-commands';
import { applyNoteTechniques } from './techniques';
import { getNoteAudio, hasNoteAudio, hasPitchEvents, plainNoteAudio, setNoteAudio, validateNoteAudio, type NoteAudio } from './note-audio';
import { makeMusicClip } from './clipboard-source';
import { loadInterchangeScore } from '../interchange/gp';
import { buildPlaybackPlan } from '../audio/plan';
import { music, noteAt, target } from './fixtures';
import protocol from '../../tests/protocol.json';

const withNotes = (): Project => {
  let project = blankProject();
  for (const beat of [0, 1, 2, 3]) project = previewEdit(project, { type: 'setNote', target: { ...target, beat }, string: 1, fret: 3 + beat }).project;
  return project;
};
const audioOf = (score: model.Score, beat = 0) => getNoteAudio(score.tracks[0].staves[0].bars[0].voices[0].beats[beat].notes[0]);
const reload = (project: Project) => buildDocument(JSON.parse(JSON.stringify(project))).score;
const setAudio = (project: Project, audio: NoteAudio | null, beat = 1) => previewEdit(project, { type: 'setNoteTechniques', target: { ...target, beat }, string: 1, patch: { audio } });

describe('validation', () => {
  it('takes exactly the three fields as whole numbers within their limits', () => {
    for (const ok of [{ length: 100, offset: 0, velocity: 0 }, { length: 10, offset: -480, velocity: -64 }, { length: 400, offset: 480, velocity: 64 }]) expect(() => validateNoteAudio(ok)).not.toThrow();
    for (const bad of [null, 'x', [], {}, { length: 9, offset: 0, velocity: 0 }, { length: 401, offset: 0, velocity: 0 }, { length: 100, offset: 481, velocity: 0 }, { length: 100, offset: -481, velocity: 0 },
      { length: 100, offset: 0, velocity: 65 }, { length: 100, offset: 0, velocity: -65 }, { length: 100.5, offset: 0, velocity: 0 }, { length: 100, offset: 0 }, { length: 100, offset: 0, velocity: 0, extra: 1 },
      { length: NaN, offset: 0, velocity: 0 }, { length: '100', offset: 0, velocity: 0 }]) expect(() => validateNoteAudio(bad)).toThrow();
  });
  it('is checked by the command reader and by the editor, with the same refusals', () => {
    const bad = { length: 9, offset: 0, velocity: 0 };
    const indexed = (audio: unknown) => ({ type: 'setNoteTechniquesByIndex', target, noteIndex: 0, patch: { audio } });
    expect(() => validateParityCommand(indexed(null))).not.toThrow();
    expect(() => validateParityCommand(indexed({ length: 50, offset: 1, velocity: 1 }))).not.toThrow();
    expect(() => validateParityCommand(indexed(bad))).toThrow();
    expect(() => applyNoteTechniques(music(), { target, string: 6 }, { audio: bad })).toThrow();
    expect(() => applyNoteTechniques(music(), { target, string: 6 }, { audio: { length: 50, offset: 1, velocity: 1, extra: 1 } as never })).toThrow();
  });
  it('is part of the shared wire examples', () => {
    const example = (protocol as { type: string; patch?: object }[]).find(command => command.type === 'setNoteTechniques' && command.patch && 'audio' in command.patch)!;
    expect(example.patch).toMatchObject({ audio: { length: 150, offset: -60, velocity: 12 } });
    expect(() => validateNoteAudio((example.patch as { audio: unknown }).audio)).not.toThrow();
  });
});

describe('the edit', () => {
  it('sets, replaces and clears one note without touching its written position or its neighbours', () => {
    const base = withNotes(), written = (score: model.Score) => JSON.stringify(score.tracks[0].staves[0].bars[0].voices[0].beats.map(b => [b.duration, b.dots, b.notes.map(n => [n.string, n.fret])]));
    const one = setAudio(base, { length: 150, offset: -40, velocity: 12 });
    expect(audioOf(one.score, 1)).toEqual({ length: 150, offset: -40, velocity: 12 });
    expect([0, 2, 3].map(beat => audioOf(one.score, beat))).toEqual([null, null, null]);
    expect(written(one.score)).toBe(written(buildScore(base)));
    const two = setAudio(one.project, { length: 100, offset: 5, velocity: 0 });
    expect(audioOf(two.score, 1)).toEqual({ length: 100, offset: 5, velocity: 0 });
    for (const clear of [null, plainNoteAudio]) expect(audioOf(setAudio(two.project, clear).score, 1)).toBeNull();
  });
  it('keeps its other technique fields in the same patch', () => {
    const edited = previewEdit(withNotes(), { type: 'setNoteTechniques', target, string: 1, patch: { staccato: true, audio: { length: 50, offset: 0, velocity: 0 } } });
    const n = edited.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(n.isStaccato).toBe(true); expect(getNoteAudio(n)).toEqual({ length: 50, offset: 0, velocity: 0 });
  });
  it('adds no edit position of its own and is undone, redone, saved and reopened by replay', () => {
    const base = withNotes(), edited = setAudio(base, { length: 60, offset: 7, velocity: -3 }, 2);
    expect(edited.project.edits).toHaveLength(base.edits.length + 1);
    expect(audioOf(reload(edited.project), 2)).toEqual({ length: 60, offset: 7, velocity: -3 });
    expect(audioOf(reload({ ...edited.project, edits: edited.project.edits.slice(0, -1) }), 2)).toBeNull();
    const plan = (project: Project) => JSON.stringify(buildPlaybackPlan(buildScore(project), 0));
    expect(plan({ ...edited.project, edits: edited.project.edits.slice(0, -1) })).toBe(plan(base));
    expect(plan(edited.project)).not.toBe(plan(base));
    expect(plan(JSON.parse(JSON.stringify(edited.project)))).toBe(plan(edited.project));
  });
  it('replays a log written before the feature to the same plan, and its JSON has no new field', () => {
    const project = withNotes(), score = buildScore(project);
    expect(hasNoteAudio(score)).toBe(false);
    expect(model.JsonConverter.scoreToJson(score)).not.toContain('tabplayernoteaudio');
    expect(JSON.stringify(project)).not.toContain('audio');
    expect(JSON.stringify(buildPlaybackPlan(buildScore(JSON.parse(JSON.stringify(project))), 0))).toBe(JSON.stringify(buildPlaybackPlan(score, 0)));
  });
  it('refuses a tie destination, and a changed start or length on a bent, sliding or vibrato note, which can still be re-leveled', () => {
    let project = previewEdit(withNotes(), { type: 'setNote', target: { ...target, beat: 1 }, string: 1, fret: 3 }).project;
    project = previewEdit(project, { type: 'setNoteLink', kind: 'tie', from: { target, string: 1 }, to: { target: { ...target, beat: 1 }, string: 1 } }).project;
    expect(() => setAudio(project, { length: 50, offset: 0, velocity: 0 })).toThrow(/tie/);
    const bent = previewEdit(project, { type: 'setNoteTechniques', target: { ...target, beat: 2 }, string: 1, patch: { bend: { type: 2, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] } } }).project;
    expect(() => setAudio(bent, { length: 50, offset: 0, velocity: 0 }, 2)).toThrow(/keeps its start and length/);
    expect(() => setAudio(bent, { length: 100, offset: 9, velocity: 0 }, 2)).toThrow(/keeps its start and length/);
    expect(audioOf(setAudio(bent, { length: 100, offset: 0, velocity: 9 }, 2).score, 2)).toEqual({ length: 100, offset: 0, velocity: 9 });
    for (const patch of [{ vibrato: 1 }, { slideOut: 3 }]) {
      const marked = previewEdit(withNotes(), { type: 'setNoteTechniques', target, string: 1, patch } as EditCommand).project;
      expect(() => setAudio(marked, { length: 50, offset: 0, velocity: 0 }, 0)).toThrow(/keeps its start and length/);
    }
  });
  it('is also set by chord-note index on a staff without strings', () => {
    const track = previewEdit(blankProject(), { type: 'addPitchedTrack', name: 'Keys', program: 0 });
    const place = { track: 1, staff: 0, bar: 0, voice: 0, beat: 0 };
    const note = previewEdit(track.project, { type: 'addPitchedNote', target: place, pitch: 60 });
    const result = previewEdit(note.project, { type: 'setNoteTechniquesByIndex', target: place, noteIndex: 0, patch: { audio: { length: 80, offset: 3, velocity: 2 } } });
    expect(getNoteAudio(result.score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0])).toEqual({ length: 80, offset: 3, velocity: 2 });
  });
});

describe('what carries the settings along', () => {
  const edited = () => setAudio(withNotes(), { length: 150, offset: -40, velocity: 12 });
  const value = { length: 150, offset: -40, velocity: 12 };
  it('a duplicated track keeps them on its own notes', () => {
    const copy = previewEdit(edited().project, { type: 'duplicateTrack', track: 0 }).score;
    expect(getNoteAudio(copy.tracks[1].staves[0].bars[0].voices[0].beats[1].notes[0])).toEqual(value);
    expect(getNoteAudio(copy.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0])).toEqual(value);
  });
  it('a copied voice keeps them', () => {
    const voiced = previewEdit(edited().project, { type: 'addVoice', track: 0, staff: 0 }).project;
    const copy = previewEdit(voiced, { type: 'copyVoice', track: 0, staff: 0, sourceVoice: 0, destinationVoice: 1, startBar: 0, endBar: 0 }).score;
    expect(getNoteAudio(copy.tracks[0].staves[0].bars[0].voices[1].beats[1].notes[0])).toEqual(value);
  });
  it('a pasted bar keeps them', () => {
    const source = edited(), clip = makeMusicClip(source.score, { kind: 'bars', tracks: [0], firstBar: 0, lastBar: 0 }, 'singleTrack');
    const options = { target: { track: 0, staff: 0, bar: 1, voice: 0, beat: 0 }, destinations: [{ sourceTrack: 0, track: 0, staffMap: [0] }], count: 1, placement: 'beforeBar' as const, filters: { diagrams: true, texts: true, timers: true, trackAutomations: true, masterAutomations: false, sections: false } };
    const pasted = previewEdit(source.project, { type: 'pasteMusic', clip, options }).score;
    expect(getNoteAudio(pasted.tracks[0].staves[0].bars[1].voices[0].beats[1].notes[0])).toEqual(value);
    expect(getNoteAudio(pasted.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0])).toEqual(value);
  });
  it('a Guitar Pro export plays as the unedited score: the format has no field for them', () => {
    const plain = withNotes(), reopened = loadInterchangeScore(exportGp(edited().score), new Settings());
    const sound = (score: model.Score) => buildPlaybackPlan(score, 0).notes.map(n => [n.startTick, n.endTick, n.velocity, n.key]);
    expect(hasNoteAudio(reopened)).toBe(false);
    expect(sound(reopened)).toEqual(sound(buildScore(plain)));
  });
  it('an ordinary clone, and a malformed wire value that is skipped rather than refused', () => {
    const score = music(); setNoteAudio(noteAt(score), { length: 33, offset: 4, velocity: -5 });
    const copy = model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score), new Settings());
    expect(getNoteAudio(noteAt(copy))).toEqual({ length: 33, offset: 4, velocity: -5 });
    const wire = JSON.parse(model.JsonConverter.scoreToJson(score));
    wire.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].tabplayernoteaudio = { length: 9999, offset: 0, velocity: 0 };
    expect(getNoteAudio(noteAt(model.JsonConverter.jsonToScore(JSON.stringify(wire), new Settings())))).toBeNull();
  });
});

describe('pitch events on the beat', () => {
  it('treats a beat vibrato, which alphaTab turns into bend events, like a note vibrato', () => {
    const score = music(), n = noteAt(score);
    expect(hasPitchEvents(n)).toBe(false);
    n.beat.vibrato = model.VibratoType.Slight;
    expect(hasPitchEvents(n)).toBe(true);
  });
});
