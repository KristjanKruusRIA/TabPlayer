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
  const storage = memory({ 'tabplayer.instrumentView': JSON.stringify({ leftHanded: true, noteNames: 'solfege', viewMode: 'banjo', neck: 'bass', expanded: 'yes', focus: 'bar', keyboardPanel: 1 }) });
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
