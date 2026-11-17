import { invoke } from '@tauri-apps/api/core';

/**
 * The preferences that belong to the person and not to a score, kept in the app's native settings file beside the
 * instrument view options (see `instruments/view-preferences.ts`, which this follows): the browser copy serves the
 * first paint and is the one-time migration source; once the native settings were read, a native record wins and the
 * browser copy is refilled from it, so the choices survive a reset of the browser profile.
 *
 * Each group (score errors, new score details, default view) registers how to read and write its own browser copy.
 * A group is saved as a whole, so a choice made before the native read arrives replaces that group's native record.
 */
export type PreferenceGroupName = 'scoreErrors' | 'newScore' | 'viewDefaults';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
const browserStorage = (): PreferenceStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

export interface PreferenceGroup<T> {
  name: PreferenceGroupName;
  /** Keeps each valid field of an untrusted record; null when it is not a record at all. */
  repair(value: unknown): T | null;
  /** What the browser copy holds, repaired; null when nothing was ever chosen. */
  browser(storage?: PreferenceStorage): T | null;
  /** Writes the browser copy only. */
  keep(value: T, storage?: PreferenceStorage): void;
  same(a: T, b: T): boolean;
}
const groups = new Map<PreferenceGroupName, PreferenceGroup<unknown>>();
export function registerPreferenceGroup<T>(group: PreferenceGroup<T>) { groups.set(group.name, group as PreferenceGroup<unknown>); }

/** The native settings, as the app's own commands expose them. A group is absent or null until one has been stored; `readOnly` marks a file of a newer build, which is never changed. */
export interface NativePreferenceBridge {
  read(): Promise<{ readOnly?: boolean } & Partial<Record<PreferenceGroupName, unknown>>>;
  put(group: PreferenceGroupName, value: unknown): Promise<unknown>;
}
const commands: Record<PreferenceGroupName, string> = { scoreErrors: 'app_settings_put_score_errors', newScore: 'app_settings_put_new_score', viewDefaults: 'app_settings_put_view_defaults' };
const defaultBridge = (): NativePreferenceBridge | null => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  ? { read: () => invoke('app_settings_read'), put: (group, value) => invoke(commands[group], { value }) } : null;
let bridge: NativePreferenceBridge | null | undefined;
const nativeBridge = () => bridge === undefined ? (bridge = defaultBridge()) : bridge;
/** For tests: replaces the native settings, or removes them with null. */
export function setNativePreferenceBridge(value: NativePreferenceBridge | null) { bridge = value; }

