// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { instrumentViewDefaults, readInstrumentViewPreferences, resetInstrumentViewPreferencesSync, setNativeSettingsBridge, subscribeInstrumentViewPreferences, syncInstrumentViewPreferencesFromNative, writeInstrumentViewPreferences, type NativeInstrumentView, type NativeSettingsBridge } from './view-preferences';

const key = 'tabplayer.instrumentView', flush = () => new Promise(resolve => setTimeout(resolve, 0));
const memory = (initial: Record<string, string> = {}) => { const data = new Map(Object.entries(initial)); return { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => { data.set(name, value); }, removeItem: (name: string) => { data.delete(name); }, data }; };
const { clickToEdit: _omitted, ...persisted } = { ...instrumentViewDefaults };
const bridgeWith = (stored: unknown) => { const put = vi.fn(async (_value: NativeInstrumentView) => ({})); const read = vi.fn(async () => ({ instrumentView: stored })); return { bridge: { read, put } as unknown as NativeSettingsBridge, put, read }; };

beforeEach(() => resetInstrumentViewPreferencesSync());
afterEach(() => { setNativeSettingsBridge(null); resetInstrumentViewPreferencesSync(); });

it('restores the options from the native settings after the browser profile was reset, and tells the open views', async () => {
  const storage = memory(), { bridge, put } = bridgeWith({ ...persisted, leftHanded: true, noteNames: 'letter', neck: 'bass', expanded: true, focus: 'bar' });
  setNativeSettingsBridge(bridge); const heard = vi.fn(); const stop = subscribeInstrumentViewPreferences(heard);
  expect(readInstrumentViewPreferences(storage).leftHanded).toBe(false);
  await syncInstrumentViewPreferencesFromNative(storage);
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, noteNames: 'letter', neck: 'bass', expanded: true, focus: 'bar' });
  expect(heard).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); stop();
});

it('keeps a choice made before the native settings arrived, and sends the merged record once', async () => {
  const storage = memory(), { bridge, put } = bridgeWith({ ...persisted, noteNames: 'letter', focus: 'next' });
  setNativeSettingsBridge(bridge);
  expect(writeInstrumentViewPreferences({ leftHanded: true }, storage)).toBe(true);
  expect(put).not.toHaveBeenCalled();
  await syncInstrumentViewPreferencesFromNative(storage);
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, noteNames: 'letter', focus: 'next' });
  await flush(); expect(put).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledWith({ ...persisted, leftHanded: true, noteNames: 'letter', focus: 'next' });
});

it('moves an existing browser record to the native settings once, repairing a damaged one', async () => {
  const storage = memory({ [key]: JSON.stringify({ leftHanded: true, noteNames: 'solfege', neck: 'bass', expanded: 'yes', focus: 'bar', __proto__: { polluted: true } }), 'tabplayer.instrument.editNotes': 'on' });
  const { bridge, put } = bridgeWith(null); setNativeSettingsBridge(bridge);
  await syncInstrumentViewPreferencesFromNative(storage); await flush();
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith({ ...persisted, leftHanded: true, neck: 'bass', focus: 'bar' });
  expect(JSON.parse(storage.data.get(key)!)).toEqual({ ...persisted, leftHanded: true, neck: 'bass', focus: 'bar' });
  await syncInstrumentViewPreferencesFromNative(storage); expect(put).toHaveBeenCalledTimes(1);
  expect(readInstrumentViewPreferences(storage).clickToEdit).toBe(true);
});

it('migrates the older handedness key too, and a hostile record gives the defaults and writes nothing natively', async () => {
  const old = memory({ 'tabplayer.instrument.leftHanded': 'left' }), a = bridgeWith(null); setNativeSettingsBridge(a.bridge);
  await syncInstrumentViewPreferencesFromNative(old); await flush();
  expect(a.put).toHaveBeenCalledWith({ ...persisted, leftHanded: true });
  resetInstrumentViewPreferencesSync();
  const hostile = memory({ [key]: '[1,2,{"leftHanded":true}]' }), b = bridgeWith(null); setNativeSettingsBridge(b.bridge);
  await syncInstrumentViewPreferencesFromNative(hostile); await flush();
  expect(b.put).not.toHaveBeenCalled();
});

