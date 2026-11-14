import { expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { setPartialCapo } from '../editor/partial-capo';
import type { PositionNote } from '../instruments/fret-positions';
import { FRETLIGHT_FRETS, FRETLIGHT_LEDS, FRETLIGHT_STRINGS, deviceString, emptyFrame, frameFor, frameKey, ledFret, litSet } from './frame';

const STANDARD = [64, 59, 55, 50, 45, 40];
interface Built { score: model.Score; staff: model.Staff }
/** One staff with the given tuning holding one beat whose notes are `[string, fret]`; strings count from the lowest, as the score does. */
function build(tuning: number[], placed: Array<[number, number]>, options: { capo?: number; percussion?: boolean; partial?: { fret: number; strings: number[] } } = {}): Built {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff();
  track.playbackInfo.program = 25;
  staff.stringTuning.tunings = tuning; staff.capo = options.capo ?? 0; staff.isPercussion = options.percussion ?? false;
  if (options.partial) setPartialCapo(staff, options.partial);
  track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.duration = model.Duration.Quarter;
  for (const [string, fret] of placed) { const note = new model.Note(); note.string = string; note.fret = fret; beat.addNote(note); }
  voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return { score, staff };
}
const at = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
/** The planned notes the instrument view would be given for those strings. */
const notes = (staff: model.Staff, strings: number[]): PositionNote[] => strings.map((string, index) => ({ id: `0/0/0/0/0/${index}/0/0/0`, key: staff.bars[0].voices[0].beats[0].notes.find(note => note.string === string)!.realValue, source: { target: at, string } }));

it('has the documented size: six strings, frets 0 to 21, one LED each', () => {
  expect([FRETLIGHT_STRINGS, FRETLIGHT_FRETS, FRETLIGHT_LEDS]).toEqual([6, 22, 132]);
  expect(emptyFrame().leds).toHaveLength(132);
  expect(litSet(emptyFrame())).toEqual([]);
});
it('numbers the device strings from the high E, the opposite of the score', () => {
  expect([1, 2, 3, 4, 5, 6].map(deviceString)).toEqual([6, 5, 4, 3, 2, 1]);
});
it('lights the written fret on the string the score names, counted from the high E', () => {
  const { staff } = build(STANDARD, [[6, 3], [1, 0], [3, 12]]);
  const frame = frameFor(staff, notes(staff, [6, 1, 3]));
  expect(litSet(frame)).toEqual([{ string: 1, fret: 3 }, { string: 4, fret: 12 }, { string: 6, fret: 0 }]);
  expect(frame.problem).toBeNull(); expect(frame.dropped).toBe(0);
});
it('ignores the tuning: a drop D neck lights the same frets', () => {
  const standardStaff = build(STANDARD, [[1, 2]]).staff, dropStaff = build([64, 59, 55, 50, 45, 38], [[1, 2]]).staff;
  const standard = frameFor(standardStaff, notes(standardStaff, [1])), drop = frameFor(dropStaff, notes(dropStaff, [1]));
  expect(litSet(drop)).toEqual(litSet(standard));
  expect(litSet(drop)).toEqual([{ string: 6, fret: 2 }]);
});
it('lights the physical fret under a capo, and the written one when the mode is flipped', () => {
  const { staff } = build(STANDARD, [[6, 3], [1, 0]], { capo: 2 });
  expect(litSet(frameFor(staff, notes(staff, [6, 1])))).toEqual([{ string: 1, fret: 5 }, { string: 6, fret: 2 }]);
  expect(litSet(frameFor(staff, notes(staff, [6, 1]), { capoMode: 'written' }))).toEqual([{ string: 1, fret: 3 }, { string: 6, fret: 0 }]);
});
it('applies a partial capo only to the strings it covers', () => {
  const { staff } = build(STANDARD, [[1, 3], [6, 3]], { capo: 2, partial: { fret: 5, strings: [1, 2, 3] } });
  // String 1 (low E) sits under the partial capo at 5, the high E under the capo at 2.
  expect(litSet(frameFor(staff, notes(staff, [1, 6])))).toEqual([{ string: 1, fret: 5 }, { string: 6, fret: 8 }]);
});
it('converts a capo with one tested function', () => {
  expect(ledFret(3, 2)).toBe(5);
  expect(ledFret(3, 2, 'physical')).toBe(5);
  expect(ledFret(3, 2, 'written')).toBe(3);
  expect(ledFret(0, 0)).toBe(0);
});
it('drops a position past fret 21 and counts it', () => {
  const { staff } = build(STANDARD, [[6, 21], [5, 22], [4, 24]]);
  const frame = frameFor(staff, notes(staff, [6, 5, 4]));
  expect(litSet(frame)).toEqual([{ string: 1, fret: 21 }]);
  expect(frame.dropped).toBe(2);
});
it('drops a position the capo pushes past fret 21', () => {
  const { staff } = build(STANDARD, [[6, 20], [5, 18]], { capo: 3 });
  const frame = frameFor(staff, notes(staff, [6, 5]));
  expect(litSet(frame)).toEqual([{ string: 2, fret: 21 }]);
  expect(frame.dropped).toBe(1);
});
it('sends nothing for a staff that is not six-string and pitched, and says why', () => {
  for (const [name, built] of [
    ['seven strings', build([64, 59, 55, 50, 45, 40, 35], [[1, 3]])],
    ['four-string bass', build([43, 38, 33, 28], [[1, 3]])],
    ['banjo', build([62, 59, 55, 50, 67], [[1, 3]])],
    ['keyboard', build([], [])],
    ['percussion', build(STANDARD, [[1, 3]], { percussion: true })],
  ] as const) {
    const frame = frameFor(built.staff, [{ id: 'x', key: 60, source: { target: at, string: 1 } }]);
    expect(litSet(frame), name).toEqual([]);
    expect(frame.problem, name).toBe('not_six_string');
  }
});
it('lights held (tied) notes as the view shows them, and skips notes of another staff or off the strings', () => {
  const { staff } = build(STANDARD, [[6, 3], [5, 5]]);
  const list: PositionNote[] = [
    ...notes(staff, [6]),
    { id: 'held/0/0/0/0/0/1', key: 64, source: { target: at, string: 5 }, held: true },
    { id: 'other', key: 60, source: { target: { ...at, staff: 1 }, string: 4 } },
    { id: 'off', key: 60, source: { target: at, string: 9 } },
  ];
  expect(litSet(frameFor(staff, list))).toEqual([{ string: 1, fret: 3 }, { string: 2, fret: 5 }]);
});
it('gives equal frames equal keys, so an unchanged lit set sends nothing', () => {
  const { staff } = build(STANDARD, [[6, 3], [1, 0]]);
  expect(frameKey(frameFor(staff, notes(staff, [6, 1])))).toBe(frameKey(frameFor(staff, notes(staff, [1, 6]))));
  expect(frameKey(frameFor(staff, notes(staff, [6])))).not.toBe(frameKey(frameFor(staff, notes(staff, [1]))));
  expect(frameKey(emptyFrame())).toBe(frameKey(frameFor(staff, [])));
});
