import { describe, expect, it } from 'vitest';
import { blankProject } from '../project';
import { buildScore, previewEdit } from '../engine';
import type { BeatTarget, Project } from '../project';
import type { EditCommand, StaffSettings } from '../edit-types';
import { model } from '@coderline/alphatab';
import { fretKey } from './banjo-drone';

const target: BeatTarget = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
const bar1Beat0: BeatTarget = { track: 0, staff: 0, bar: 1, voice: 0, beat: 0 };

const standard = [64, 59, 55, 50, 45, 40]; // string 6=64 (high E), string 1=40 (low E)
const dropD = [64, 59, 55, 50, 45, 38];    // string 6=64, string 1=38 (low D)

function projectWithEdits(...edits: EditCommand[]): { project: Project; score: model.Score } {
  let project = blankProject();
  let score = buildScore(project);
  for (const edit of edits) {
    const res = previewEdit(project, edit);
    project = res.project;
    score = res.score;
  }
  return { project, score };
}

describe('refinger keepPitch on retune and capo', () => {
  it('drop tuning keeps sounding pitch by moving string 1 notes up 2 frets', () => {
    // Note on string 1 (low E), fret 2 -> pitch 42 (F#2)
    const base = projectWithEdits({ type: 'setNote', target, string: 1, fret: 2 });
    const noteBefore = base.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteBefore.string).toBe(1);
    expect(noteBefore.fret).toBe(2);
    expect(noteBefore.realValue).toBe(42);

    // Retune with keepPitch: true
    const retuned = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: dropD, keepPitch: true });
    const noteAfter = retuned.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteAfter.string).toBe(1);
    expect(noteAfter.fret).toBe(4);
    expect(noteAfter.realValue).toBe(42);

    // Retune without keepPitch (default) keeps fret 2 and changes pitch to 40
    const defaultRetune = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: dropD });
    const defaultNote = defaultRetune.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(defaultNote.string).toBe(1);
    expect(defaultNote.fret).toBe(2);
    expect(defaultNote.realValue).toBe(40);
  });

  it('capo up moves notes down in frets while keeping pitch', () => {
    // Note on string 6 (high E), fret 5 -> pitch 69 (A4)
    const base = projectWithEdits({ type: 'setNote', target, string: 6, fret: 5 });
    const noteBefore = base.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteBefore.string).toBe(6);
    expect(noteBefore.fret).toBe(5);
    expect(noteBefore.realValue).toBe(69);

    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning],
      capo: 2,
      transposition: staff.transpositionPitch,
      displayTransposition: staff.displayTranspositionPitch,
      clef: staff.bars[0].clef,
      showTab: true,
      showNotation: true,
      keepPitch: true,
    };

    const moved = previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings });
    const noteAfter = moved.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteAfter.string).toBe(6);
    expect(noteAfter.fret).toBe(3); // 5 - 2 = 3
    expect(noteAfter.realValue).toBe(69);
  });

  it('capo down moves notes up in frets while keeping pitch', () => {
    // Base with capo 2, note on string 5 fret 1 -> open 59 + capo 2 = 61; + 1 = 62 (D4)
    const initialSettings: StaffSettings = {
      tuning: [...standard],
      capo: 2,
      transposition: 0,
      displayTransposition: 0,
      clef: 4,
      showTab: true,
      showNotation: true,
    };
    const base = projectWithEdits(
      { type: 'setStaffSettings', track: 0, staff: 0, settings: initialSettings },
      { type: 'setNote', target, string: 5, fret: 1 }
    );
    const noteBefore = base.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteBefore.fret).toBe(1);
    expect(noteBefore.realValue).toBe(62);

    // Remove capo with keepPitch: true
    const settingsWithoutCapo: StaffSettings = {
      ...initialSettings,
      capo: 0,
      keepPitch: true,
    };
    const moved = previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings: settingsWithoutCapo });
    const noteAfter = moved.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(noteAfter.string).toBe(5);
    expect(noteAfter.fret).toBe(3); // 1 + 2 = 3
    expect(noteAfter.realValue).toBe(62);
  });

  it('lists unreachable notes for the user and drops nothing silently', () => {
    // Open low E string (string 1 fret 0 -> pitch 40)
    const base = projectWithEdits({ type: 'setNote', target, string: 1, fret: 0 });
    const staff = base.score.tracks[0].staves[0];

    // Capo 2 raises lowest playable pitch to 42; pitch 40 cannot be reached on standard guitar
    const settings: StaffSettings = {
      tuning: [...staff.tuning],
      capo: 2,
      transposition: 0,
      displayTransposition: 0,
      clef: 4,
      showTab: true,
      showNotation: true,
      keepPitch: true,
    };

    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings })).toThrow(
      /Keep pitch could not move every note: staff 1, voice 1, bar 1, beat 1, string 1 \(E2\): no string in the new setup reaches this pitch\./
    );
  });

  it('chords never place two notes on the same string', () => {
    // Chord with 3 notes: string 6 fret 0 (64), string 5 fret 1 (60), string 4 fret 0 (55)
    const base = projectWithEdits(
      { type: 'setNote', target, string: 6, fret: 0 },
      { type: 'setNote', target, string: 5, fret: 1 },
      { type: 'setNote', target, string: 4, fret: 0 }
    );
    const notesBefore = base.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
    expect(notesBefore).toHaveLength(3);
    const pitchesBefore = notesBefore.map(n => n.realValue).sort((a, b) => a - b);

    // Retune all strings down 2 semitones: frets increase by 2
    const wholeStepDown = [62, 57, 53, 48, 43, 38];
    const retuned = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: wholeStepDown, keepPitch: true });
    const notesAfter = retuned.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
    expect(notesAfter).toHaveLength(3);

    const stringsUsed = notesAfter.map(n => n.string);
    const uniqueStrings = new Set(stringsUsed);
    expect(uniqueStrings.size).toBe(3); // Every note is on a different string!

    const pitchesAfter = notesAfter.map(n => n.realValue).sort((a, b) => a - b);
    expect(pitchesAfter).toEqual(pitchesBefore);
  });

  it('ties are preserved on their string across refingering', () => {
    // Create measure 1 and measure 2 with a tied note on string 1 fret 2
    let base = projectWithEdits(
      { type: 'appendMeasure' },
      { type: 'setNote', target, string: 1, fret: 2 },
      { type: 'setNote', target: bar1Beat0, string: 1, fret: 2 }
    );
    // Link notes with tie
    base = {
      project: previewEdit(base.project, {
        type: 'setNoteLink',
        from: { target, string: 1 },
        to: { target: bar1Beat0, string: 1 },
        kind: 'tie',
      }).project,
      score: previewEdit(base.project, {
        type: 'setNoteLink',
        from: { target, string: 1 },
        to: { target: bar1Beat0, string: 1 },
        kind: 'tie',
      }).score,
    };

    // Retune to Drop D with keepPitch: true
    const retuned = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: dropD, keepPitch: true });
    const staff = retuned.score.tracks[0].staves[0];
    const note1 = staff.bars[0].voices[0].beats[0].notes[0];
    const note2 = staff.bars[1].voices[0].beats[0].notes[0];

    expect(note1.string).toBe(1);
    expect(note1.fret).toBe(4);
    expect(note1.realValue).toBe(42);

    expect(note2.string).toBe(1);
    expect(note2.fret).toBe(4);
    expect(note2.realValue).toBe(42);

    // The tie link is intact: note1 destination is note2, note2 origin is note1
    expect(note1.tieDestination).toBe(note2);
    expect(note2.tieOrigin).toBe(note1);
  });

  it('undo and redo replay cleanly and restore original/refingered states', () => {
    const base = projectWithEdits({ type: 'setNote', target, string: 1, fret: 2 });
    const editCommand: EditCommand = { type: 'setTuning', track: 0, tuning: dropD, keepPitch: true };

    const edited = previewEdit(base.project, editCommand).project;
    const editedScore = buildScore(edited);
    expect(editedScore.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(4);
    expect(editedScore.tracks[0].staves[0].tuning).toEqual(dropD);

    // Undo by popping the edit restores fret 2 and standard tuning
    const undone: Project = { ...edited, edits: edited.edits.slice(0, -1) };
    const undoneScore = buildScore(undone);
    expect(undoneScore.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(2);
    expect(undoneScore.tracks[0].staves[0].tuning).toEqual(standard);

    // Redo by adding the edit back restores fret 4 and drop D tuning
    const redone: Project = { ...undone, edits: [...undone.edits, editCommand] };
    const redoneScore = buildScore(redone);
    expect(redoneScore.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(4);
    expect(redoneScore.tracks[0].staves[0].tuning).toEqual(dropD);
  });

  it('keeps a trill sounding the same when a partial capo and keep pitch are applied', () => {
    // String 3 (D3) fret 7 is 57; the trill goes two semitones up to 59.
    const base = projectWithEdits(
      { type: 'setNote', target, string: 3, fret: 7 },
      { type: 'setNoteTechniques', target, string: 3, patch: { trill: { pitch: 59, speed: 16 } } }
    );
    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning], capo: 0, transposition: 0, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: true, showNotation: true, partialCapo: { fret: 5, strings: [1, 2, 3] }, keepPitch: true,
    };
    const moved = previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings });
    const note = moved.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(note.fret).toBe(2);
    expect(fretKey(moved.score.tracks[0].staves[0], 3, note.fret)).toBe(57);
    expect(note.trillValue).toBe(59);
  });

  it('never puts notes of two voices that sound together on one string', () => {
    // Voice 1 A2 (string 2) must leave string 2 once it is tuned up; voice 2 holds 47 on string 1.
    const voice1: BeatTarget = { ...target, voice: 1 };
    const base = projectWithEdits(
      { type: 'addVoice', track: 0, staff: 0 },
      { type: 'setNote', target, string: 2, fret: 0 },
      { type: 'setNote', target: voice1, string: 1, fret: 7 }
    );
    const retuned = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: [64, 59, 55, 50, 47, 40], keepPitch: true });
    const bar = retuned.score.tracks[0].staves[0].bars[0];
    const first = bar.voices[0].beats[0].notes[0], second = bar.voices[1].beats[0].notes[0];
    expect(first.string).not.toBe(second.string);
    expect([first, second].map(n => [64, 59, 55, 50, 47, 40][6 - n.string] + n.fret).sort()).toEqual([45, 47]);
  });

  it('still checks the pitch range of a staff with no strings when keep pitch is set', () => {
    const base = projectWithEdits(
      { type: 'addPitchedTrack', name: 'Piano', program: 0 },
      { type: 'addPitchedNote', target: { ...target, track: 1 }, pitch: 72 }
    );
    const staff = base.score.tracks[1].staves[0];
    const settings: StaffSettings = {
      tuning: [], capo: 0, transposition: -100, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: false, showNotation: true, keepPitch: true,
    };
    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 1, staff: 0, settings })).toThrow(/outside the playable MIDI pitch range/);
  });

  it('leaves frets alone when only the transposition changes, and still range-checks the result', () => {
    const base = projectWithEdits({ type: 'setNote', target, string: 6, fret: 5 });
    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning], capo: 0, transposition: 12, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: true, showNotation: true, keepPitch: true,
    };
    const moved = previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings });
    const note = moved.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect([note.string, note.fret]).toEqual([6, 5]);
    expect(moved.score.tracks[0].staves[0].transpositionPitch).toBe(12);
    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings: { ...settings, transposition: -100 } })).toThrow(/outside the playable MIDI pitch range/);
  });

  it('names the staff, voice, bar, real beat, string and pitch of a note that cannot move', () => {
    // The second of the bar's four beats becomes a grace note: it does not count, so the third is beat 2.
    const at = (beat: number): BeatTarget => ({ ...target, beat });
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 5, fret: 0 },
      { type: 'setBeatRhythm', target: at(1), duration: 16, dots: 0, tupletNumerator: 1, tupletDenominator: 1, graceType: model.GraceType.BeforeBeat },
      { type: 'setNote', target: at(1), string: 1, fret: 0 },
      { type: 'setNote', target: at(2), string: 1, fret: 0 }
    );
    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning], capo: 2, transposition: 0, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: true, showNotation: true, keepPitch: true,
    };
    let message = '';
    try { previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings }); } catch (error) { message = String(error); }
    expect(message).toContain('staff 1, voice 1, bar 1, grace note before beat 2, string 1 (E2): no string in the new setup reaches this pitch');
    expect(message).toContain('staff 1, voice 1, bar 1, beat 2, string 1 (E2)');
  });

  it('says a harmonic cannot move instead of calling it unreachable', () => {
    const base = projectWithEdits(
      { type: 'setNote', target, string: 6, fret: 12 },
      { type: 'setNoteTechniques', target, string: 6, patch: { harmonic: { type: 1, value: 12 } } }
    );
    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning], capo: 2, transposition: 0, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: true, showNotation: true, keepPitch: true,
    };
    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings })).toThrow(/string 6 \(E5\): a harmonic cannot move to another string or fret/);
  });

  it('moves chord diagram frets with the notes so the diagram sounds as before', () => {
    // An E-shape diagram: low E string (string 1) fret 0, then 2 2 1 0 0 from the low strings up. Frets are listed high string first.
    const base = projectWithEdits({ type: 'setBeatAnnotation', target, text: '', chord: { name: 'E', firstFret: 1, frets: [0, 0, 1, 2, 2, 0] } });
    const retuned = previewEdit(base.project, { type: 'setTuning', track: 0, tuning: dropD, keepPitch: true });
    const staff = retuned.score.tracks[0].staves[0];
    const chord = [...staff.chords!.values()][0];
    // String 1 was E2 (fret 0); in drop D it is fret 2 on the D string. Other strings are unchanged.
    expect([...chord.strings]).toEqual([0, 0, 1, 2, 2, 2]);
    expect(chord.firstFret).toBe(1);
  });

  it('refuses when a chord diagram string cannot sound its pitch', () => {
    const base = projectWithEdits({ type: 'setBeatAnnotation', target, text: '', chord: { name: 'E', firstFret: 1, frets: [0, 0, 1, 2, 2, 0] } });
    const staff = base.score.tracks[0].staves[0];
    const settings: StaffSettings = {
      tuning: [...staff.tuning], capo: 2, transposition: 0, displayTransposition: 0, clef: staff.bars[0].clef,
      showTab: true, showNotation: true, keepPitch: true,
    };
    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings })).toThrow(/chord diagram E, string 1 \(E2\): no fret reaches this pitch/);
  });
});
