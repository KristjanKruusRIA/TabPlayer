import { invoke } from '@tauri-apps/api/core';
import type { InstrumentFocus } from './focus';

/** The view modes of the instrument view. The mode itself is not kept, on purpose: it is a choice about one track (Drums on a guitar track, or Neck + keys on a drum staff, mean nothing), and Auto follows the track. */
export type InstrumentMode = 'auto' | 'guitar' | 'bass' | 'drums' | 'keys' | 'both';
export type NoteNames = 'octave' | 'letter';
/** How the instrument view is set up for this user. Like the panel sizes and the view defaults these belong to the person, not to a score, so they never record an edit. Every option but `clickToEdit` is also kept in the app's native settings; the browser store is the copy the first paint reads. */
export interface InstrumentViewPreferences {
  leftHanded: boolean; noteNames: NoteNames; neck: 'guitar' | 'bass' | null; expanded: boolean;
  focus: InstrumentFocus; clickToEdit: boolean;
}
/** The options kept natively: everything but click to edit. */
export type NativeInstrumentView = Omit<InstrumentViewPreferences, 'clickToEdit'>;
export const instrumentViewDefaults: InstrumentViewPreferences = Object.freeze({ leftHanded: false, noteNames: 'octave', neck: null, expanded: false, focus: 'playing', clickToEdit: false });

const key = 'tabplayer.instrumentView';
/** Click to edit keeps its own key, as it always has. Handedness used to have one too; it is read until a new choice is stored. */
const legacyHandedness = 'tabplayer.instrument.leftHanded', editingKey = 'tabplayer.instrument.editNotes';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
const browserStorage = (): PreferenceStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.includes(value as T) ? value as T : undefined;
const flag = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const optionNames = ['leftHanded', 'noteNames', 'neck', 'expanded', 'focus'] as const;

/** Keeps each valid field of an untrusted record; anything else reads as that option's default. */
function repairedOptions(stored: Record<string, unknown>, legacyLeft?: boolean): NativeInstrumentView {
  const d = instrumentViewDefaults;
  return {
    leftHanded: flag(stored.leftHanded) ?? legacyLeft ?? d.leftHanded,
    noteNames: oneOf(stored.noteNames, ['octave', 'letter'] as const) ?? d.noteNames,
    neck: oneOf(stored.neck, ['guitar', 'bass'] as const) ?? d.neck,
    expanded: flag(stored.expanded) ?? d.expanded,
    focus: oneOf(stored.focus, ['playing', 'beat', 'bar', 'next'] as const) ?? d.focus,
  };
}
const nativeOf = (preferences: InstrumentViewPreferences | NativeInstrumentView): NativeInstrumentView => ({ leftHanded: preferences.leftHanded, noteNames: preferences.noteNames, neck: preferences.neck, expanded: preferences.expanded, focus: preferences.focus });
const sameOptions = (a: NativeInstrumentView, b: NativeInstrumentView) => optionNames.every(name => a[name] === b[name]);
const sameDefaults = (value: NativeInstrumentView) => sameOptions(value, nativeOf(instrumentViewDefaults));

/** Keeps each valid field; anything else reads as that option's default. */
export function readInstrumentViewPreferences(storage: PreferenceStorage | undefined = browserStorage()): InstrumentViewPreferences {
  // Each value is read on its own, so a damaged record never hides the older keys and an unreadable key never hides the record.
  const read = (name: string) => { try { return storage?.getItem(name) ?? null; } catch { return null; } };
  let stored: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(read(key) ?? 'null'); if (value && typeof value === 'object' && !Array.isArray(value)) stored = value as Record<string, unknown>; } catch { /* a damaged record reads as the defaults */ }
  const legacyLeft = read(legacyHandedness) === 'left' ? true : undefined, clickToEdit = read(editingKey) === 'on';
  return { ...repairedOptions(stored, legacyLeft), clickToEdit };
}

/** The person's native settings, as the app's own commands expose them. `instrumentView` is null until one has been stored; `readOnly` marks a file of a newer build, which is never changed. */
export interface NativeSettingsBridge {
  read(): Promise<{ instrumentView: unknown; readOnly?: boolean }>;
  put(value: NativeInstrumentView): Promise<unknown>;
}
const defaultBridge = (): NativeSettingsBridge | null => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  ? { read: () => invoke('app_settings_read'), put: value => invoke('app_settings_put_instrument_view', { value }) } : null;
let bridge: NativeSettingsBridge | null | undefined;
const nativeBridge = () => bridge === undefined ? (bridge = defaultBridge()) : bridge;
/** For tests: replaces the native settings, or removes them with null. */
export function setNativeSettingsBridge(value: NativeSettingsBridge | null) { bridge = value; }

