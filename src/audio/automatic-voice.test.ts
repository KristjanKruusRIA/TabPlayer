import { expect, it } from 'vitest';
import { automaticVoice, playsRecordedKit } from './sound-model';
import type { Gp8Status } from './soundbank-store';

const mockGp8: Gp8Status = {
  enabled: true,
  available: true,
  configuredPath: null,
  resolvedPath: 'C:/ProgramData/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard',
  detectedDefaultPath: 'C:/ProgramData/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard',
  version: '2.0.0-9',
  setCount: 6,
  error: null,
  sets: [
    { id: 'German-APiano', name: 'German Piano', instrumentSet: 'acousticPiano', category: 'keys', pickups: [], isPercussion: false },
    { id: 'Concerto-Nylon', name: 'Nylon Concerto', instrumentSet: 'nylonGuitar', category: 'guitars', pickups: [], isPercussion: false },
    { id: 'Strat-Guitar', name: 'Strat', instrumentSet: 'electricGuitar', category: 'guitars', pickups: ['bridge', 'middle', 'neck'], isPercussion: false },
    { id: 'Metal-Guitar', name: 'Metal', instrumentSet: 'electricGuitar', category: 'guitars', pickups: ['bridge', 'neck'], isPercussion: false },
    { id: 'Jazz-Bass', name: 'Jazz Bass', instrumentSet: 'electricBass', category: 'basses', pickups: ['bridge', 'neck'], isPercussion: false },
    { id: 'Drumkit-Custom', name: 'Drums (Custom)', instrumentSet: 'drumKit', category: 'drums', pickups: [], isPercussion: true },
    { id: 'Drumkit-Vintage', name: 'Drums (Vintage)', instrumentSet: 'drumKit', category: 'drums', pickups: [], isPercussion: true },
  ],
};

it('falls back to General MIDI for Automatic when GP8 soundbanks are not available', () => {
  for (const program of [0, 24, 27, 30, 33, 40, 127]) {
    expect(automaticVoice(program, false)).toBe('gm');
    expect(automaticVoice(program, true)).toBe('gm');
  }
  expect(playsRecordedKit(0, true)).toBe(false);
  expect(playsRecordedKit(0, false)).toBe(false);
});

it('picks GP8 sets for Automatic by General MIDI program and drum kit when GP8 is available', () => {
  const expected: [number, string][] = [
    [0, 'gp8:German-APiano'],
    [24, 'gp8:Concerto-Nylon'],
    [27, 'gp8:Strat-Guitar'],
    [30, 'gp8:Metal-Guitar'],
    [33, 'gp8:Jazz-Bass'],
    [125, 'gm'],
  ];
  for (const [program, voice] of expected) {
    expect(automaticVoice(program, false, mockGp8)).toBe(voice);
  }
  expect(automaticVoice(0, true, mockGp8)).toBe('gp8:Drumkit-Custom');
  expect(automaticVoice(0, true, mockGp8, 32)).toBe('gp8:Drumkit-Vintage');
  expect(playsRecordedKit(0, true, null, mockGp8)).toBe(true);
  expect(playsRecordedKit(0, true, 32, mockGp8)).toBe(true);
  expect(playsRecordedKit(0, false, null, mockGp8)).toBe(false);
});
