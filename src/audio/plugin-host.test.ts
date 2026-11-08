import { beforeEach, expect, it, vi } from 'vitest';
import { pluginLibrary, type PluginLibraryEntry } from './plugin-host';

const calls: Array<[string, unknown]> = [];
let answer: unknown = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    calls.push([command, args]);
    if (answer instanceof Error) throw answer;
    return answer;
  }),
}));

const entry: PluginLibraryEntry = {
  classId: 'A'.repeat(32),
  name: 'Amp',
  vendor: 'Vendor',
  version: '1.0',
  bundle: String.raw`C:\Plugins\Amp.vst3`,
  moduleLen: 10,
  moduleModified: 1_700_000_000_000,
};

beforeEach(() => {
  calls.length = 0;
  answer = [];
});

it('lists, adds and removes through the native commands', async () => {
  expect(entry.bundle).toBe('C:' + String.fromCharCode(92) + 'Plugins' + String.fromCharCode(92) + 'Amp.vst3');
  answer = [entry];
  expect(await pluginLibrary.list()).toEqual([entry]);
  expect(await pluginLibrary.add()).toEqual([entry]);
  answer = null;
  expect(await pluginLibrary.add()).toBeNull();
  await pluginLibrary.remove(entry.classId);
  expect(calls).toEqual([
    ['plugin_library_list', undefined],
    ['plugin_library_add', undefined],
    ['plugin_library_add', undefined],
    ['plugin_library_remove', { classId: entry.classId }],
  ]);
});

it('passes a refusal on as a rejection', async () => {
  answer = new Error('Choose a .vst3 plug-in.');
  await expect(pluginLibrary.add()).rejects.toThrow('Choose a .vst3 plug-in.');
});
