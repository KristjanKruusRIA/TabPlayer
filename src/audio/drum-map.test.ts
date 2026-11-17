import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import maps from './drum-maps.json';
import type { ChannelMix, DrumMapRef } from '../edit-types';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { defaultMix, validateBackingSettings, validateMix } from '../document-settings';
import { blankProject } from '../project';
import fixture from '../../tests/drum-map-protocol.json';
import { cleanDrumMap, drumMapPresets, drumMapProblem, isStandardArticulation, mapArticulationId, mappedKey, readPresets, resolveDrumMap, withDrumMap } from './drum-map';

const table = () => [...new Map(standardPercussionCatalog.map(entry => [entry.id, entry.outputMidiNumber])).entries()].sort((a, b) => a[0] - b[0]);

it('holds the standard articulation catalogue, once, for the native side too', () => {
  expect(maps.sounds).toEqual(table());
  expect(maps.sounds).toHaveLength(94);
  expect(new Set(maps.sounds.map(([, key]) => key)).size).toBe(51);
  expect(maps.sounds.every(([id, key], index) => Number.isInteger(id) && key >= 0 && key < 128 && (index === 0 || id > maps.sounds[index - 1][0]))).toBe(true);
  expect(maps.presets).toEqual([{ id: 'gm', revision: 1, state: 'verified', source: 'General MIDI keys, as the built-in kit plays them.' }]);
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

const protocol = fixture as unknown as {
  validity: { name: string; valid: boolean; drumMap: unknown }[];
  resolution: { name: string; map: DrumMapRef | null; percussion: boolean; rows: [number, number | null, number | null][] }[];
  nativeOnly: { name: string; valid: boolean; rawMix: string }[];
  presets: { name: string; file: unknown; error?: boolean; survivors?: { id: string; rows: [number, number | null][] }[] }[];
};
const mixWith = (drumMap: unknown) => ({ ...defaultMix(), drumMap }) as unknown as ChannelMix;

it('holds drum maps to the rules the native player holds them to, case for case', () => {
  expect(protocol.validity.length).toBeGreaterThan(40);
  for (const { name, valid, drumMap } of protocol.validity) {
    let problem: string | null = null;
    try { validateMix(mixWith(drumMap)); } catch (error) { problem = (error as Error).message; }
    expect(problem === null, `${name}: ${problem}`).toBe(valid);
  }
});

it('resolves a map to the keys the native player resolves it to, case for case', () => {
  for (const { name, map, percussion, rows } of protocol.resolution) {
    const tables = resolveDrumMap(map, percussion);
    for (const [key, id, expected] of rows) expect(mappedKey(tables, key, id), `${name}: key ${key} id ${id}`).toBe(expected);
  }
});

it('maps every key to itself and every articulation to its General MIDI key when there is no map, and never throws', () => {
  const identity = resolveDrumMap(undefined, true);
  for (let key = 0; key < 128; key++) expect(mappedKey(identity, key)).toBe(key);
  for (const [id, key] of maps.sounds) expect(mappedKey(identity, 0, id)).toBe(key);
  for (const key of [-5, 0, 127, 128, 255, 1000, 1.5]) for (const id of [undefined, null, -3, 0, 91, 255, 4096]) expect(() => mappedKey(identity, key, id)).not.toThrow();
  expect(resolveDrumMap({ preset: 'gm', keys: [[91, 40]] }, false)).toEqual(identity);
});

it('writes a chosen map without the rows its preset already has, and General MIDI with none as no field', () => {
  expect(cleanDrumMap(undefined)).toBeUndefined();
  expect(cleanDrumMap({ preset: 'gm' })).toBeUndefined();
  expect(cleanDrumMap({ preset: 'gm', keys: [[38, 38], [91, 38]] })).toBeUndefined();
  expect(cleanDrumMap({ preset: 'gm', keys: [[91, 38], [38, 40], [42, 42]] })).toEqual({ preset: 'gm', keys: [[38, 40]] });
  expect(cleanDrumMap({ preset: 'gm', keys: [[92, null], [38, 40]] })).toEqual({ preset: 'gm', keys: [[38, 40], [92, null]] });
  // A preset this build does not know compares against General MIDI, and with no changed rows it stays named.
  expect(cleanDrumMap({ preset: 'studio', keys: [[38, 38]] })).toEqual({ preset: 'studio' });
  for (const map of [{ preset: 'gm', keys: [[38, 40]] }, { preset: 'studio' }] satisfies DrumMapRef[]) expect(drumMapProblem(cleanDrumMap(map))).toBeNull();
});

it('records nothing when the chosen map is the stored one', () => {
  const plain = defaultMix(), chosen = withDrumMap(plain, { preset: 'gm', keys: [[38, 40]] });
  expect(chosen).toEqual({ ...plain, drumMap: { preset: 'gm', keys: [[38, 40]] } });
  expect(withDrumMap(chosen, { preset: 'gm', keys: [[38, 40], [91, 38]] })).toBe(chosen);
  expect(withDrumMap(plain, { preset: 'gm', keys: [[38, 38]] })).toBe(plain);
  expect(withDrumMap(plain, undefined)).toBe(plain);
  expect('drumMap' in withDrumMap(chosen, { preset: 'gm' })).toBe(false);
});

it('refuses a drum map on a backing track, and an old mix is a mix without the field', () => {
  const backing = { assetId: 'a', offsetMs: 0, anchors: [], mix: mixWith({ preset: 'studio' }) };
  expect(() => validateBackingSettings(backing)).toThrow();
  expect(() => validateBackingSettings({ ...backing, mix: defaultMix() })).not.toThrow();
  expect(JSON.stringify(defaultMix())).toBe('{"gain":1,"pan":0,"mute":false,"solo":false}');
});

it('keeps a drum map through edit, undo, redo, save and reload, and replays an old log unchanged', () => {
  const added = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const trackId = trackIdentity(added.score.tracks[1]);
  const old = previewEdit(added.project, { type: 'setTrackMix', trackId, mix: defaultMix() });
  expect(old.settings.mixes[trackId].drumMap).toBeUndefined();
  expect('drumMap' in JSON.parse(JSON.stringify(old.project.edits.at(-1)!))['mix']).toBe(false);
  const mapped = previewEdit(old.project, { type: 'setTrackMix', trackId, mix: withDrumMap(defaultMix(), { preset: 'gm', keys: [[91, 40]] }) });
  expect(mapped.project.edits.length).toBe(old.project.edits.length + 1);
  expect(mapped.settings.mixes[trackId].drumMap).toEqual({ preset: 'gm', keys: [[91, 40]] });
  const saved = buildDocument(JSON.parse(JSON.stringify(mapped.project)));
  expect(saved.settings.mixes[trackId].drumMap).toEqual({ preset: 'gm', keys: [[91, 40]] });
  const undone = buildDocument({ ...mapped.project, edits: mapped.project.edits.slice(0, -1) });
  expect(undone.settings.mixes[trackId].drumMap).toBeUndefined();
  expect(buildDocument(mapped.project).settings.mixes[trackId].drumMap).toEqual({ preset: 'gm', keys: [[91, 40]] });
  expect(buildDocument(old.project).settings).toEqual(old.settings);
  // A bad map is refused as an edit, by the same rules.
  expect(() => previewEdit(old.project, { type: 'setTrackMix', trackId, mix: mixWith({ preset: 'gm' }) })).toThrow();
});

it('refuses a preset that is malformed anywhere as a whole, keeps the others, and reports it, case for case with the native side', () => {
  expect(protocol.presets.length).toBeGreaterThanOrEqual(10);
  for (const { name, file, error, survivors } of protocol.presets) {
    if (error) { expect(() => readPresets(file), name).toThrow(); continue; }
    const read = readPresets(file);
    expect(read.presets.map(preset => ({ id: preset.id, rows: preset.rows ?? [] })), name).toEqual(survivors);
    const given = (file as { presets: unknown[] }).presets.length;
    expect(read.problems.length, `${name}: every preset left out is reported`).toBe(given - survivors!.length);
  }
  // The presets this build embeds are all sound.
  const embedded = readPresets(maps);
  expect(embedded.problems).toEqual([]);
  expect(embedded.presets).toHaveLength(maps.presets.length);
});

it('reads a number written as a float as the integer it is, so only the native loader can refuse it, and the list of such forms is this one', () => {
  expect(protocol.nativeOnly.length).toBeGreaterThanOrEqual(5);
  for (const { name, rawMix } of protocol.nativeOnly) {
    let problem: string | null = null;
    try { validateMix(JSON.parse(rawMix)); } catch (error) { problem = (error as Error).message; }
    // JSON.parse turns 38.0, 3.8e1, 1e2 and 4e1 into the integers 38, 38, 100 and 40: nothing is left to tell them by.
    expect(problem, name).toBeNull();
  }
  expect(JSON.parse('[38.0, 3.8e1, 1e2, 4e1]')).toEqual([38, 38, 100, 40]);
});

it('compares a chosen map with the stored one by what they mean, so choosing an equivalent of a non-canonical stored map records nothing', () => {
  // Stored by an older writer or by hand: a row equal to its preset's own, rows out of order, an empty row list's cousin.
  const redundant = { ...defaultMix(), drumMap: { preset: 'gm', keys: [[38, 38]] } } as ChannelMix;
  expect(withDrumMap(redundant, { preset: 'gm' })).toBe(redundant);
  expect(withDrumMap(redundant, undefined)).toBe(redundant);
  const unordered = { ...defaultMix(), drumMap: { preset: 'gm', keys: [[91, 40], [38, 40]] } } as unknown as ChannelMix;
  expect(withDrumMap(unordered, { preset: 'gm', keys: [[38, 40], [91, 40]] })).toBe(unordered);
  const noisy = { ...defaultMix(), drumMap: { preset: 'gm', keys: [[38, 40], [42, 42]] } } as ChannelMix;
  expect(withDrumMap(noisy, { preset: 'gm', keys: [[38, 40]] })).toBe(noisy);
  // A real change is still recorded, and writes the canonical map.
  expect(withDrumMap(redundant, { preset: 'gm', keys: [[38, 41]] }).drumMap).toEqual({ preset: 'gm', keys: [[38, 41]] });
});

it('carries the revision of each preset, an integer, so a later change to the data is visible', () => {
  expect(drumMapPresets().map(preset => [preset.id, preset.revision])).toEqual([['gm', 1]]);
  const read = readPresets({ presets: [{ id: 'a', revision: 3 }, { id: 'b', revision: -1 }, { id: 'c', revision: 'x' }, { id: 'd', revision: 1.5 }, { id: 'e' }] });
  expect(read.presets.map(preset => preset.id)).toEqual(['a', 'e']);
  expect(read.problems).toHaveLength(3);
});
