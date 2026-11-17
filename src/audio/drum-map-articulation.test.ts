import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { kitSound, standardArticulationId } from './kit-sound';
import { mapArticulationId } from './drum-map';
import golden from './kit-sound-golden.json';

/** A track whose table is a Guitar Pro 7 file's: each entry copies a standard articulation and carries its id. */
const gp7 = (ids: number[]) => {
  const track = new model.Track();
  track.percussionArticulations = ids.map(id => { const e = standardPercussionCatalog.find(item => item.id === id)!; return new model.InstrumentArticulation(e.element, e.staffLine, e.outputMidiNumber, e.symbols[0], e.symbols[1], e.symbols[2], e.symbols[3], e.symbols[4], e.id); });
  return track;
};

it('lists the standard articulations that share a shape, so only the id tells them apart', () => {
  const groups = new Map<string, number[]>();
  for (const e of standardPercussionCatalog) {
    const key = JSON.stringify([e.element, e.outputMidiNumber, e.symbols[0], e.symbols[3] ?? model.MusicFontSymbol.None]);
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  // China and its choke, and the golpe by thumb and by finger (their only difference is not one standardArticulationId reads).
  expect([...groups.values()].filter(ids => ids.length > 1)).toEqual([[52, 96], [124, 125]]);
});

it('maps a table entry that carries the id of a standard articulation to that id, even where another has its shape', () => {
  const track = gp7([52, 96, 124, 125, 38, 91]);
  expect(mapArticulationId(track, 0)).toBe(52);
  expect(mapArticulationId(track, 1)).toBe(96);
  expect(mapArticulationId(track, 2)).toBe(124);
  expect(mapArticulationId(track, 3)).toBe(125);
  expect(mapArticulationId(track, 4)).toBe(38);
  expect(mapArticulationId(track, 5)).toBe(91);
  // The same table in another order, with other positions: ids come from the entries, not their places.
  const shuffled = gp7([125, 96, 91, 124, 52, 38]);
  expect([0, 1, 2, 3, 4, 5].map(index => mapArticulationId(shuffled, index))).toEqual([125, 96, 91, 124, 52, 38]);
  // A choke whose entry carries no id of its own is still the first of its shape, as before.
  const plain = gp7([96]); plain.percussionArticulations[0].id = 0;
  expect(mapArticulationId(plain, 0)).toBe(52);
  // An entry that borrows a standard id but is another piece does not take it.
  const custom = new model.Track();
  custom.percussionArticulations = [new model.InstrumentArticulation('Cowbell', 3, 56, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.NoteheadBlack, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Outside, 96)];
  expect(mapArticulationId(custom, 0)).toBeUndefined();
});

it('leaves the recorded kit exactly as it was: standardArticulationId and kitSound are unchanged for every catalogue entry', () => {
  const own = gp7(standardPercussionCatalog.map(e => e.id)), empty = new model.Track();
  expect(standardPercussionCatalog.map((e, index) => [index, kitSound(own, index, e.outputMidiNumber)])).toEqual(golden.own);
  expect(standardPercussionCatalog.map(e => [e.id, kitSound(empty, e.id, e.outputMidiNumber)])).toEqual(golden.std);
  // The shape-first reading the recording depends on still cannot tell China from its choke.
  expect(standardArticulationId(gp7([96]), 0)).toBe(52);
});