it('treats whatever the native side returns as untrusted', async () => {
  const storage = memory(), { bridge } = bridgeWith({ leftHanded: 'yes', noteNames: 7, neck: 'oud', expanded: true, focus: 'bar', extra: 1 });
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  expect(readInstrumentViewPreferences(storage)).toEqual({ ...instrumentViewDefaults, expanded: true, focus: 'bar' });
});

it('writes natively only a real change, once the settings are loaded, and not at all for the current value', async () => {
  const storage = memory(), { bridge, put } = bridgeWith({ ...persisted }); setNativeSettingsBridge(bridge);
  await syncInstrumentViewPreferencesFromNative(storage);
  writeInstrumentViewPreferences({ leftHanded: false }, storage); expect(put).not.toHaveBeenCalled();
  writeInstrumentViewPreferences({ leftHanded: true }, storage); await flush(); expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenLastCalledWith({ ...persisted, leftHanded: true });
  writeInstrumentViewPreferences({ leftHanded: true }, storage); await flush(); expect(put).toHaveBeenCalledTimes(1);
  writeInstrumentViewPreferences({ clickToEdit: true }, storage); await flush(); expect(put).toHaveBeenCalledTimes(1);
});

it('never overwrites the native settings when they could not be read, and keeps working from the browser store', async () => {
  const storage = memory(), put = vi.fn(async () => ({})), bridge = { read: async () => { throw new Error('unreadable'); }, put } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  expect(writeInstrumentViewPreferences({ leftHanded: true }, storage)).toBe(true);
  expect(put).not.toHaveBeenCalled(); expect(readInstrumentViewPreferences(storage).leftHanded).toBe(true);
});

it('a failing native write does not fail the choice', async () => {
  const storage = memory(), put = vi.fn(async () => { throw new Error('disk full'); }), bridge = { read: async () => ({ instrumentView: persisted }), put } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  expect(writeInstrumentViewPreferences({ expanded: true }, storage)).toBe(true);
  await Promise.resolve(); expect(readInstrumentViewPreferences(storage).expanded).toBe(true);
});

// Review fixes: a failed native save is never forgotten, and native saving does not depend on the browser store.
import { currentInstrumentSettingsProblem, subscribeInstrumentSettingsProblem } from './view-preferences';
const unsentKey = 'tabplayer.instrumentView.unsent';

it('a failed native write leaves an unsent marker, tells the person once, and the next start sends the browser copy over the older native record', async () => {
  const storage = memory(), put = vi.fn(async () => { throw new Error('disk full'); }), bridge = { read: async () => ({ instrumentView: persisted }), put } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  const heard = vi.fn(); const stop = subscribeInstrumentSettingsProblem(heard);
  writeInstrumentViewPreferences({ leftHanded: true }, storage); await flush();
  writeInstrumentViewPreferences({ expanded: true }, storage); await flush();
  expect(storage.data.get(unsentKey)).toBeTruthy(); expect(currentInstrumentSettingsProblem()).toBe('save'); expect(heard).toHaveBeenCalledTimes(1); stop();
  // Next start: the native record still holds the old choice; the marked browser copy wins and is sent.
  resetInstrumentViewPreferencesSync(); const next = bridgeWith({ ...persisted }); setNativeSettingsBridge(next.bridge);
  await syncInstrumentViewPreferencesFromNative(storage); await flush();
  expect(next.put).toHaveBeenCalledWith({ ...persisted, leftHanded: true, expanded: true });
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, expanded: true });
  expect(storage.data.get(unsentKey)).toBeUndefined(); expect(currentInstrumentSettingsProblem()).toBeNull();
});

it('without a marker the native record still wins', async () => {
  const storage = memory({ [key]: JSON.stringify({ ...persisted, leftHanded: true }) }), { bridge, put } = bridgeWith({ ...persisted, noteNames: 'letter' });
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage); await flush();
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: false, noteNames: 'letter' }); expect(put).not.toHaveBeenCalled();
});

it('tells the person when the native settings cannot be read, keeps the choices made, and retries on the next choice', async () => {
  const storage = memory(); let fail = true; const put = vi.fn(async () => ({})), bridge = { read: async () => { if (fail) throw new Error('unreadable'); return { instrumentView: persisted }; }, put } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  expect(currentInstrumentSettingsProblem()).toBe('save');
  writeInstrumentViewPreferences({ leftHanded: true }, storage); await flush(); expect(put).not.toHaveBeenCalled(); expect(storage.data.get(unsentKey)).toBeTruthy();
  fail = false; writeInstrumentViewPreferences({ expanded: true }, storage); await flush(); await flush();
  expect(put).toHaveBeenCalledWith({ ...persisted, leftHanded: true, expanded: true }); expect(currentInstrumentSettingsProblem()).toBeNull(); expect(storage.data.get(unsentKey)).toBeUndefined();
});