const listeners = new Set<() => void>();
/** Called when the native settings changed what the browser copy held, so views that are already open follow them. */
export function subscribeInstrumentViewPreferences(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** What the person has to be told: 'save' when a choice could not be saved natively (it still applies here and is tried again), 'newer' when the settings belong to a newer build and are left as they are. */
export type InstrumentSettingsProblem = 'save' | 'newer' | null;
let problem: InstrumentSettingsProblem = null;
const problemListeners = new Set<() => void>();
export const currentInstrumentSettingsProblem = (): InstrumentSettingsProblem => problem;
export function subscribeInstrumentSettingsProblem(listener: () => void): () => void { problemListeners.add(listener); return () => { problemListeners.delete(listener); }; }
function setProblem(value: InstrumentSettingsProblem) {
  if (problem === value || (problem === 'newer' && value === 'save')) return;
  problem = value; for (const listener of [...problemListeners]) try { listener(); } catch { /* a failing view must not stop the others */ }
}

/** Set in the browser copy while a choice has not reached the native settings, so the next start sends it instead of reading an older native record over it. */
const unsentKey = 'tabplayer.instrumentView.unsent';
/** 'all': a whole record failed to reach the native settings, so the browser copy wins. A set of option names: only those choices were made while the native settings could not be read, so only they are laid over the native record. */
type Unsent = 'all' | Set<keyof NativeInstrumentView>;
let unsentInMemory: Unsent | null = null;
const readUnsent = (storage: PreferenceStorage | undefined): Unsent | null => {
  let stored: Unsent | null = null;
  try { const raw = storage?.getItem(unsentKey); if (raw) stored = raw === 'all' || raw === '1' ? 'all' : new Set(raw.split(',').filter((name): name is keyof NativeInstrumentView => (optionNames as readonly string[]).includes(name))); } catch { /* only the in-memory mark counts then */ }
  return mergeUnsent(stored, unsentInMemory);
};
function mergeUnsent(a: Unsent | null, b: Unsent | null): Unsent | null {
  if (a === 'all' || b === 'all') return 'all';
  if (!a || !b) return a ?? b;
  return new Set([...a, ...b]);
}
function markUnsent(storage: PreferenceStorage | undefined, what: Unsent) {
  const all = mergeUnsent(readUnsent(storage), what); unsentInMemory = all;
  try { storage?.setItem(unsentKey, all === 'all' ? 'all' : [...(all ?? [])].join(',')); } catch { /* the in-memory mark still holds for this run */ }
}
function clearUnsent(storage: PreferenceStorage | undefined) { unsentInMemory = null; try { if (storage?.removeItem) storage.removeItem(unsentKey); else storage?.setItem(unsentKey, ''); } catch { /* an old mark only makes the next start send the browser copy again */ } }

// Until the native settings have been read, a choice goes to the browser copy and is remembered in `touched`; reading
// then merges it over what the native side holds, so a stale browser copy never overwrites a native choice.
// Afterwards `current` is the whole record in memory, so saving never depends on the browser store.
let loaded = false, readFailed = false, nativeReadOnly = false, loading: Promise<void> | null = null, pending = 0;
let touched: Partial<NativeInstrumentView> = {}, current: NativeInstrumentView | null = null, nativeWrites: Promise<unknown> = Promise.resolve();
export function resetInstrumentViewPreferencesSync() { loaded = false; readFailed = false; nativeReadOnly = false; loading = null; pending = 0; touched = {}; current = null; nativeWrites = Promise.resolve(); unsentInMemory = null; problem = null; }
function sendNative(value: NativeInstrumentView, storage: PreferenceStorage | undefined) {
  const target = nativeBridge(); if (!target) return;
  pending++;
  // Writes keep their order. A failed one is remembered (the marker) and shown once, and the choice still applies in the view that made it.
  nativeWrites = nativeWrites.then(() => target.put(value)).then(() => { if (--pending === 0) { clearUnsent(storage); if (problem === 'save') setProblem(null); } }, error => {
    pending--;
    if (String((error as { message?: string })?.message ?? error).includes('settings-newer-version')) { nativeReadOnly = true; setProblem('newer'); return; }
    markUnsent(storage, 'all'); setProblem('save');
  });
}

/** Stores the changed options beside the ones already kept. Returns false when storage refuses the write; the choice still applies to the view that made it. Choosing the value already kept writes nothing. */
export function writeInstrumentViewPreferences(change: Partial<InstrumentViewPreferences>, storage: PreferenceStorage | undefined = browserStorage()): boolean {
  try {
    const stored = readInstrumentViewPreferences(storage), before = { ...stored, ...current }, next = { ...before, ...change };
    const changedNames = optionNames.filter(name => next[name] !== before[name]);
    if (!changedNames.length && next.clickToEdit === before.clickToEdit) return true;
    const changes: Partial<NativeInstrumentView> = {}; for (const name of changedNames) (changes as Record<string, unknown>)[name] = next[name];
    if (current) current = { ...current, ...changes }; else touched = { ...touched, ...changes };
    let kept = !!storage;
    if (storage) try {
      const { clickToEdit, ...record } = next;
      storage.setItem(key, JSON.stringify(record));
      if (change.clickToEdit !== undefined) storage.setItem(editingKey, clickToEdit ? 'on' : 'off');
    } catch { kept = false; }
    if (changedNames.length && nativeBridge()) {
      if (nativeReadOnly) setProblem('newer');
      else if (loaded && current) sendNative(current, storage);
      else if (readFailed) { markUnsent(storage, new Set(changedNames)); void syncInstrumentViewPreferencesFromNative(storage); }
    }
    return kept;
  } catch { return false; }
}

/**
 * Reads the native settings once and makes them the options. A native record wins, apart from anything chosen
 * before it arrived and apart from a choice an earlier run could not save (marked unsent), which is sent instead.
 * With no native record yet, the browser record (or the older handedness key) is repaired and sent natively once,
 * and written back repaired; at a first start with nothing chosen nothing is written. When the native settings cannot
 * be read nothing is sent and the person is told; the next choice tries again, so they are never overwritten by a
 * browser copy that may be stale. A file of a newer build is never written.
 */
export function syncInstrumentViewPreferencesFromNative(storage: PreferenceStorage | undefined = browserStorage()): Promise<void> {
  loading ??= (async () => {
    const target = nativeBridge(); if (!target) return;
    let stored: { instrumentView: unknown; readOnly?: boolean };
    try { stored = await target.read(); } catch {
      readFailed = true; loading = null; if (Object.keys(touched).length) markUnsent(storage, new Set(Object.keys(touched) as (keyof NativeInstrumentView)[])); setProblem('save'); return;
    }
    readFailed = false;
    const local = readInstrumentViewPreferences(storage), native = stored?.instrumentView, hadTouched = Object.keys(touched).length > 0;
    if (stored?.readOnly === true) { nativeReadOnly = true; current = { ...nativeOf(local), ...touched }; if (hadTouched) setProblem('newer'); return; }
    const fromNative = native && typeof native === 'object' && !Array.isArray(native) ? repairedOptions(native as Record<string, unknown>) : null;
    const unsent = readUnsent(storage);
    const merged: NativeInstrumentView = { ...(unsent === 'all' || !fromNative ? nativeOf(local) : fromNative), ...touched };
    if (unsent instanceof Set && fromNative) for (const name of unsent) (merged as Record<string, unknown>)[name] = local[name];
    if (unsent instanceof Set && fromNative) Object.assign(merged, touched);
    current = merged; touched = {}; loaded = true;
    const send = unsent !== null || (fromNative ? !sameOptions(merged, fromNative) : hadTouched || !sameDefaults(merged));
    if (send) sendNative(merged, storage); else if (problem === 'save') setProblem(null);
    const differs = !sameOptions(merged, nativeOf(local));
    if (differs || (!fromNative && !sameDefaults(merged))) { try { storage?.setItem(key, JSON.stringify(merged)); } catch { /* the native settings still hold it */ } }
    if (differs) for (const listener of [...listeners]) try { listener(); } catch { /* a failing view must not stop the others */ }
  })();
  return loading;
}
