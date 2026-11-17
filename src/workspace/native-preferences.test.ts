// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readScoreErrorDisplay, writeScoreErrorDisplay } from '../editor/score-errors';
import { forgetSessionAuthorDefaults, newScoreDefaults, writeAuthorDefaults, type AuthorDefaults } from './author-defaults';
import { currentPreferenceSettingsProblem, resetNativePreferencesSync, setNativePreferenceBridge, subscribeNativePreferences, syncNativePreferences, type NativePreferenceBridge } from './native-preferences';
import { currentViewDefaults, forgetSessionViewDefaults, hasSavedViewDefaults, standardViewDefaults, writeViewDefaults, type ViewDefaults } from './view-defaults';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const authored: AuthorDefaults = { artist: 'A', words: 'W', music: 'M', tab: 'T', copyright: 'C' };
const viewed: ViewDefaults = { layout: 'grid', zoomMode: 'fitPage', zoom: 150, tracks: 'all' };
const bridgeWith = (stored: Record<string, unknown>) => {
  const put = vi.fn(async (_group: string, _value: unknown) => ({})), read = vi.fn(async () => stored);
  return { bridge: { read, put } as unknown as NativePreferenceBridge, put, read };
};
const forget = () => { localStorage.clear(); resetNativePreferencesSync(); forgetSessionViewDefaults(); forgetSessionAuthorDefaults(); };
beforeEach(forget);
afterEach(() => { setNativePreferenceBridge(null); forget(); });

it('restores the three groups from the native settings after the browser profile was reset, and tells the open views', async () => {
  const { bridge, put } = bridgeWith({ scoreErrors: { mark: false }, newScore: authored, viewDefaults: viewed });
  setNativePreferenceBridge(bridge); const heard = vi.fn(); const stop = subscribeNativePreferences(heard);
  expect(readScoreErrorDisplay()).toBe(true); expect(hasSavedViewDefaults()).toBe(false); expect(newScoreDefaults().artist).toBe('');
  await syncNativePreferences();
  expect(readScoreErrorDisplay()).toBe(false); expect(newScoreDefaults()).toEqual(authored);
  expect(currentViewDefaults()).toEqual(viewed); expect(hasSavedViewDefaults()).toBe(true);
  expect(heard.mock.calls.map(call => call[0]).sort()).toEqual(['newScore', 'scoreErrors', 'viewDefaults']);
  expect(put).not.toHaveBeenCalled(); stop();
});

it('keeps a choice made before the native settings arrived and sends it once, leaving the other groups to the native record', async () => {
  const { bridge, put } = bridgeWith({ scoreErrors: { mark: false }, newScore: authored, viewDefaults: { ...standardViewDefaults } });
  setNativePreferenceBridge(bridge);
  writeViewDefaults(viewed); expect(put).not.toHaveBeenCalled();
  await syncNativePreferences(); await flush();
  expect(currentViewDefaults()).toEqual(viewed); expect(readScoreErrorDisplay()).toBe(false); expect(newScoreDefaults()).toEqual(authored);
  expect(put).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledWith('viewDefaults', viewed);
});

it('moves existing browser records to the native settings once, also from a settings file written before these groups existed', async () => {
  writeScoreErrorDisplay(false); writeAuthorDefaults(authored); writeViewDefaults(viewed);
  forgetSessionViewDefaults(); forgetSessionAuthorDefaults();
  // What the previous build wrote: only the instrument view section.
  const { bridge, put } = bridgeWith({ instrumentView: { leftHanded: true }, readOnly: false });
  setNativePreferenceBridge(bridge);
  await syncNativePreferences(); await flush();
  expect(put).toHaveBeenCalledTimes(3);
  expect(put).toHaveBeenCalledWith('scoreErrors', { mark: false }); expect(put).toHaveBeenCalledWith('newScore', authored); expect(put).toHaveBeenCalledWith('viewDefaults', viewed);
  await syncNativePreferences(); expect(put).toHaveBeenCalledTimes(3);
  expect(readScoreErrorDisplay()).toBe(false); expect(newScoreDefaults()).toEqual(authored); expect(currentViewDefaults()).toEqual(viewed);
});

it('writes nothing natively when nothing was ever chosen', async () => {
  const { bridge, put } = bridgeWith({}); setNativePreferenceBridge(bridge);
  await syncNativePreferences(); await flush();
  expect(put).not.toHaveBeenCalled(); expect(currentPreferenceSettingsProblem()).toBeNull();
  expect(hasSavedViewDefaults()).toBe(false); expect(readScoreErrorDisplay()).toBe(true);
});

it('treats whatever the native side returns as untrusted, field by field', async () => {
  const { bridge } = bridgeWith({ scoreErrors: { mark: 'no' }, newScore: { artist: 7, words: 'w'.repeat(1500), music: 'm', tab: null }, viewDefaults: { layout: 'wall', zoomMode: 'fitPage', zoom: 1e9, tracks: 'all', extra: 1 } });
  setNativePreferenceBridge(bridge); await syncNativePreferences();
  expect(readScoreErrorDisplay()).toBe(true);
  expect(newScoreDefaults()).toEqual({ artist: '', words: 'w'.repeat(1000), music: 'm', tab: '', copyright: '' });
  expect(currentViewDefaults()).toEqual({ layout: 'parchment', zoomMode: 'fitWidth', zoom: 100, tracks: 'all' });
  const hostile = bridgeWith({ scoreErrors: [1], newScore: 'x', viewDefaults: 5 }); resetNativePreferencesSync(); localStorage.clear(); setNativePreferenceBridge(hostile.bridge);
  await syncNativePreferences(); await flush(); expect(hostile.put).not.toHaveBeenCalled();
});

