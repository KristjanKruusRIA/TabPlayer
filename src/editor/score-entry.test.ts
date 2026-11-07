import { expect, it } from 'vitest';
import { buildDocument, describeSelection, previewEdit } from '../engine';
import type { EditCommand } from '../edit-types';
import { blankProject, projectCommands, type BeatTarget, type Project } from '../project';
import { DEFAULT_INPUT_PREFERENCES } from './input-preferences';
import { drawnSpelling, entryPitch, writtenPitch } from './notation-entry';
import { entryNotes } from '../instruments/entry';
import { durationKeyEdit, letterPitch, movedPitch, planNoteMove, planScoreEntry, respellNote, scoreEntryKey, selectedNote, stepEntryPitch, type EntryPlan } from './score-entry';

const piano = (beat: number, bar = 0): BeatTarget => ({ track: 1, staff: 0, bar, voice: 0, beat });
const guitar = (beat: number): BeatTarget => ({ track: 0, staff: 0, bar: 0, voice: 0, beat });
const project = (...edits: EditCommand[]): Project => ({ ...blankProject(), edits: [{ type: 'addPitchedTrack', name: 'Piano', program: 0 }, ...edits] });
const keys = (key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}, code?: string) => scoreEntryKey({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const plan = (base: Project, target: BeatTarget, pitch: ReturnType<typeof entryPitch>, options: { autoDuration?: boolean; advance?: boolean; chord?: boolean; entry?: { duration: number; dots: number } | null } = {}) => {
  const result = planScoreEntry({ project: base, score: buildDocument(base).score, target, entered: pitch!, preferences: { ...DEFAULT_INPUT_PREFERENCES, autoDuration: options.autoDuration ?? false, advance: options.advance ?? true }, entry: options.entry ?? null, chord: options.chord ?? false });
  if ('refused' in result) throw new Error(result.refused);
  return result;
};
/** Records a plan the way the app does: one edit, then the score it leaves. */
const record = (base: Project, planned: EntryPlan) => previewEdit(base, planned.command);
const types = (command: EditCommand) => command.type === 'sequence' ? command.commands.map(step => step.type) : [command.type];

it('maps Guitar Pro style keys and leaves the rest alone', () => {
  expect(keys('c')).toEqual({ kind: 'letter', letter: 0 }); expect(keys('B', { shiftKey: true })).toEqual({ kind: 'letter', letter: 6 });
  expect(keys('+')).toEqual({ kind: 'shorter' }); expect(keys('-')).toEqual({ kind: 'longer' });
  expect(keys('.')).toEqual({ kind: 'dot', double: false }); expect(keys('.', { ctrlKey: true })).toEqual({ kind: 'dot', double: true });
  expect(keys('/')).toEqual({ kind: 'triplet' }); expect(keys('r')).toEqual({ kind: 'rest' });
  expect(keys('ArrowUp', { ctrlKey: true, altKey: true })).toEqual({ kind: 'step', by: 1 });
  expect(keys('ArrowDown', { altKey: true, shiftKey: true })).toEqual({ kind: 'semitone', by: -1 });
  expect(keys('ArrowUp', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'octave', by: 1 });
  for (const [key, mods] of [['ArrowUp', {}], ['h', {}], ['c', { ctrlKey: true }], ['c', { altKey: true }], ['1', {}], ['Enter', {}]] as const) expect(keys(key, mods)).toBeNull();
});

it('changes durations as Guitar Pro does and records nothing outside the plain range', () => {
  const beat = describeSelection(buildDocument(project()).score, piano(0)).beat!;
  expect(durationKeyEdit({ kind: 'shorter' }, piano(0), beat)?.command).toEqual({ type: 'setDuration', target: piano(0), duration: 8, dots: 0 });
  expect(durationKeyEdit({ kind: 'longer' }, piano(0), beat)?.command).toEqual({ type: 'setDuration', target: piano(0), duration: 2, dots: 0 });
  expect(durationKeyEdit({ kind: 'dot', double: false }, piano(0), beat)?.command).toMatchObject({ dots: 1 });
  expect(durationKeyEdit({ kind: 'triplet' }, piano(0), beat)?.command).toMatchObject({ type: 'setBeatRhythm', tupletNumerator: 3, tupletDenominator: 2 });
  const shortest = describeSelection(buildDocument(project({ type: 'setDuration', target: piano(0), duration: 64, dots: 0 })).score, piano(0)).beat!;
  expect(durationKeyEdit({ kind: 'shorter' }, piano(0), shortest)).toBeNull();
});

it('enters a letter in the octave nearest the previous note', () => {
  expect(letterPitch(0, 64, 0)?.pitch).toBe(60); expect(letterPitch(0, 67, 0)?.pitch).toBe(72);
  expect(letterPitch(6, 60, -1)?.name).toBe('Bb3');
});

it('writes a note as one edit and advances to the next beat', () => {
  const base = project(), planned = plan(base, piano(0), entryPitch(0, 4, 'key', 0));
  expect(planned.command).toEqual({ type: 'addPitchedNote', target: piano(0), pitch: 60 });
  expect(planned.next).toEqual(piano(1));
  expect(plan(base, piano(0), entryPitch(0, 4, 'key', 0), { chord: true }).next).toEqual(piano(0));
  expect(plan(base, piano(0), entryPitch(0, 4, 'key', 0), { advance: false }).next).toEqual(piano(0));
});

it('puts the rhythm, the note and its spelling in one edit, so one undo takes back the whole entry', () => {
  const base = project(), flat = entryPitch(6, 4, 'flat', 0)!;
  const planned = plan(base, piano(0), flat, { autoDuration: true, entry: { duration: 8, dots: 0 } });
  expect(types(planned.command)).toEqual(['setDuration', 'addPitchedNote', 'setNoteSpelling']);
  const after = record(base, planned);
  expect(after.project.edits).toHaveLength(base.edits.length + 1);
  const beat = after.score.tracks[1].staves[0].bars[0].voices[0].beats[0];
  expect({ duration: beat.duration, pitch: beat.notes[0].octave * 12 + beat.notes[0].tone, mode: beat.notes[0].accidentalMode }).toEqual({ duration: 8, pitch: 70, mode: 5 });
  // Undo removes the last history entry: the whole gesture.
  expect(buildDocument({ ...after.project, edits: after.project.edits.slice(0, -1) }).score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes).toHaveLength(0);
});

it('adds a rest to write into when the last beat of a bar with room is entered', () => {
  // Four eighths into a 4/4 bar of quarter rests: the fourth entry shortens the last rest and leaves room for more.
  let base = project();
  for (let beat = 0; beat < 4; beat++) {
    const planned = plan(base, piano(beat), entryPitch(beat, 4, 'key', 0), { autoDuration: true, entry: { duration: 8, dots: 0 } });
    if (beat === 3) { expect(types(planned.command)).toEqual(['setDuration', 'addPitchedNote', 'insertBeat']); expect(planned.next).toEqual(piano(4)); }
    else expect(planned.next).toEqual(piano(beat + 1));
    base = record(base, planned).project;
  }
  const voice = buildDocument(base).score.tracks[1].staves[0].bars[0].voices[0];
  expect(voice.beats.map(beat => [beat.duration, beat.notes.length])).toEqual([[8, 1], [8, 1], [8, 1], [8, 1], [8, 0]]);
  expect(projectCommands(base).filter(edit => edit.type === 'insertBeat')).toHaveLength(1);
  // A full bar moves on to the next bar instead.
  const full = plan(project(), piano(3), entryPitch(0, 4, 'key', 0));
  expect(full.next).toEqual(piano(0, 1)); expect(types(full.command)).toEqual(['addPitchedNote']);
});

it('removes a pitch the beat already has, and refuses one no string can play', () => {
  const base = project({ type: 'addPitchedNote', target: piano(0), pitch: 64 });
  const removal = plan(base, piano(0), entryPitch(2, 4, 'key', 0));
  expect(removal.removes).toBe(true); expect(removal.command).toMatchObject({ type: 'removeNoteByIndex' }); expect(removal.next).toEqual(piano(0));
  const tooLow = planScoreEntry({ project: base, score: buildDocument(base).score, target: guitar(0), entered: entryPitch(0, 1, 'key', 0)!, preferences: DEFAULT_INPUT_PREFERENCES, entry: null, chord: false });
  expect(tooLow).toEqual({ refused: 'no_string', name: 'C1' });
});

it('reads a clicked staff position in the clef of the bar', () => {
  const score = buildDocument(project()).score;
  expect(stepEntryPitch(score, piano(0), 0)?.name).toBe('E4'); // Treble bottom line.
  expect(stepEntryPitch(score, guitar(0), 0)?.name).toBe('E4'); // Written pitch on the guitar's treble staff.
});

it('moves the selected note in place by a staff step, a semitone or an octave as one edit', () => {
  const base = project({ type: 'addPitchedNote', target: piano(0), pitch: 60 }), score = buildDocument(base).score;
  const { staff, bar, beat } = describeSelection(score, piano(0)), note = selectedNote(beat!, null, null)!;
  expect(movedPitch(staff, bar, beat!, note, { kind: 'step', by: 1 })?.name).toBe('D4');
  expect(movedPitch(staff, bar, beat!, note, { kind: 'semitone', by: 1 })?.name).toBe('C#4');
  expect(movedPitch(staff, bar, beat!, note, { kind: 'semitone', by: -1 })?.name).toBe('B3');
  expect(movedPitch(staff, bar, beat!, note, { kind: 'octave', by: -1 })?.pitch).toBe(48);
  const moved = planNoteMove(base, score, piano(0), note, movedPitch(staff, bar, beat!, note, { kind: 'semitone', by: 1 })!);
  if ('refused' in moved) throw new Error(moved.refused);
  expect(types(moved.command)).toEqual(['setPitchedNote']);
  const after = record(base, moved).score.tracks[1].staves[0].bars[0].voices[0].beats[0];
  expect(after.notes.map(item => item.octave * 12 + item.tone)).toEqual([61]);
  // Down a semitone from D4 is spelled D flat, which needs its own spelling in the same edit.
  const d = project({ type: 'addPitchedNote', target: piano(0), pitch: 62 }), dScore = buildDocument(d).score, dAt = describeSelection(dScore, piano(0));
  const flat = movedPitch(dAt.staff, dAt.bar, dAt.beat!, dAt.beat!.notes[0], { kind: 'semitone', by: -1 })!;
  expect(flat.name).toBe('Db4');
  const spelled = planNoteMove(d, dScore, piano(0), dAt.beat!.notes[0], flat);
  if ('refused' in spelled) throw new Error(spelled.refused);
  expect(types(spelled.command)).toEqual(['setPitchedNote', 'setNoteSpelling']);
});

it('moves a fretted note along its string, and refuses a pitch the beat already has', () => {
  const base = project({ type: 'setNote', target: guitar(0), string: 3, fret: 2 }, { type: 'setNote', target: guitar(0), string: 4, fret: 2 }), score = buildDocument(base).score;
  const { staff, bar, beat } = describeSelection(score, guitar(0)), note = selectedNote(beat!, 3, null)!;
  const up = movedPitch(staff, bar, beat!, note, { kind: 'semitone', by: 1 })!;
  const moved = planNoteMove(base, score, guitar(0), note, up);
  if ('refused' in moved) throw new Error(moved.refused);
  expect(moved.command).toEqual({ type: 'setNote', target: guitar(0), string: 3, fret: 3 });
  // Moving string 3 onto the pitch string 4 already plays is refused, and nothing is planned.
  const other = selectedNote(beat!, 4, null)!, key = entryNotes(staff, beat!).find(item => item.index === other.index)!.key;
  const drawn = drawnSpelling(0, writtenPitch(staff, bar, beat!, key), other.accidentalMode);
  expect(planNoteMove(base, score, guitar(0), note, entryPitch(drawn.letter, drawn.octave, 'key', 0)!)).toMatchObject({ refused: 'present' });
});

it('keeps the techniques and ties of a moved note', () => {
  const pitched = project({ type: 'addPitchedNote', target: piano(0), pitch: 60 }, { type: 'setNoteTechniquesByIndex', target: piano(0), noteIndex: 0, patch: { staccato: true, accent: 1 } },
    { type: 'addPitchedNote', target: piano(1), pitch: 60 }, { type: 'setNoteLinkByIndex', from: { target: piano(0), noteIndex: 0 }, to: { target: piano(1), noteIndex: 0 }, kind: 'tie' } as EditCommand);
  const score = buildDocument(pitched).score, at = describeSelection(score, piano(0)), note = at.beat!.notes[0];
  const moved = planNoteMove(pitched, score, piano(0), note, movedPitch(at.staff, at.bar, at.beat!, note, { kind: 'step', by: 1 })!);
  if ('refused' in moved) throw new Error(moved.refused);
  const voice = record(pitched, moved).score.tracks[1].staves[0].bars[0].voices[0];
  expect(voice.beats.slice(0, 2).map(beat => [beat.notes[0].octave * 12 + beat.notes[0].tone, beat.notes[0].isStaccato])).toEqual([[62, true], [62, false]]);
  expect(voice.beats[1].notes[0].isTieDestination).toBe(true);
  const fretted = project({ type: 'setNote', target: guitar(0), string: 3, fret: 2 }, { type: 'setNoteTechniques', target: guitar(0), string: 3, patch: { staccato: true } } as EditCommand);
  const fScore = buildDocument(fretted).score, fAt = describeSelection(fScore, guitar(0)), fNote = selectedNote(fAt.beat!, 3, null)!;
  const up = planNoteMove(fretted, fScore, guitar(0), fNote, movedPitch(fAt.staff, fAt.bar, fAt.beat!, fNote, { kind: 'semitone', by: 1 })!);
  if ('refused' in up) throw new Error(up.refused);
  const after = record(fretted, up).score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect([after.string, after.fret, after.isStaccato]).toEqual([3, 3, true]);
});

it('writes a fretted note again on another string only when its own string cannot reach the pitch', () => {
  const base = project({ type: 'setNote', target: guitar(0), string: 3, fret: 0 }), score = buildDocument(base).score;
  const at = describeSelection(score, guitar(0)), note = selectedNote(at.beat!, 3, null)!;
  const down = planNoteMove(base, score, guitar(0), note, movedPitch(at.staff, at.bar, at.beat!, note, { kind: 'semitone', by: -1 })!);
  if ('refused' in down) throw new Error(down.refused);
  expect(types(down.command).slice(0, 2)).toEqual(['removeNote', 'setNote']);
  const after = record(base, down).score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
  expect(after.map(item => item.string !== 3)).toEqual([true]);
});

it('spells the tied notes a move carries, and refuses a move a tied beat already holds', () => {
  const tie = (from: BeatTarget, to: BeatTarget) => ({ type: 'setNoteLinkByIndex', from: { target: from, noteIndex: 0 }, to: { target: to, noteIndex: 0 }, kind: 'tie' }) as EditCommand;
  // D4 tied to D4: a semitone down is D flat on both.
  const pitched = project({ type: 'addPitchedNote', target: piano(0), pitch: 62 }, { type: 'addPitchedNote', target: piano(1), pitch: 62 }, tie(piano(0), piano(1)));
  const score = buildDocument(pitched).score, at = describeSelection(score, piano(0)), note = at.beat!.notes[0];
  const flat = planNoteMove(pitched, score, piano(0), note, movedPitch(at.staff, at.bar, at.beat!, note, { kind: 'semitone', by: -1 })!);
  if ('refused' in flat) throw new Error(flat.refused);
  expect(types(flat.command)).toEqual(['setPitchedNote', 'setNoteSpelling', 'setNoteSpelling']);
  const voice = record(pitched, flat).score.tracks[1].staves[0].bars[0].voices[0];
  expect(voice.beats.slice(0, 2).map(beat => [beat.notes[0].octave * 12 + beat.notes[0].tone, beat.notes[0].accidentalMode])).toEqual([[61, 5], [61, 5]]);
  // String 3 fret 2 tied into a beat whose string 2 already plays a semitone higher: the move is refused.
  const fretted = project({ type: 'setNote', target: guitar(0), string: 3, fret: 2 }, { type: 'setNote', target: guitar(1), string: 3, fret: 2 },
    { type: 'setNoteLinkByIndex', from: { target: guitar(0), noteIndex: 0 }, to: { target: guitar(1), noteIndex: 0 }, kind: 'tie' } as EditCommand,
    { type: 'setNote', target: guitar(1), string: 2, fret: 8 });
  const fScore = buildDocument(fretted).score, fAt = describeSelection(fScore, guitar(0)), fNote = selectedNote(fAt.beat!, 3, null)!;
  const up = movedPitch(fAt.staff, fAt.bar, fAt.beat!, fNote, { kind: 'semitone', by: 1 })!;
  const keys = entryNotes(fAt.staff, describeSelection(fScore, guitar(1)).beat!).map(item => item.key);
  expect(keys).toContain(entryNotes(fAt.staff, fAt.beat!)[0].key + 1);
  expect(planNoteMove(fretted, fScore, guitar(0), fNote, up)).toMatchObject({ refused: 'present' });
});

it('maps the Ctrl+7/8/9 accidental chords from the physical key, with Meta as Ctrl', () => {
  expect(keys('7', { ctrlKey: true }, 'Digit7')).toEqual({ kind: 'accidental', value: 'flat' });
  expect(keys('8', { ctrlKey: true }, 'Digit8')).toEqual({ kind: 'accidental', value: 'natural' });
  expect(keys('9', { ctrlKey: true }, 'Digit9')).toEqual({ kind: 'accidental', value: 'sharp' });
  expect(keys('7', { ctrlKey: true, altKey: true }, 'Digit7')).toEqual({ kind: 'accidental', value: 'doubleFlat' });
  expect(keys('9', { ctrlKey: true, altKey: true }, 'Digit9')).toEqual({ kind: 'accidental', value: 'doubleSharp' });
  expect(keys('8', { ctrlKey: true, altKey: true }, 'Digit8')).toEqual({ kind: 'respell' });
  expect(keys('9', { metaKey: true }, 'Digit9')).toEqual({ kind: 'accidental', value: 'sharp' });
  // AltGr reports a brace as the key with ctrl and alt set; the code still says Digit7.
  expect(keys('{', { ctrlKey: true, altKey: true }, 'Digit7')).toEqual({ kind: 'accidental', value: 'doubleFlat' });
  for (const [key, mods, code] of [['7', {}, 'Digit7'], ['7', { altKey: true }, 'Digit7'], ['7', { ctrlKey: true, shiftKey: true }, 'Digit7'], ['7', { ctrlKey: true }, 'Numpad7'], ['7', { ctrlKey: true }, undefined], ['0', { ctrlKey: true }, 'Digit0']] as const) expect(keys(key, mods, code)).toBeNull();
});

it('writes a pending accidental with the note and its spelling as one sequence', () => {
  const base = project(), flat = letterPitch(1, 62, 0, 'doubleSharp')!;
  expect(flat).toMatchObject({ name: 'D##4', pitch: 64 });
  const planned = plan(base, piano(0), flat);
  expect(planned.command).toEqual({ type: 'sequence', commands: [{ type: 'addPitchedNote', target: piano(0), pitch: 64 }, { type: 'setNoteSpelling', target: piano(0), noteIndex: 0, accidentalMode: 4 }] });
  expect(record(base, planned).score.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].accidentalMode).toBe(4);
  expect(letterPitch(6, 60, -1, 'natural')?.name).toBe('B3');
  expect(stepEntryPitch(buildDocument(base).score, piano(0), 2, 'sharp')?.name).toBe('G#4');
});

it('keeps the double when a note spelled with one moves an octave', () => {
  for (const [mode, name] of [[4, 'C##'], [6, 'Ebb']] as const) {
    const base = project({ type: 'addPitchedNote', target: piano(0), pitch: 62 }, { type: 'setNoteSpelling', target: piano(0), noteIndex: 0, accidentalMode: mode });
    const { staff, bar, beat } = describeSelection(buildDocument(base).score, piano(0)), note = beat!.notes[0];
    const up = movedPitch(staff, bar, beat!, note, { kind: 'octave', by: 1 })!, down = movedPitch(staff, bar, beat!, note, { kind: 'octave', by: -1 })!;
    expect([up.pitch, up.name, up.alteration]).toEqual([74, `${name}5`, mode === 4 ? 2 : -2]);
    expect([down.pitch, down.name]).toEqual([50, `${name}3`]);
  }
});

it('re-spells a note without changing its pitch, and refuses or ignores what it cannot or need not do', () => {
  const spelled = (pitch: number, mode?: number) => {
    const base = project({ type: 'addPitchedNote', target: piano(0), pitch }, ...(mode ? [{ type: 'setNoteSpelling', target: piano(0), noteIndex: 0, accidentalMode: mode } as EditCommand] : []));
    const { staff, bar, beat } = describeSelection(buildDocument(base).score, piano(0));
    return { base, args: [staff, bar, beat!, beat!.notes[0]] as const };
  };
  const d = spelled(62);
  expect(respellNote(...d.args, 'natural')).toEqual({ same: true });
  expect(respellNote(...d.args, 'sharp')).toEqual({ refused: 'no_spelling', name: 'D4' });
  expect(respellNote(...d.args, 'flat')).toEqual({ refused: 'no_spelling', name: 'D4' });
  const sharp = respellNote(...d.args, 'doubleSharp');
  expect(sharp).toEqual({ mode: 4, name: 'C##4' });
  const written = previewEdit(d.base, { type: 'setNoteSpelling', target: piano(0), noteIndex: 0, accidentalMode: 4 }).score;
  const note = written.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0];
  expect(note.realValue).toBe(spelled(62).args[3].realValue);
  // Change Accidental walks D (natural) to C##, then Ebb, then back to D, one edit each.
  expect(respellNote(...d.args, 'cycle')).toEqual({ mode: 4, name: 'C##4' });
  expect(respellNote(...spelled(62, 4).args, 'cycle')).toEqual({ mode: 6, name: 'Ebb4' });
  expect(respellNote(...spelled(62, 6).args, 'cycle')).toEqual({ mode: 0, name: 'D4' });
  // C sharp has a flat and a double-sharp B, and its current spelling is the sharp.
  const cSharp = spelled(61);
  expect(respellNote(...cSharp.args, 'sharp')).toEqual({ same: true });
  expect(respellNote(...cSharp.args, 'flat')).toMatchObject({ mode: 5, name: 'Db4' });
  expect(respellNote(...cSharp.args, 'natural')).toEqual({ refused: 'no_spelling', name: 'C#4' });
  expect(respellNote(...spelled(68).args, 'doubleFlat')).toEqual({ refused: 'no_spelling', name: 'G#4' });
});