it('saves natively with no browser store at all, and a choice made before the native read is merged from the choice, not from storage', async () => {
  const { bridge, put } = bridgeWith({ ...persisted, noteNames: 'letter', focus: 'next' }); setNativeSettingsBridge(bridge); const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  expect(writeInstrumentViewPreferences({ leftHanded: true }, refusing)).toBe(false);
  await syncInstrumentViewPreferencesFromNative(refusing); await flush();
  expect(put).toHaveBeenCalledWith({ ...persisted, leftHanded: true, noteNames: 'letter', focus: 'next' });
  writeInstrumentViewPreferences({ expanded: true }, refusing); await flush();
  expect(put).toHaveBeenLastCalledWith({ ...persisted, leftHanded: true, noteNames: 'letter', focus: 'next', expanded: true });
  resetInstrumentViewPreferencesSync(); const second = bridgeWith({ ...persisted, noteNames: 'letter' }); setNativeSettingsBridge(second.bridge);
  writeInstrumentViewPreferences({ focus: 'bar' }, refusing); await syncInstrumentViewPreferencesFromNative(refusing); await flush();
  expect(second.put).toHaveBeenCalledWith({ ...persisted, noteNames: 'letter', focus: 'bar' });
});

it('does not write a defaults record at first start, and a read-only (newer) native file is never written, with one message', async () => {
  const storage = memory(), first = bridgeWith(null); setNativeSettingsBridge(first.bridge);
  await syncInstrumentViewPreferencesFromNative(storage); await flush(); expect(first.put).not.toHaveBeenCalled();
  resetInstrumentViewPreferencesSync();
  const put = vi.fn(async () => ({})), bridge = { read: async () => ({ instrumentView: null, readOnly: true }), put } as unknown as NativeSettingsBridge; setNativeSettingsBridge(bridge);
  const heard = vi.fn(); const stop = subscribeInstrumentSettingsProblem(heard);
  await syncInstrumentViewPreferencesFromNative(storage);
  writeInstrumentViewPreferences({ leftHanded: true }, storage); writeInstrumentViewPreferences({ expanded: true }, storage); await flush();
  expect(put).not.toHaveBeenCalled(); expect(currentInstrumentSettingsProblem()).toBe('newer'); expect(heard).toHaveBeenCalledTimes(1);
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, expanded: true }); stop();
});

it('after a failed read on a fresh profile, a retry sends only the changed option over the native record', async () => {
  const storage = memory(); let fail = true; const native = { ...persisted, leftHanded: true, noteNames: 'letter', neck: 'bass', expanded: true };
  const put = vi.fn(async () => ({})), bridge = { read: async () => { if (fail) throw new Error('unreadable'); return { instrumentView: native }; }, put } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(bridge); await syncInstrumentViewPreferencesFromNative(storage);
  writeInstrumentViewPreferences({ focus: 'bar' }, storage); await flush(); expect(put).not.toHaveBeenCalled();
  fail = false; writeInstrumentViewPreferences({ focus: 'next' }, storage); await flush(); await flush();
  expect(put).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledWith({ ...native, focus: 'next' });
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, noteNames: 'letter', neck: 'bass', expanded: true, focus: 'next' });
});

it('the same holds when the failed read was in an earlier run: only the marked options come from the browser copy', async () => {
  const storage = memory(); const native = { ...persisted, leftHanded: true, noteNames: 'letter' };
  const first = { read: async () => { throw new Error('unreadable'); }, put: vi.fn(async () => ({})) } as unknown as NativeSettingsBridge;
  setNativeSettingsBridge(first); await syncInstrumentViewPreferencesFromNative(storage); writeInstrumentViewPreferences({ focus: 'bar' }, storage);
  resetInstrumentViewPreferencesSync(); const next = bridgeWith(native); setNativeSettingsBridge(next.bridge);
  await syncInstrumentViewPreferencesFromNative(storage); await flush();
  expect(next.put).toHaveBeenCalledWith({ ...native, focus: 'bar' });
});
