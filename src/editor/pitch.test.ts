import { expect, it } from 'vitest';
import { exporter, importer, model, Settings } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { applyPitchEdit } from './pitch';
import { isNoteCautionary } from './cautionary';
import { music, noteAt, reopened, target } from './fixtures';

it.each([0,1,2,3,4,5,6])('spelling mode %i survives native roundtrip while sounding pitch stays unchanged',accidentalMode=>{
  const score=music(),note=noteAt(score);note.fret=2;score.finish(new Settings());const pitch=note.realValue;
  expect(applyPitchEdit(score,{type:'setNoteSpelling',target,noteIndex:0,accidentalMode})).toBe(true);
  for(const copy of [score,reopened(score)]) {
    const result=noteAt(copy);expect(result.accidentalMode).toBe(accidentalMode);expect(result.realValue).toBe(pitch);expect(result.string).toBe(6);expect(result.fret).toBe(2);
  }
});

it.each([[0,3],[1,2],[2,2],[3,3],[4,4],[5,5],[6,6]])('public GP roundtrip maps spelling %i to %i without changing sounding pitch', (accidentalMode,expected)=>{
  const score=music();noteAt(score).fret=2;score.finish(new Settings());
  applyPitchEdit(score,{type:'setNoteSpelling',target,noteIndex:0,accidentalMode});
  const copy=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,new Settings()),new Settings());
  expect(noteAt(copy).accidentalMode).toBe(expected);expect(noteAt(copy).realValue).toBe(66);expect(noteAt(copy).fret).toBe(2);
});

it('selects a non-tab chord note by index without changing another note or its sounding pitch',()=>{
  const score=music(),staff=score.tracks[0].staves[0],beat=noteAt(score).beat;staff.stringTuning.tunings=[];
  const first=beat.notes[0];first.string=-1;first.fret=-1;first.octave=5;first.tone=0;
  const second=new model.Note();second.string=-1;second.fret=-1;second.octave=5;second.tone=6;beat.addNote(second);score.finish(new Settings());
  applyPitchEdit(score,{type:'setNoteSpelling',target,noteIndex:1,accidentalMode:5});
  expect(first.accidentalMode).toBe(0);expect(second.accidentalMode).toBe(5);expect(first.realValue).toBe(60);expect(second.realValue).toBe(66);
});

it.each([{noteIndex:-1,accidentalMode:5},{noteIndex:1,accidentalMode:5},{noteIndex:0.5,accidentalMode:5},{noteIndex:0,accidentalMode:-1},{noteIndex:0,accidentalMode:7},{noteIndex:0,accidentalMode:1.5}])('invalid spelling targets and modes reject without mutation: %j',invalid=>{
  const score=music();expect(()=>applyPitchEdit(score,{type:'setNoteSpelling',target,...invalid})).toThrow(/note|accidental/i);expect(noteAt(score).accidentalMode).toBe(0);expect(noteAt(score).realValue).toBe(67);
});

it('invalid beat targets reject before spelling changes',()=>{
  const score=music();expect(()=>applyPitchEdit(score,{type:'setNoteSpelling',target:{...target,beat:99},noteIndex:0,accidentalMode:5} as EditCommand)).toThrow(/beat/i);expect(noteAt(score).accidentalMode).toBe(0);
});

it('leaves commands owned by another router untouched',()=>{expect(applyPitchEdit(music(),{type:'appendMeasure'})).toBe(false);});

it('marks a note with a courtesy accidental that survives native roundtrip while pitch is preserved', () => {
  const score = music(), note = noteAt(score);
  note.fret = 0; // E (pitch 64 in C major: alteration 0, natural)
  score.finish(new Settings());
  const pitch = note.realValue;
  expect(applyPitchEdit(score, { type: 'setNoteCautionary', target, noteIndex: 0, cautionary: true })).toBe(true);
  expect(isNoteCautionary(note)).toBe(true);
  expect(note.accidentalMode).toBe(model.NoteAccidentalMode.ForceNatural);
  expect(note.realValue).toBe(pitch);

  for (const copy of [score, reopened(score)]) {
    const result = noteAt(copy);
    expect(isNoteCautionary(result)).toBe(true);
    expect(result.accidentalMode).toBe(model.NoteAccidentalMode.ForceNatural);
    expect(result.realValue).toBe(pitch);
  }

  // Toggling cautionary off clears the courtesy mark and reverts accidentalMode
  expect(applyPitchEdit(score, { type: 'setNoteCautionary', target, noteIndex: 0, cautionary: false })).toBe(true);
  expect(isNoteCautionary(note)).toBe(false);
  expect(note.accidentalMode).toBe(model.NoteAccidentalMode.Default);
  expect(note.realValue).toBe(pitch);
});

it('supports setNoteCourtesy as an alias for setNoteCautionary', () => {
  const score = music(), note = noteAt(score);
  note.fret = 2; // F# (pitch 66 in C major: alteration 1, sharp)
  score.finish(new Settings());
  expect(applyPitchEdit(score, { type: 'setNoteCourtesy', target, noteIndex: 0, courtesy: true })).toBe(true);
  expect(isNoteCautionary(note)).toBe(true);
  expect(note.accidentalMode).toBe(model.NoteAccidentalMode.ForceSharp);
  expect(note.realValue).toBe(66);
});

it.each([
  { noteIndex: -1, cautionary: true },
  { noteIndex: 1, cautionary: true },
  { noteIndex: 0.5, cautionary: true },
  { noteIndex: 0, cautionary: 'yes' },
  { noteIndex: 0, cautionary: null },
])('invalid cautionary targets and flags reject without mutation: %j', invalid => {
  const score = music();
  expect(() => applyPitchEdit(score, { type: 'setNoteCautionary', target, ...invalid } as any)).toThrow(/note|cautionary|boolean/i);
  expect(isNoteCautionary(noteAt(score))).toBe(false);
});
