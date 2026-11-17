import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import maps from './drum-maps.json';
import { isStandardArticulation, mapArticulationId } from './drum-map';

const table = () => [...new Map(standardPercussionCatalog.map(entry => [entry.id, entry.outputMidiNumber])).entries()].sort((a, b) => a[0] - b[0]);

it('holds the standard articulation catalogue, once, for the native side too', () => {
  expect(maps.sounds).toEqual(table());
  expect(maps.sounds).toHaveLength(94);
  expect(new Set(maps.sounds.map(([, key]) => key)).size).toBe(51);
  expect(maps.sounds.every(([id, key], index) => Number.isInteger(id) && key >= 0 && key < 128 && (index === 0 || id > maps.sounds[index - 1][0]))).toBe(true);
  expect(maps.presets).toEqual([{ id: 'gm', state: 'verified', source: 'General MIDI keys, as the built-in kit plays them.' }]);
});

it('knows exactly the standard ids', () => {
  for (let id = -2; id < 300; id++) expect(isStandardArticulation(id)).toBe(maps.sounds.some(([sound]) => sound === id));
  expect(isStandardArticulation(NaN)).toBe(false);
});

it('maps a table entry by its shape first and its own id second', () => {
  const symbol = model.MusicFontSymbol.NoteheadSlashedBlack1, track = new model.Track();
  track.percussionArticulations = [new model.InstrumentArticulation('Snare', 3, 38, symbol, symbol, symbol, model.MusicFontSymbol.None, model.TechniqueSymbolPlacement.Outside, 92)];
  expect(mapArticulationId(track, 0)).toBeUndefined();
  track.percussionArticulations[0].elementType = 'Charley'; track.percussionArticulations[0].outputMidiNumber = 46;
  expect(mapArticulationId(track, 0)).toBe(92);
  expect(mapArticulationId(track, 91)).toBe(91);
  expect(mapArticulationId(track, 500)).toBeUndefined();
});
