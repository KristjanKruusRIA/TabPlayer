// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { instrumentViewDefaults, readInstrumentViewPreferences, writeInstrumentViewPreferences } from './view-preferences';

afterEach(() => localStorage.clear());
const memory = (initial: Record<string, string> = {}) => { const data = new Map(Object.entries(initial)); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data }; };

it('starts from the defaults and keeps each stored option separately', () => {
  expect(readInstrumentViewPreferences(memory())).toEqual(instrumentViewDefaults);
  const storage = memory();
  expect(writeInstrumentViewPreferences({ leftHanded: true }, storage)).toBe(true);
  expect(writeInstrumentViewPreferences({ noteNames: 'letter', neck: 'bass' }, storage)).toBe(true);
  expect(readInstrumentViewPreferences(storage)).toEqual({ ...instrumentViewDefaults, leftHanded: true, noteNames: 'letter', neck: 'bass' });
});

it('repairs unknown values field by field instead of dropping the rest', () => {
  const storage = memory({ 'tabplayer.instrumentView': JSON.stringify({ leftHanded: true, noteNames: 'solfege', viewMode: 'banjo', neck: 'bass', expanded: 'yes', focus: 'bar' }) });
  expect(readInstrumentViewPreferences(storage)).toEqual({ ...instrumentViewDefaults, leftHanded: true, neck: 'bass', focus: 'bar' });
  expect(readInstrumentViewPreferences(memory({ 'tabplayer.instrumentView': '{not json' }))).toEqual(instrumentViewDefaults);
});

it('reads the handedness older builds kept under its own key until a new choice is stored, and keeps click to edit under its own key', () => {
  const storage = memory({ 'tabplayer.instrument.leftHanded': 'left', 'tabplayer.instrument.editNotes': 'on' });
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: true, clickToEdit: true });
  writeInstrumentViewPreferences({ leftHanded: false }, storage);
  expect(readInstrumentViewPreferences(storage)).toMatchObject({ leftHanded: false, clickToEdit: true });
  writeInstrumentViewPreferences({ clickToEdit: false }, storage);
  expect(storage.data.get('tabplayer.instrument.editNotes')).toBe('off');
  expect(JSON.parse(storage.data.get('tabplayer.instrument') ?? storage.data.get('tabplayer.instrumentView')!)).not.toHaveProperty('clickToEdit');
});

it('reports a refusing store instead of throwing, and reads defaults without one', () => {
  const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  expect(writeInstrumentViewPreferences({ leftHanded: true }, refusing)).toBe(false);
  expect(readInstrumentViewPreferences(refusing)).toEqual(instrumentViewDefaults);
});

it('uses the browser store by default', () => {
  writeInstrumentViewPreferences({ expanded: true });
  expect(readInstrumentViewPreferences().expanded).toBe(true);
});

it('reads each stored value on its own: a corrupt record does not hide the older keys, and an invalid flag falls back per field', () => {
  const corrupt = memory({ 'tabplayer.instrumentView': '{not json', 'tabplayer.instrument.leftHanded': 'left', 'tabplayer.instrument.editNotes': 'on' });
  expect(readInstrumentViewPreferences(corrupt)).toEqual({ ...instrumentViewDefaults, leftHanded: true, clickToEdit: true });
  const invalid = memory({ 'tabplayer.instrumentView': JSON.stringify({ leftHanded: 'yes', expanded: true }), 'tabplayer.instrument.leftHanded': 'left' });
  expect(readInstrumentViewPreferences(invalid)).toEqual({ ...instrumentViewDefaults, leftHanded: true, expanded: true });
  const throwing = { getItem: (name: string) => { if (name === 'tabplayer.instrumentView') throw new Error('blocked'); return name === 'tabplayer.instrument.editNotes' ? 'on' : null; }, setItem: () => {} };
  expect(readInstrumentViewPreferences(throwing)).toMatchObject({ clickToEdit: true });
});

it('does not keep which dock panel was open: the keyboard panel is a choice for the running session only', () => {
  const storage = memory(); writeInstrumentViewPreferences({ leftHanded: true }, storage);
  expect(JSON.parse(storage.data.get('tabplayer.instrumentView')!)).not.toHaveProperty('keyboardPanel');
  expect(instrumentViewDefaults).not.toHaveProperty('keyboardPanel');
});
