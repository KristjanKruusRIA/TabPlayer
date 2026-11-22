import type { model } from '@coderline/alphatab';
import type { ChannelMix, DrumMapRef } from '../edit-types';
import { resolvePercussionArticulation, standardPercussionCatalog } from '../editor/percussion-catalog';
import maps from './drum-maps.json';
import { standardArticulationId } from './kit-sound';

const standardIds = new Set(maps.sounds.map(([id]) => id));

/** Whether `id` is a standard articulation. */
export const isStandardArticulation = (id: number): boolean => standardIds.has(id);

/** What a key resolves to when its articulation has no sound. */
export const SILENT = 255;
const PRESET_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The most rows a drum map may change: one for each standard articulation. */
export const MAX_DRUM_MAP_ROWS = 94;

/**
 * Why `map` is not a drum map, or null when it is one. It never depends on which presets exist or what one holds: a preset this
 * build does not know plays as General MIDI plus the changed rows, and a row equal to its preset's own value is harmless. The rules
 * are those of `DrumMapRef::validate` in `src-tauri/src/settings.rs`; `tests/drum-map-protocol.json` holds the two together.
 * `keys` is absent or non-empty (the writer leaves an empty list out), on read as on write.
 */
export function drumMapProblem(map: unknown): string | null {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'A drum map must be an object.';
  const entries = Object.keys(map);
  if (entries.some(key => key !== 'preset' && key !== 'keys')) return 'A drum map holds only a preset and keys.';
  const { preset, keys } = map as { preset?: unknown; keys?: unknown };
  if (typeof preset !== 'string' || preset.length < 1 || preset.length > 40 || !PRESET_PATTERN.test(preset)) return 'A drum map preset id must be 1-40 lower-case letters, digits and single hyphens.';
  if (!Object.hasOwn(map, 'keys')) return preset === 'gm' ? 'General MIDI with no changed rows is written as no drum map.' : null;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_DRUM_MAP_ROWS) return 'A drum map changes 1-94 rows when it names any.';
  let previous = -1;
  for (const row of keys as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2) return 'A drum map row is an articulation id and a key.';
    const [id, key] = row as unknown[];
    if (typeof id !== 'number' || !isStandardArticulation(id) || id <= previous) return 'Drum map rows must be standard articulations in ascending order.';
    if (key !== null && (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > 127)) return 'A drum map key must be 0-127 or none.';
    previous = id;
  }
  return null;
}
export function validateDrumMap(map: unknown): asserts map is DrumMapRef {
  const problem = drumMapProblem(map);
  if (problem) throw new Error(problem);
}

/** The tables of a drum map, as the native side resolves them: the key of an articulation by its id, and of a plain hit by its key. */
export interface ResolvedDrumMap { byId: Uint8Array; byKey: Uint8Array }
type PresetRows = readonly (readonly [number, number | null])[];

/** Why a presets-file entry is malformed, or null. The rules are those of `parse_preset` in `src-tauri/src/audio/drum_map.rs`: the id is a string, `revision` is absent or a non-negative integer, `rows` is absent or a list, and each row is `[id 0-255, key 0-127 or null]` of integers. */
function presetProblem(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'a preset is not an object';
  const { id, rows, revision } = entry as { id?: unknown; rows?: unknown; revision?: unknown };
  if (typeof id !== 'string') return 'a preset has no id';
  if (Object.hasOwn(entry, 'revision') && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > 4294967295)) return `preset "${id}": revision is not a whole number`;
  if (!Object.hasOwn(entry, 'rows')) return null;
  if (!Array.isArray(rows)) return `preset "${id}": rows is not a list`;
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2) return `preset "${id}": a row is not an id and a key`;
    const [rowId, key] = row as unknown[];
    if (typeof rowId !== 'number' || !Number.isInteger(rowId) || rowId < 0 || rowId > 255) return `preset "${id}": a row id is not 0 to 255`;
    if (key !== null && (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > 127)) return `preset "${id}": a row key is not 0 to 127 or none`;
  }
  return null;
}
/**
 * The presets of a presets file and what was wrong with the ones left out: a malformed preset is dropped as a whole and reported, and
 * the others survive, as on the native side. A file with no `presets` list is an error.
 */
