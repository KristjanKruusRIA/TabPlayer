import { expect, it } from 'vitest';
import { readInspectorTab, writeInspectorTab } from './inspector-tab';

const storage = (initial: Record<string, string> = {}) => {
  const values = { ...initial };
  return { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; }, values };
};

it('remembers Song and Track, and reads anything else as Track', () => {
  expect(readInspectorTab(storage())).toBe('track');
  expect(readInspectorTab(storage({ 'tabplayer.inspectorTab': 'song' }))).toBe('song');
  expect(readInspectorTab(storage({ 'tabplayer.inspectorTab': 'track' }))).toBe('track');
});

it('a stored Selection tab, from before the tab was removed, or anything unknown, opens Track', () => {
  for (const stored of ['selection', 'Selection', '', 'bogus', '{"tab":"selection"}']) expect(readInspectorTab(storage({ 'tabplayer.inspectorTab': stored }))).toBe('track');
});

it('survives storage that throws or is missing', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(readInspectorTab(broken)).toBe('track');expect(writeInspectorTab('song', broken)).toBe(false);expect(readInspectorTab(undefined)).toBe('track');
});

it('writes the tab it is given', () => {
  const kept = storage();expect(writeInspectorTab('song', kept)).toBe(true);expect(kept.values['tabplayer.inspectorTab']).toBe('song');
});
