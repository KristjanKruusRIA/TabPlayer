import { invoke } from '@tauri-apps/api/core';
import type { DrumMapRef } from '../edit-types';
import type { MessageKey } from '../i18n';
import { cleanDrumMap, drumMapPresets } from './drum-map';

/** What the native side read from a drum map file, already checked: the file's name for the map, the layout it was made from (if it says), and the rows it lists. A row it leaves out is the layout's own. */
export interface ImportedDrumMap { name: string; base: string | null; keys: [number, number | null][] }

/** The two file commands. Each asks for the file with the system dialog; a cancelled dialog is `false` for an export and `null` for an import, never an error, and a refusal rejects with a code (`too_large`, `newer_version`, ...), optionally followed by `: detail`. */
export const drumMapFiles = {
  export: (map: DrumMapRef | undefined, name: string) => invoke<boolean>('drum_map_export', { map: map ?? null, name }),
  import: () => invoke<ImportedDrumMap | null>('drum_map_import'),
};

/**
 * The map to store for an imported file: its base layout when this build has it, General MIDI when it does not, and only the rows that
 * differ from that base, in the canonical form every other edit writes, so a file that says what the track already plays stores the same
 * map and records nothing.
 */
export function mapFromImport(imported: ImportedDrumMap): DrumMapRef | undefined {
  const known = imported.base !== null && drumMapPresets().some(preset => preset.id === imported.base);
  return cleanDrumMap({ preset: known ? imported.base! : 'gm', keys: imported.keys });
}

/** The name written into an exported file: the layout the map follows, which is also what the file is saved as by default. */
export const exportedName = (presetId: string, presetName: string | undefined): string => presetId === 'gm' ? 'General MIDI' : presetName ?? presetId;

const messages: Record<string, MessageKey> = {
  too_large: 'drum_map.file_too_large',
  not_text: 'drum_map.file_not_a_map',
  not_json: 'drum_map.file_not_a_map',
  bad_shape: 'drum_map.file_not_a_map',
  wrong_format: 'drum_map.file_not_a_map',
  newer_version: 'drum_map.file_newer',
  bad_version: 'drum_map.file_bad_version',
  bad_row: 'drum_map.file_bad_row',
  unknown_id: 'drum_map.file_unknown_sound',
  repeated_id: 'drum_map.file_repeated_sound',
  bad_key: 'drum_map.file_bad_key',
  bad_name: 'drum_map.file_bad_name',
  bad_base: 'drum_map.file_bad_base',
  unreadable: 'drum_map.file_unreadable',
};
/** The message and its detail for a rejection of a file command: a known code is its own sentence, anything else is shown as it was said. */
export function fileProblem(reason: unknown): { key: MessageKey; detail: string } {
  const text = reason instanceof Error ? reason.message : String(reason);
  const colon = text.indexOf(':');
  const code = (colon < 0 ? text : text.slice(0, colon)).trim();
  const detail = colon < 0 ? '' : text.slice(colon + 1).trim();
  const key = messages[code];
  return key ? { key, detail } : { key: 'drum_map.file_unknown', detail: text };
}
