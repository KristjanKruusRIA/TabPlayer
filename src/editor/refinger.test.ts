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

const at = (bar: number, beat = 0, voice = 0): BeatTarget => ({ track: 0, staff: 0, bar, voice, beat });
const settingsOf = (staff: model.Staff, over: Partial<StaffSettings>): StaffSettings => ({
  tuning: [...staff.tuning], capo: staff.capo, transposition: staff.transpositionPitch, displayTransposition: staff.displayTranspositionPitch,
  clef: staff.bars[0].clef, showTab: true, showNotation: true, ...over,
});
/** What a note sounds like, whatever its capo, drone or transposition. */
const sounds = (note: model.Note) => note.string > 0 ? fretKey(note.beat.voice.bar.staff, note.string, note.fret) : NaN;
const notesOf = (score: model.Score, trackIndex = 0) =>
  score.tracks[trackIndex].staves[0].bars.flatMap(b => b.voices.flatMap(v => v.beats.flatMap(beat => beat.notes)));

describe('refinger keeps links, techniques and other cases intact', () => {
  const dropDKeep: EditCommand = { type: 'setTuning', track: 0, tuning: dropD, keepPitch: true };

  it('keeps a slide attached to the next note on its string', () => {
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 1, fret: 2 },
      { type: 'setNote', target: at(0, 1), string: 1, fret: 5 },
      { type: 'setNoteTechniques', target: at(0), string: 1, patch: { slideOut: model.SlideOutType.Shift } }
    );
    expect(notesOf(base.score)[0].slideTarget).toBe(notesOf(base.score)[1]);
    const moved = previewEdit(base.project, dropDKeep).score;
    const [from, to] = notesOf(moved);
    expect([from.fret, to.fret]).toEqual([4, 7]);
    expect(from.slideTarget).toBe(to);
    expect(to.slideOrigin).toBe(from);
    expect(from.slideOutType).toBe(model.SlideOutType.Shift);
  });

  it('keeps a hammer-on attached', () => {
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 1, fret: 2 },
      { type: 'setNote', target: at(0, 1), string: 1, fret: 4 },
      { type: 'setNoteLink', from: { target: at(0), string: 1 }, to: { target: at(0, 1), string: 1 }, kind: 'hammerPull' }
    );
    const moved = previewEdit(base.project, dropDKeep).score;
    const [from, to] = notesOf(moved);
    expect([from.fret, to.fret]).toEqual([4, 6]);
    expect(from.hammerPullDestination).toBe(to);
    expect(to.hammerPullOrigin).toBe(from);
  });

  it('leaves a bend as it was written while the note moves', () => {
    const curve = { type: model.BendType.Bend, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] };
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 1, fret: 2 },
      { type: 'setNoteTechniques', target: at(0), string: 1, patch: { bend: curve } }
    );
    const moved = previewEdit(base.project, dropDKeep).score;
    const note = notesOf(moved)[0];
    expect(note.fret).toBe(4);
    expect(note.bendType).toBe(model.BendType.Bend);
    expect(note.bendPoints!.map(p => [p.offset, p.value])).toEqual([[0, 0], [60, 4]]);
  });

  it('moves a grace note with its beat and keeps it a grace note', () => {
    const base = projectWithEdits(
      { type: 'setBeatRhythm', target: at(0, 1), duration: 16, dots: 0, tupletNumerator: 1, tupletDenominator: 1, graceType: model.GraceType.BeforeBeat },
      { type: 'setNote', target: at(0, 1), string: 1, fret: 2 },
      { type: 'setNote', target: at(0, 2), string: 1, fret: 2 }
    );
    const moved = previewEdit(base.project, dropDKeep).score;
    const beats = moved.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats[1].graceType).toBe(model.GraceType.BeforeBeat);
    expect([beats[1].notes[0].fret, beats[2].notes[0].fret]).toEqual([4, 4]);
  });

  it('refuses a harmonic that would have to move, and names it', () => {
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 6, fret: 12 },
      { type: 'setNoteTechniques', target: at(0), string: 6, patch: { harmonic: { type: 1, value: 12 } } },
      { type: 'setNote', target: at(0, 1), string: 1, fret: 12 },
      { type: 'setNoteTechniques', target: at(0, 1), string: 1, patch: { harmonic: { type: 1, value: 12 } } }
    );
    // Only string 1 changes: its harmonic would need fret 14.
    expect(() => previewEdit(base.project, dropDKeep)).toThrow(/beat 2, string 1 \(E3\): a harmonic cannot move/);
    // Only string 6 is retuned up a tone: that harmonic would need a lower fret.
    expect(() => previewEdit(base.project, { type: 'setTuning', track: 0, tuning: [66, 59, 55, 50, 45, 40], keepPitch: true })).toThrow(/string 6 \(E5\): a harmonic cannot move/);
  });

  it('keeps a harmonic in place when no string it needs is retuned', () => {
    const base = projectWithEdits(
      { type: 'setNote', target: at(0), string: 6, fret: 12 },
      { type: 'setNoteTechniques', target: at(0), string: 6, patch: { harmonic: { type: 1, value: 12 } } }
    );
    const note = notesOf(previewEdit(base.project, dropDKeep).score)[0];
    expect([note.string, note.fret, note.harmonicType]).toEqual([6, 12, 1]);
  });

  it('keeps pitch when a partial capo is removed', () => {
    const withCapo = projectWithEdits(
      { type: 'setStaffSettings', track: 0, staff: 0, settings: settingsOf(buildScore(blankProject()).tracks[0].staves[0], { partialCapo: { fret: 5, strings: [1, 2, 3] } }) },
      { type: 'setNote', target: at(0), string: 2, fret: 3 },
      { type: 'setNote', target: at(0, 1), string: 5, fret: 3 }
    );
    const before = notesOf(withCapo.score).map(sounds);
    const staff = withCapo.score.tracks[0].staves[0];
    const moved = previewEdit(withCapo.project, {
      type: 'setStaffSettings', track: 0, staff: 0, settings: settingsOf(staff, { partialCapo: { fret: 0, strings: [] }, keepPitch: true }),
    }).score;
    expect(notesOf(moved).map(sounds)).toEqual(before);
    expect(notesOf(moved).map(n => [n.string, n.fret])).toEqual([[2, 8], [5, 3]]);
  });

  it('keeps pitch on a banjo drone string and never lands on a fret the drone lacks', () => {
    const created = previewEdit(blankProject(), { type: 'addTrack', name: 'Banjo', tuning: [62, 59, 55, 50, 67], program: 105, tuningName: '' });
    const banjoAt = (beat: number): BeatTarget => ({ ...at(0, beat), track: 1 });
    let state = previewEdit(created.project, { type: 'setStaffSettings', track: 1, staff: 0, settings: settingsOf(created.score.tracks[1].staves[0], { droneFret: 5 }) });
    state = previewEdit(state.project, { type: 'setNote', target: banjoAt(0), string: 1, fret: 7 });
    state = previewEdit(state.project, { type: 'setNote', target: banjoAt(1), string: 1, fret: 0 });
    const before = notesOf(state.score, 1).map(sounds);
    expect(before).toEqual([69, 67]);
    // The drone string is tuned up a semitone: the fret-7 note is one above its open string (fret 6); the open note needs a lower pitch than the string now has.
    const moved = previewEdit(state.project, { type: 'setTuning', track: 1, tuning: [62, 59, 55, 50, 68], keepPitch: true });
    const after = notesOf(moved.score, 1);
    expect(after[0]).toMatchObject({ string: 1, fret: 6 });
    expect(sounds(after[0])).toBe(69);
    expect(after[1].fret === 0 || after[1].fret > 5).toBe(true);
    expect(sounds(after[1])).toBe(67);
  });
});