export function readPresets(file: unknown): { presets: DrumMapPreset[]; problems: string[] } {
  const list = (file as { presets?: unknown } | null)?.presets;
  if (!Array.isArray(list)) throw new Error('no presets');
  const presets: DrumMapPreset[] = [], problems: string[] = [];
  for (const entry of list as unknown[]) {
    const problem = presetProblem(entry);
    if (problem) problems.push(problem); else presets.push(entry as DrumMapPreset);
  }
  return { presets, problems };
}
const loaded = readPresets(maps);
for (const problem of loaded.problems) console.warn(`TabPlayer: a drum map preset is left out: ${problem}`);
const presetRows = (id: string): PresetRows => loaded.presets.find(preset => preset.id === id)?.rows ?? [];
const outputKeys = new Set(maps.sounds.map(([, key]) => key));
function apply(tables: ResolvedDrumMap, rows: PresetRows) {
  for (const [id, key] of rows) {
    if (id < 0 || id > 127) continue;
    const value = key !== null && key >= 0 && key < 128 ? key : SILENT;
    tables.byId[id] = value;
    // Only a key that is itself an articulation and a General MIDI output moves its plain hits with it.
    if (standardIds.has(id) && outputKeys.has(id)) tables.byKey[id] = value;
  }
}
/** General MIDI: every articulation its own key, every other key itself. An id that is no articulation reads as its number. */
export function identityDrumMap(): ResolvedDrumMap {
  const byId = Uint8Array.from({ length: 128 }, (_, index) => index), byKey = Uint8Array.from(byId);
  for (const [id, key] of maps.sounds) byId[id] = key;
  for (let key = 0; key < 128; key++) if (standardIds.has(key) && outputKeys.has(key)) byKey[key] = byId[key];
  return { byId, byKey };
}
/** The tables for a track. Only a percussion track has a map; an unknown preset is General MIDI, and the changed rows apply on top. */
export function resolveDrumMap(map: DrumMapRef | undefined | null, percussion: boolean): ResolvedDrumMap {
  const tables = identityDrumMap();
  if (!map || !percussion) return tables;
  apply(tables, presetRows(map.preset));
  apply(tables, map.keys ?? []);
  return tables;
}
/** The key a note plays (null: no sound). An articulation the plan names is read by its id, a plain hit by its key. */
export function mappedKey(tables: ResolvedDrumMap, key: number, id?: number | null): number | null {
  const value = id === undefined || id === null ? tables.byKey[key & 127] : tables.byId[id & 127];
  return value < 128 ? value : null;
}

/** The map to store for a chosen one: rows equal to the preset's own value dropped, rows ascending, and General MIDI with no changed rows no map at all. */
export function cleanDrumMap(map: DrumMapRef | undefined | null): DrumMapRef | undefined {
  if (!map) return undefined;
  const base = resolveDrumMap({ preset: map.preset }, true);
  const kept = new Map<number, number | null>();
  for (const [id, key] of map.keys ?? []) kept.set(id, key);
  const rows = [...kept].filter(([id, key]) => (key === null ? SILENT : key) !== base.byId[id & 127]).sort((a, b) => a[0] - b[0]);
  if (!rows.length) return map.preset === 'gm' ? undefined : { preset: map.preset };
  return { preset: map.preset, keys: rows.map(([id, key]) => [id, key]) };
}
/** A mix with the drum map chosen, or without any: choosing what is already stored changes nothing, so it returns the same mix. */
export function withDrumMap(mix: ChannelMix, map: DrumMapRef | undefined | null): ChannelMix {
  const cleaned = cleanDrumMap(map), { drumMap: _stored, ...rest } = mix;
  void _stored;
  // Compared by what each means, not by how it is written: a stored map that is not canonical equals its canonical form.
  const same = JSON.stringify(cleaned ?? null) === JSON.stringify(cleanDrumMap(mix.drumMap) ?? null);
  return same ? mix : cleaned ? { ...rest, drumMap: cleaned } : rest;
}

/**
 * A track's own articulation that carries the id of a standard one under its own table entry: alphaTab's Guitar Pro 7 importer
 * reads an articulation's `id` from the first of its InputMidiNumbers, and the standard set's ids are those numbers. It counts only
 * where the piece and the sound agree with the catalogue, so a custom articulation that merely reuses a number does not.
 */
function gpIdMatch(track: model.Track, id: number): number | undefined {
  if (id >= track.percussionArticulations.length) return undefined;
  const articulation = resolvePercussionArticulation(track, id);
  if (!articulation) return undefined;
  return standardPercussionCatalog.some(entry => entry.id === articulation.id && entry.element === articulation.elementType && entry.outputMidiNumber === articulation.outputMidiNumber) ? articulation.id : undefined;
}

/** The standard articulation a drum note's articulation is: the id the file gave its table entry when that is a standard one of the same piece and sound (a China and its choke have one shape, so only the id tells them apart), else by its shape in the table. */
export function mapArticulationId(track: model.Track, id: number): number | undefined {
  return gpIdMatch(track, id) ?? standardArticulationId(track, id);
}

/** One layout a drum map can start from, as `drum-maps.json` describes it. Only `id` is required: `state` says whether the layout was checked against the instrument it belongs to, `candidates` lists keys worth trying for a row, `[articulation id, [key, ...]]`. */
export interface DrumMapPreset { id: string; /** Counts changes to the preset's data, so a later edit of its rows is visible; resolution ignores it. */ revision?: number; name?: string; state?: 'verified' | 'unverified'; source?: string; /** When and against what a layout was checked: a date, or `{ date, against }`; a verified layout of this build has the object. */ checked?: string | { date: string; against: string }; rows?: PresetRows; candidates?: readonly (readonly [number, readonly number[]])[] }
/** The layouts this build knows, General MIDI first. */
export const drumMapPresets = (): readonly DrumMapPreset[] => loaded.presets;