it('sends a real change once the settings are loaded and nothing for the value already kept', async () => {
  const { bridge, put } = bridgeWith({ scoreErrors: { mark: false }, newScore: authored, viewDefaults: viewed }); setNativePreferenceBridge(bridge);
  await syncNativePreferences();
  writeScoreErrorDisplay(false); writeAuthorDefaults({ ...authored }); writeViewDefaults({ ...viewed }); await flush();
  expect(put).not.toHaveBeenCalled();
  writeViewDefaults({ ...viewed, zoom: 90 }); await flush();
  expect(put).toHaveBeenCalledTimes(1); expect(put).toHaveBeenLastCalledWith('viewDefaults', { ...viewed, zoom: 90 });
  writeViewDefaults({ ...viewed, zoom: 90 }); await flush(); expect(put).toHaveBeenCalledTimes(1);
});

it('never overwrites the native settings when they could not be read, keeps working from the browser copy and tries the read again on the next choice', async () => {
  const put = vi.fn(async () => ({})); let fail = true;
  const read = vi.fn(async () => { if (fail) throw new Error('unreadable'); return { scoreErrors: { mark: true }, newScore: authored }; });
  setNativePreferenceBridge({ read, put } as unknown as NativePreferenceBridge);
  await syncNativePreferences();
  expect(currentPreferenceSettingsProblem()).toBe('save');
  writeScoreErrorDisplay(false); await flush(); expect(readScoreErrorDisplay()).toBe(false); expect(put).not.toHaveBeenCalled();
  fail = false; writeViewDefaults(viewed); await flush(); await flush();
  expect(put).toHaveBeenCalledWith('scoreErrors', { mark: false }); expect(put).toHaveBeenCalledWith('viewDefaults', viewed);
  expect(put).not.toHaveBeenCalledWith('newScore', expect.anything());
  expect(newScoreDefaults()).toEqual(authored); expect(currentPreferenceSettingsProblem()).toBeNull();
});

it('a failing native write does not fail the choice, is announced once, and the next start sends the browser copy over the older native record', async () => {
  const stored = { scoreErrors: { mark: true } };
  const put = vi.fn(async () => { throw new Error('disk full'); });
  setNativePreferenceBridge({ read: async () => stored, put } as unknown as NativePreferenceBridge);
  await syncNativePreferences();
  const heard = vi.fn(); const stop = (await import('./native-preferences')).subscribePreferenceSettingsProblem(heard);
  writeScoreErrorDisplay(false); writeScoreErrorDisplay(true); writeScoreErrorDisplay(false); await flush();
  expect(readScoreErrorDisplay()).toBe(false); expect(currentPreferenceSettingsProblem()).toBe('save'); expect(heard).toHaveBeenCalledTimes(1); stop();
  // The next start: a working native side that still holds the older record.
  resetNativePreferencesSync();
  const next = bridgeWith(stored); setNativePreferenceBridge(next.bridge);
  await syncNativePreferences(); await flush();
  expect(next.put).toHaveBeenCalledWith('scoreErrors', { mark: false }); expect(readScoreErrorDisplay()).toBe(false);
  expect(currentPreferenceSettingsProblem()).toBeNull();
  resetNativePreferencesSync(); const again = bridgeWith({ scoreErrors: { mark: true } }); setNativePreferenceBridge(again.bridge);
  await syncNativePreferences(); expect(readScoreErrorDisplay()).toBe(true); expect(again.put).not.toHaveBeenCalled();
});

it('leaves settings of a newer build alone: nothing is sent, the choice still applies, and the person is told once', async () => {
  const { bridge, put } = bridgeWith({ readOnly: true });
  setNativePreferenceBridge(bridge); writeScoreErrorDisplay(false);
  await syncNativePreferences(); expect(currentPreferenceSettingsProblem()).toBe('newer');
  writeViewDefaults(viewed); writeAuthorDefaults(authored); await flush();
  expect(put).not.toHaveBeenCalled(); expect(readScoreErrorDisplay()).toBe(false); expect(currentViewDefaults()).toEqual(viewed); expect(newScoreDefaults()).toEqual(authored);
  resetNativePreferencesSync(); const quiet = bridgeWith({ readOnly: true }); setNativePreferenceBridge(quiet.bridge);
  await syncNativePreferences(); expect(currentPreferenceSettingsProblem()).toBeNull();
  writeScoreErrorDisplay(true); expect(currentPreferenceSettingsProblem()).toBe('newer'); expect(quiet.put).not.toHaveBeenCalled();
});

it('a native refusal because the file is newer is shown as that, not as a failed save', async () => {
  const put = vi.fn(async () => { throw 'settings-newer-version'; });
  setNativePreferenceBridge({ read: async () => ({}), put } as unknown as NativePreferenceBridge);
  await syncNativePreferences(); writeScoreErrorDisplay(false); await flush();
  expect(currentPreferenceSettingsProblem()).toBe('newer'); expect(readScoreErrorDisplay()).toBe(false);
});