describe('refinger fuzz', () => {
  // A small seeded generator keeps failures reproducible.
  const random = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

  it('keeps every sounding pitch, tie and string for random scores and tunings, or refuses cleanly', () => {
    const next = random(20261031);
    let moved = 0, refused = 0, tied = 0;
    for (let round = 0; round < 40; round++) {
      const edits: EditCommand[] = [];
      const placed = new Map<string, [number, number]>();
      for (let bar = 0; bar < 2; bar++) for (let beat = 0; beat < 4; beat++) {
        const count = 1 + Math.floor(next() * 3), strings = new Set<number>();
        while (strings.size < count) strings.add(1 + Math.floor(next() * 6));
        for (const string of strings) {
          const fret = Math.floor(next() * 15);
          edits.push({ type: 'setNote', target: at(bar, beat), string, fret });
          placed.set(`${bar}/${beat}/${string}`, [string, fret]);
        }
      }
      // Tie a note to the same fret on the same string in the next beat when both exist.
      for (let bar = 0; bar < 2; bar++) for (let beat = 0; beat < 3; beat++) for (let string = 1; string <= 6; string++) {
        const here = placed.get(`${bar}/${beat}/${string}`), there = placed.get(`${bar}/${beat + 1}/${string}`);
        if (here && there && here[1] === there[1] && next() < 0.8) edits.push({ type: 'setNoteLink', from: { target: at(bar, beat), string }, to: { target: at(bar, beat + 1), string }, kind: 'tie' });
      }
      const base = projectWithEdits(...edits);
      const tuning = standard.map(pitch => pitch + Math.floor(next() * 7) - 3);
      const before = notesOf(base.score).map(sounds);
      const ties = notesOf(base.score).filter(n => n.tieDestination).length;
      tied += ties;
      let result;
      try {
        result = previewEdit(base.project, { type: 'setTuning', track: 0, tuning, keepPitch: true }).score;
      } catch (error) {
        expect(String(error)).toMatch(/Keep pitch could not move every note|next-note relationship/);
        refused++;
        continue;
      }
      moved++;
      const after = notesOf(result);
      expect([...after.map(sounds)].sort()).toEqual([...before].sort());
      expect(after.filter(n => n.tieDestination).length).toBe(ties);
      for (const bar of result.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) {
        expect(new Set(beat.notes.map(n => n.string)).size).toBe(beat.notes.length);
      }
      for (const note of after) if (note.tieDestination) expect(note.tieDestination.string).toBe(note.string);
    }
    expect(moved).toBeGreaterThan(5);
    expect(tied).toBeGreaterThan(0);
    expect(moved + refused).toBe(40);
  });
});