/**
 * The standard articulations a track's notes play, ascending: a note's own articulation by the standard one it is, and a plain hit
 * (whose articulation the track's table does not match) by the standard articulation numbered as the key it sounds.
 */
export function usedDrumSounds(track: model.Track): number[] {
  const used = new Set<number>();
  for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
    if (!note.isPercussion) continue;
    const id = mapArticulationId(track, note.percussionArticulation);
    if (id !== undefined) { used.add(id); continue; }
    const key = resolvePercussionArticulation(track, note.percussionArticulation)?.outputMidiNumber;
    if (key !== undefined && standardIds.has(key)) used.add(key);
  }
  return [...used].sort((a, b) => a - b);
}

const KIT_HITS = [36, 38, 42, 46, 44, 49, 57, 51, 53, 52, 55, 48, 45, 47, 43, 41, 50, 35, 37] as const;
const KIT_TECHNIQUES = [91, 92, 93, 97, 98, 96, 95, 94] as const;
const KIT_SECONDARY = [59, 126, 127, 29, 31, 30] as const;
const GM_PRIMARY = new Set(maps.sounds.filter(([id, key]) => id === key).map(([id]) => id));
const KIT_HIT_INDEX = new Map<number, number>(KIT_HITS.map((id, index) => [id, index]));
const KIT_TECHNIQUE_INDEX = new Map<number, number>(KIT_TECHNIQUES.map((id, index) => [id, index]));
const KIT_SECONDARY_INDEX = new Map<number, number>(KIT_SECONDARY.map((id, index) => [id, index]));

/**
 * Resolves a reverse drum map for incoming MIDI keys 0..127 -> standard articulation id (or null to skip),
 * inverting the selected drum map layout, falling back to preset candidate keys for unused MIDI keys,
 * and applying explicit per-key overrides last.
 */
export function resolveInputDrumMap(
  map: DrumMapRef | undefined | null,
  overrides?: Readonly<Record<number, number | null>>,
): readonly (number | null)[] {
  const customIds = new Set((map?.keys ?? []).map(([id]) => id));
  const isGmBase = !map || map.preset === 'gm';
  const rank = (id: number, key: number): number => {
    if (isGmBase && !customIds.has(id) && id === key && GM_PRIMARY.has(id)) return 0;
    const hitIndex = KIT_HIT_INDEX.get(id);
    if (hitIndex !== undefined) return 10 + hitIndex;
    const techniqueIndex = KIT_TECHNIQUE_INDEX.get(id);
    if (techniqueIndex !== undefined) return 100 + techniqueIndex;
    const secondaryIndex = KIT_SECONDARY_INDEX.get(id);
    if (secondaryIndex !== undefined) return 200 + secondaryIndex;
    if (GM_PRIMARY.has(id)) return 300 + id;
    return 500 + id;
  };
  const compete = (best: (number | null)[], ranks: number[], id: number, key: number) => {
    if (key < 0 || key > 127 || !Number.isInteger(key)) return;
    const nextRank = rank(id, key);
    if (nextRank < ranks[key]) {
      ranks[key] = nextRank;
      best[key] = id;
    }
  };

  const tables = resolveDrumMap(map, true);
  const primary: (number | null)[] = Array.from({ length: 128 }, () => null);
  const primaryRanks = Array.from({ length: 128 }, () => Infinity);
  for (const [id] of maps.sounds) {
    const key = tables.byId[id];
    if (key < 128) compete(primary, primaryRanks, id, key);
  }

  const fallback: (number | null)[] = Array.from({ length: 128 }, () => null);
  if (map && map.preset !== 'gm') {
    const preset = loaded.presets.find(entry => entry.id === map.preset);
    if (preset?.candidates) {
      const silenced = new Set((map.keys ?? []).filter(([, key]) => key === null).map(([id]) => id));
      const fallbackRanks = Array.from({ length: 128 }, () => Infinity);
      for (const [id, candidateKeys] of preset.candidates) {
        if (!isStandardArticulation(id) || silenced.has(id)) continue;
        for (const candidateKey of candidateKeys) {
          if (candidateKey >= 0 && candidateKey < 128 && primary[candidateKey] === null) {
            compete(fallback, fallbackRanks, id, candidateKey);
          }
        }
      }
    }
  }

  const result: (number | null)[] = Array.from({ length: 128 }, (_, key) => primary[key] ?? fallback[key] ?? null);
  if (overrides) {
    for (const [keyStr, articulation] of Object.entries(overrides)) {
      if (!/^\d{1,3}$/.test(keyStr)) continue;
      const key = Number(keyStr);
      if (key < 0 || key > 127) continue;
      if (articulation === null) result[key] = null;
      else if (typeof articulation === 'number' && isStandardArticulation(articulation)) result[key] = articulation;
    }
  }
  return result;
}
