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
const presetRows = (id: string): PresetRows => (maps.presets as { id: string; rows?: PresetRows }[]).find(preset => preset.id === id)?.rows ?? [];
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
  const same = JSON.stringify(cleaned ?? null) === JSON.stringify(mix.drumMap ?? null);
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
export interface DrumMapPreset { id: string; name?: string; state?: 'verified' | 'unverified'; source?: string; checked?: string; rows?: PresetRows; candidates?: readonly (readonly [number, readonly number[]])[] }
/** The layouts this build knows, General MIDI first. */
export const drumMapPresets = (): readonly DrumMapPreset[] => maps.presets as unknown as readonly DrumMapPreset[];

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