describe('refinger uses the current rhythm, not stale playback timing', () => {
  const upOne: EditCommand = { type: 'setTuning', track: 0, tuning: [64, 59, 55, 50, 46, 40], keepPitch: true };
  const quarters = (voice: number): EditCommand[] => [0, 1, 2, 3].map(beat => ({ type: 'insertBeat', target: at(0, beat, voice), duration: 4, dots: 0 }));

  it('a lengthened first beat in voice 0 makes later beats overlap, and the notes keep apart', () => {
    const base = projectWithEdits(
      { type: 'addVoice', track: 0, staff: 0 }, ...quarters(1),
      { type: 'setNote', target: at(0, 2, 1), string: 1, fret: 8 },
      { type: 'setNote', target: at(0, 1, 0), string: 2, fret: 0 },
      { type: 'deleteBeat', target: at(0, 3, 0) },
      { type: 'setDuration', target: at(0, 0, 0), duration: 2, dots: 0 }
    );
    const bar = previewEdit(base.project, upOne).score.tracks[0].staves[0].bars[0];
    expect(bar.voices[0].beats[1].notes[0].string).not.toBe(bar.voices[1].beats[2].notes[0].string);
  });

  it('a tuplet set just before keeps overlapping notes on different strings', () => {
    // Triplet eighths last 320 ticks, so the second (320 to 640) overlaps voice 0's eighth (0 to 480); stale timing would put it at 480 to 960.
    const trip = (beat: number): EditCommand => ({ type: 'setBeatRhythm', target: at(0, beat, 1), duration: 8, dots: 0, tupletNumerator: 3, tupletDenominator: 2, graceType: 0 });
    const eighths = [0, 1, 2].map((beat): EditCommand => ({ type: 'insertBeat', target: at(0, beat, 1), duration: 8, dots: 0 }));
    const base = projectWithEdits(
      { type: 'addVoice', track: 0, staff: 0 }, ...eighths, trip(0), trip(1), trip(2),
      { type: 'setNote', target: at(0, 1, 1), string: 1, fret: 8 },
      { type: 'setDuration', target: at(0, 0, 0), duration: 8, dots: 0 },
      { type: 'setNote', target: at(0, 0, 0), string: 2, fret: 0 }
    );
    const bar = previewEdit(base.project, upOne).score.tracks[0].staves[0].bars[0];
    expect(bar.voices[0].beats[0].notes[0].string).not.toBe(bar.voices[1].beats[1].notes[0].string);
  });

  it('gives the same result with or without a rebuild before it', () => {
    const edits: EditCommand[] = [
      { type: 'addVoice', track: 0, staff: 0 }, ...quarters(1),
      { type: 'setNote', target: at(0, 2, 1), string: 1, fret: 8 },
      { type: 'setNote', target: at(0, 1, 0), string: 2, fret: 0 },
      { type: 'deleteBeat', target: at(0, 3, 0) },
      { type: 'setDuration', target: at(0, 0, 0), duration: 2, dots: 0 },
    ];
    const strings = (extra: EditCommand[]) => notesOf(previewEdit(projectWithEdits(...edits, ...extra).project, upOne).score).map(n => [n.string, n.fret]);
    expect(strings([])).toEqual(strings([{ type: 'appendMeasure' }]));
  });
});