const listeners = new Set<(name: PreferenceGroupName) => void>();
/** Called when the native settings changed what the browser copy held, so whoever shows a preference can follow. */
export function subscribeNativePreferences(listener: (name: PreferenceGroupName) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** 'save': a choice could not be saved natively (it applies and is tried again). 'newer': the settings belong to a newer build and are left as they are. */
export type PreferenceSettingsProblem = 'save' | 'newer' | null;
let problem: PreferenceSettingsProblem = null;
const problemListeners = new Set<() => void>();
export const currentPreferenceSettingsProblem = (): PreferenceSettingsProblem => problem;
export function subscribePreferenceSettingsProblem(listener: () => void): () => void { problemListeners.add(listener); return () => { problemListeners.delete(listener); }; }
function setProblem(value: PreferenceSettingsProblem) {
  if (problem === value || (problem === 'newer' && value === 'save')) return;
  problem = value; for (const listener of [...problemListeners]) try { listener(); } catch { /* a failing view must not stop the others */ }
}

/** Set in the browser copy while a group has not reached the native settings, so the next start sends it instead of reading an older native record over it. */
const unsentKey = 'tabplayer.nativePreferences.unsent';
const unsentInMemory = new Set<PreferenceGroupName>(), failed = new Set<PreferenceGroupName>();
const readUnsent = (storage: PreferenceStorage | undefined): Set<PreferenceGroupName> => {
  const all = new Set(unsentInMemory);
  try { for (const name of (storage?.getItem(unsentKey) ?? '').split(',')) if (groups.has(name as PreferenceGroupName)) all.add(name as PreferenceGroupName); } catch { /* only the in-memory marks count then */ }
  return all;
};
const writeUnsent = (storage: PreferenceStorage | undefined, all: Set<PreferenceGroupName>) => {
  try { if (!all.size && storage?.removeItem) storage.removeItem(unsentKey); else storage?.setItem(unsentKey, [...all].join(',')); } catch { /* the in-memory mark still holds for this run */ }
};
function markUnsent(storage: PreferenceStorage | undefined, name: PreferenceGroupName) { unsentInMemory.add(name); writeUnsent(storage, readUnsent(storage)); }
function clearUnsent(storage: PreferenceStorage | undefined, name: PreferenceGroupName) { unsentInMemory.delete(name); const all = readUnsent(storage); all.delete(name); writeUnsent(storage, all); }

// Until the native settings have been read, a choice goes to the browser copy and is remembered in `touched`; reading
// then lets it win over what the native side holds, so a stale browser copy never overwrites a native choice.
// Afterwards `current` is the group in memory, so saving never depends on the browser store.
let loaded = false, readFailed = false, nativeReadOnly = false, loading: Promise<void> | null = null;
const touched = new Map<PreferenceGroupName, unknown>(), current = new Map<PreferenceGroupName, unknown>();
let nativeWrites: Promise<unknown> = Promise.resolve();
const pending = new Map<PreferenceGroupName, number>();
export function resetNativePreferencesSync() {
  loaded = false; readFailed = false; nativeReadOnly = false; loading = null; touched.clear(); current.clear(); pending.clear(); failed.clear(); unsentInMemory.clear(); nativeWrites = Promise.resolve(); problem = null;
}

function sendNative(name: PreferenceGroupName, value: unknown, storage: PreferenceStorage | undefined) {
  const target = nativeBridge(); if (!target) return;
  pending.set(name, (pending.get(name) ?? 0) + 1);
  // Writes keep their order. A failed one is remembered (the marker) and announced once; the choice still applies.
  nativeWrites = nativeWrites.then(() => target.put(name, value)).then(() => {
    const left = (pending.get(name) ?? 1) - 1; pending.set(name, left);
    if (left === 0) { clearUnsent(storage, name); failed.delete(name); if (problem === 'save' && !failed.size) setProblem(null); }
  }, error => {
    pending.set(name, (pending.get(name) ?? 1) - 1);
    if (String((error as { message?: string })?.message ?? error).includes('settings-newer-version')) { nativeReadOnly = true; setProblem('newer'); return; }
    failed.add(name); markUnsent(storage, name); setProblem('save');
  });
}

/**
 * Called by a group after it kept a choice in the browser copy. Choosing what was already kept natively sends
 * nothing. Before the native read the choice is remembered and merged by the read; if that read failed it is marked
 * unsent and the read is tried again.
 */
export function preferenceSaved<T>(name: PreferenceGroupName, value: T, storage: PreferenceStorage | undefined = browserStorage()) {
  const group = groups.get(name); if (!group || !nativeBridge()) return;
  if (loaded) {
    const before = current.get(name);
    if (before !== undefined && group.same(before, value)) return;
    current.set(name, value);
    if (nativeReadOnly) setProblem('newer'); else sendNative(name, value, storage);
    return;
  }
  touched.set(name, value);
  if (readFailed) { markUnsent(storage, name); void syncNativePreferences(storage); }
}

/**
 * Reads the native settings once and makes them the preferences. A native record wins, apart from a group chosen
 * before it arrived and apart from a choice an earlier run could not save (marked unsent), which is sent instead.
 * A group with no native record yet is migrated from the browser copy, sent once. Nothing is written for a group
 * nobody ever chose. When the native settings cannot be read nothing is sent and the person is told; the next choice
 * tries again, so a browser copy that may be stale never overwrites them. A file of a newer build is never written.
 */
export function syncNativePreferences(storage: PreferenceStorage | undefined = browserStorage()): Promise<void> {
  loading ??= (async () => {
    const target = nativeBridge(); if (!target) return;
    let stored: Awaited<ReturnType<NativePreferenceBridge['read']>>;
    try { stored = await target.read(); } catch {
      readFailed = true; loading = null; for (const name of touched.keys()) markUnsent(storage, name); setProblem('save'); return;
    }
    readFailed = false;
    if (stored?.readOnly === true) {
      nativeReadOnly = true; loaded = true;
      for (const [name, group] of groups) { const own = touched.get(name) ?? group.browser(storage); if (own !== null && own !== undefined) current.set(name, own); }
      if (touched.size) setProblem('newer');
      touched.clear(); return;
    }
    loaded = true;
    const unsent = readUnsent(storage), changed: PreferenceGroupName[] = [];
    for (const [name, group] of groups) {
      const raw = (stored as Record<string, unknown> | undefined)?.[name];
      const fromNative = raw && typeof raw === 'object' && !Array.isArray(raw) ? group.repair(raw) : null;
      const local = group.browser(storage), mine = touched.get(name);
      const merged = mine ?? (unsent.has(name) && local !== null ? local : fromNative ?? local);
      if (merged === null || merged === undefined) continue;
      current.set(name, merged);
      if (!fromNative || !group.same(merged, fromNative)) sendNative(name, merged, storage); else clearUnsent(storage, name);
      if (fromNative && (local === null || !group.same(merged, local))) { try { group.keep(merged, storage); } catch { /* the native settings still hold it */ } changed.push(name); }
    }
    touched.clear();
    if (problem === 'save' && !failed.size && ![...pending.values()].some(count => count > 0)) setProblem(null);
    for (const name of changed) for (const listener of [...listeners]) try { listener(name); } catch { /* a failing view must not stop the others */ }
  })();
  return loading;
}
