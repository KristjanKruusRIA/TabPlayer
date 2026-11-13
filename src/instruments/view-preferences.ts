import type { InstrumentFocus } from './focus';

/** The view modes of the instrument view. The mode itself is not kept: Auto follows the track. */
export type InstrumentMode = 'auto' | 'guitar' | 'bass' | 'drums' | 'keys' | 'both';
export type NoteNames = 'octave' | 'letter';
/** How the instrument view is set up for this user. Like the panel sizes and the view defaults these belong to the person, not to a score, so they never record an edit. */
export interface InstrumentViewPreferences {
  leftHanded: boolean; noteNames: NoteNames; neck: 'guitar' | 'bass' | null; expanded: boolean;
  focus: InstrumentFocus; clickToEdit: boolean;
}
export const instrumentViewDefaults: InstrumentViewPreferences = Object.freeze({ leftHanded: false, noteNames: 'octave', neck: null, expanded: false, focus: 'playing', clickToEdit: false });

const key = 'tabplayer.instrumentView';
/** Click to edit keeps its own key, as it always has. Handedness used to have one too; it is read until a new choice is stored. */
const legacyHandedness = 'tabplayer.instrument.leftHanded', editingKey = 'tabplayer.instrument.editNotes';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const browserStorage = (): PreferenceStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.includes(value as T) ? value as T : undefined;
const flag = (value: unknown) => typeof value === 'boolean' ? value : undefined;

/** Keeps each valid field; anything else reads as that option's default. */
export function readInstrumentViewPreferences(storage: PreferenceStorage | undefined = browserStorage()): InstrumentViewPreferences {
  // Each value is read on its own, so a damaged record never hides the older keys and an unreadable key never hides the record.
  const read = (name: string) => { try { return storage?.getItem(name) ?? null; } catch { return null; } };
  let stored: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(read(key) ?? 'null'); if (value && typeof value === 'object' && !Array.isArray(value)) stored = value as Record<string, unknown>; } catch { /* a damaged record reads as the defaults */ }
  const legacyLeft = read(legacyHandedness) === 'left' ? true : undefined, clickToEdit = read(editingKey) === 'on';
  const d = instrumentViewDefaults;
  return {
    leftHanded: flag(stored.leftHanded) ?? legacyLeft ?? d.leftHanded,
    noteNames: oneOf(stored.noteNames, ['octave', 'letter'] as const) ?? d.noteNames,
    neck: oneOf(stored.neck, ['guitar', 'bass'] as const) ?? d.neck,
    expanded: flag(stored.expanded) ?? d.expanded,
    focus: oneOf(stored.focus, ['playing', 'beat', 'bar', 'next'] as const) ?? d.focus,
    clickToEdit,
  };
}
/** Stores the changed options beside the ones already kept. Returns false when storage refuses the write; the choice still applies to the view that made it. */
export function writeInstrumentViewPreferences(change: Partial<InstrumentViewPreferences>, storage: PreferenceStorage | undefined = browserStorage()): boolean {
  try {
    if (!storage) return false;
    const { clickToEdit, ...record } = { ...readInstrumentViewPreferences(storage), ...change };
    storage.setItem(key, JSON.stringify(record));
    if (change.clickToEdit !== undefined) storage.setItem(editingKey, clickToEdit ? 'on' : 'off');
    return true;
  } catch { return false; }
}