describe('refinger grace notes in another voice', () => {
  const upOne: EditCommand = { type: 'setTuning', track: 0, tuning: [64, 59, 55, 50, 46, 40], keepPitch: true };
  // Voice 1: quarter, grace on string 1 fret 3, quarter. Voice 0 has a note on string 2 at tick 960.
  const withGrace = (graceType: model.GraceType) => projectWithEdits(
    { type: 'addVoice', track: 0, staff: 0 },
    ...[0, 1, 2, 3].map((beat): EditCommand => ({ type: 'insertBeat', target: at(0, beat, 1), duration: 4, dots: 0 })),
    { type: 'setBeatRhythm', target: at(0, 1, 1), duration: 16, dots: 0, tupletNumerator: 1, tupletDenominator: 1, graceType },
    { type: 'setNote', target: at(0, 1, 1), string: 1, fret: 3 },
    { type: 'setNote', target: at(0, 1, 0), string: 2, fret: 0 }
  );
  const outcome = (graceType: model.GraceType) => {
    const base = withGrace(graceType);
    try {
      const bar = previewEdit(base.project, upOne).score.tracks[0].staves[0].bars[0];
      return { strings: [bar.voices[0].beats[1].notes[0].string, bar.voices[1].beats[1].notes[0].string] };
    } catch (error) { return { refused: String(error) }; }
  };

  it.each([['OnBeat', model.GraceType.OnBeat], ['BendGrace', model.GraceType.BendGrace]])('a %s grace note sounds with the beat and cannot share its string', (_name, graceType) => {
    const result = outcome(graceType);
    if ('strings' in result) expect(result.strings[0]).not.toBe(result.strings[1]);
    else expect(result.refused).toMatch(/Keep pitch could not move every note/);
  });

  it('a BeforeBeat grace note ends before the beat, so the two may share a string', () => {
    const result = outcome(model.GraceType.BeforeBeat);
    expect(result).toEqual({ strings: [1, 1] });
  });
});

describe('refinger chord diagrams that no beat uses', () => {
  it('an unused diagram that cannot follow does not refuse the edit, and one that can is remapped', () => {
    // Both diagrams stay in the staff after their beats stop pointing at them.
    const base = projectWithEdits(
      { type: 'setBeatAnnotation', target, text: '', chord: { name: 'E', firstFret: 1, frets: [0, 0, 1, 2, 2, 0] } },
      { type: 'setBeatAnnotation', target, text: '', chord: null },
      { type: 'setBeatAnnotation', target: at(0, 1), text: '', chord: { name: 'D5', firstFret: 1, frets: [-1, -1, -1, 2, 2, -1] } },
      { type: 'setBeatAnnotation', target: at(0, 1), text: '', chord: null }
    );
    const staff = base.score.tracks[0].staves[0];
    expect([...staff.chords!.values()]).toHaveLength(2);
    const settings = settingsOf(staff, { capo: 2, keepPitch: true });
    const moved = previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings }).score.tracks[0].staves[0];
    const byName = new Map([...moved.chords!.values()].map(chord => [chord.name, [...chord.strings]]));
    expect(byName.get('E')).toEqual([0, 0, 1, 2, 2, 0]);
    expect(byName.get('D5')).toEqual([-1, -1, -1, 0, 0, -1]);
  });

  it('a diagram a beat uses still refuses', () => {
    const base = projectWithEdits({ type: 'setBeatAnnotation', target, text: '', chord: { name: 'E', firstFret: 1, frets: [0, 0, 1, 2, 2, 0] } });
    const settings = settingsOf(base.score.tracks[0].staves[0], { capo: 2, keepPitch: true });
    expect(() => previewEdit(base.project, { type: 'setStaffSettings', track: 0, staff: 0, settings })).toThrow(/chord diagram E/);
  });
});
