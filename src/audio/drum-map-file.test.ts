import { describe, expect, it, vi } from 'vitest';
import type { ChannelMix, DrumMapRef } from '../edit-types';
import { defaultMix } from '../document-settings';
import fixture from '../../tests/drum-map-protocol.json';
import { cleanDrumMap, drumMapProblem, resolveDrumMap, withDrumMap } from './drum-map';
import { fileProblem, mapFromImport, type ImportedDrumMap } from './drum-map-file';
import maps from './drum-maps.json';

// Two layouts besides General MIDI, as the data will carry them.
vi.mock('./drum-maps.json', async importOriginal => {
  const real = (await importOriginal<{ default: { sounds: unknown; presets: unknown[] } }>()).default;
  const data = { ...real, presets: [...(real.presets as { id: string }[]).filter(preset => preset.id === 'gm'), { id: 'test-kit', name: 'Test kit', state: 'unverified', source: 'Notes.', rows: [[91, 40], [42, null], [36, 35]] }] };
  return { default: data, ...data };
});

const ids = maps.sounds.map(([id]) => id);
/** The file the export writes for a map: every sound with the key the resolved map plays, and the layout the map came from. */
function exported(map: DrumMapRef | undefined): ImportedDrumMap {
  const tables = resolveDrumMap(map, true);
  return { name: 'Kit', base: map?.preset ?? 'gm', keys: ids.map(id => [id, tables.byId[id] < 128 ? tables.byId[id] : null]) };
}
const maps_: (DrumMapRef | undefined)[] = [
  undefined,
  { preset: 'gm', keys: [[38, 40]] },
  { preset: 'gm', keys: [[42, null], [91, 41], [127, 0]] },
  { preset: 'test-kit' },
  { preset: 'test-kit', keys: [[38, 41], [91, 38], [36, 36]] },
  { preset: 'mystery-kit', keys: [[38, 41]] },
];

describe('what an import stores', () => {
  it('is the same map the export came from, whatever layout it was derived from', () => {
    for (const map of maps_) {
      const stored = mapFromImport(exported(map));
      // The meaning is kept exactly; a layout this build does not have is stored as General MIDI plus the rows that differ from it.
      const meant = resolveDrumMap(stored, true), original = resolveDrumMap(map, true);
      for (const id of ids) expect(meant.byId[id], `${map?.preset} ${id}`).toBe(original.byId[id]);
      if (stored) expect(drumMapProblem(stored)).toBeNull();
      if (map && map.preset !== 'mystery-kit') expect(stored).toEqual(cleanDrumMap(map));
    }
    expect(mapFromImport(exported({ preset: 'mystery-kit', keys: [[38, 41]] }))).toEqual({ preset: 'gm', keys: [[38, 41]] });
  });

  it('stores the base layout and only the rows that differ from it', () => {
    expect(mapFromImport({ name: 'x', base: 'test-kit', keys: [[91, 40], [42, null], [38, 41], [36, 35]] })).toEqual({ preset: 'test-kit', keys: [[38, 41]] });
    expect(mapFromImport({ name: 'x', base: null, keys: [[38, 41], [35, 35]] })).toEqual({ preset: 'gm', keys: [[38, 41]] });
    // A row the file leaves out is the base's own.
    expect(mapFromImport({ name: 'x', base: 'test-kit', keys: [] })).toEqual({ preset: 'test-kit' });
  });

  it('stores nothing for General MIDI as it is, so a map the track already has records nothing', () => {
    expect(mapFromImport(exported(undefined))).toBeUndefined();
    const mix: ChannelMix = { ...defaultMix(), drumMap: { preset: 'test-kit', keys: [[38, 41]] } };
    expect(withDrumMap(mix, mapFromImport(exported(mix.drumMap)))).toBe(mix);
    expect(withDrumMap(defaultMix(), mapFromImport(exported(undefined)))).toEqual(defaultMix());
    const plain = defaultMix();
    expect(withDrumMap(plain, mapFromImport(exported(undefined)))).toBe(plain);
  });

  it('reads every valid file of the shared cases into a map the mix accepts', () => {
    const valid = fixture.files.filter(entry => 'imported' in entry);
    expect(valid.length).toBeGreaterThanOrEqual(6);
    for (const entry of valid) {
      const imported = (entry as unknown as { imported: ImportedDrumMap }).imported;
      const stored = mapFromImport(imported);
      if (stored) expect(drumMapProblem(stored), entry.name).toBeNull();
    }
  });
});

describe('the words for a refusal', () => {
  it('has a message for every code the native side gives, and none for what it does not', () => {
    const codes = new Set(fixture.files.flatMap(entry => 'error' in entry ? [(entry as { error: string }).error] : []));
    expect(codes.size).toBeGreaterThanOrEqual(12);
    for (const code of codes) expect(fileProblem(code).key, code).not.toBe('drum_map.file_unknown');
    expect(fileProblem('newer_version').key).toBe('drum_map.file_newer');
    expect(fileProblem('unreadable: Access is denied.')).toEqual({ key: 'drum_map.file_unreadable', detail: 'Access is denied.' });
    expect(fileProblem(new Error('something else'))).toEqual({ key: 'drum_map.file_unknown', detail: 'something else' });
  });
});
