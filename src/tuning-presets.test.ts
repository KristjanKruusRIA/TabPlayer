import { expect, it } from 'vitest';
import { formatTuning } from './tuning';
import { findTuningPreset, instrumentTitle, presetWithPitches, tuningPresets } from './tuning-presets';

it('contains exactly 46 distinct presets across guitar, bass, banjo, ukulele, mandolin, bowed strings, and shamisen', () => {
  expect(tuningPresets).toHaveLength(46);
  expect(new Set(tuningPresets.map(p => p.id)).size).toBe(46);
  const groups: Record<string, number> = {};
  for (const preset of tuningPresets) {
    const key = `${preset.instrument}/${preset.strings}`;
    groups[key] = (groups[key] ?? 0) + 1;
    expect(preset.tuning).toHaveLength(preset.strings);
    expect(preset.tuning.every(p => Number.isInteger(p) && p >= 0 && p <= 127)).toBe(true);
  }
  expect(groups).toEqual({
    'guitar/6': 9,
    'guitar/7': 4,
    'guitar/8': 3,
    'guitar/9': 2,
    'bass/4': 3,
    'bass/5': 2,
    'bass/6': 2,
    'banjo/5': 5,
    'banjo/4': 3,
    'ukulele/4': 4,
    'mandolin/4': 2,
    'bowed/4': 4,
    'shamisen/3': 3,
  });
});

it('matches curated high-to-low notes for every preset across all instrument families', () => {
  const expected: Record<string, string> = {
    // Guitar
    'guitar-6-standard-e': 'E4 B3 G3 D3 A2 E2',
    'guitar-6-half-step-down': 'D#4 A#3 F#3 C#3 G#2 D#2',
    'guitar-6-d-standard': 'D4 A3 F3 C3 G2 D2',
    'guitar-6-drop-d': 'E4 B3 G3 D3 A2 D2',
    'guitar-6-drop-csharp': 'D#4 A#3 F#3 C#3 G#2 C#2',
    'guitar-6-drop-c': 'D4 A3 F3 C3 G2 C2',
    'guitar-6-dadgad': 'D4 A3 G3 D3 A2 D2',
    'guitar-6-open-d': 'D4 A3 F#3 D3 A2 D2',
    'guitar-6-open-g': 'D4 B3 G3 D3 G2 D2',
    'guitar-7-standard-b': 'E4 B3 G3 D3 A2 E2 B1',
    'guitar-7-drop-a': 'E4 B3 G3 D3 A2 E2 A1',
    'guitar-7-a-standard': 'D4 A3 F3 C3 G2 D2 A1',
    'guitar-7-drop-g': 'D4 A3 F3 C3 G2 D2 G1',
    'guitar-8-standard-fsharp': 'E4 B3 G3 D3 A2 E2 B1 F#1',
    'guitar-8-drop-e': 'E4 B3 G3 D3 A2 E2 B1 E1',
    'guitar-8-e-standard': 'D4 A3 F3 C3 G2 D2 A1 E1',
    'guitar-9-standard-csharp': 'E4 B3 G3 D3 A2 E2 B1 F#1 C#1',
    'guitar-9-drop-b': 'E4 B3 G3 D3 A2 E2 B1 F#1 B0',

    // Bass
    'bass-4-standard-e': 'G2 D2 A1 E1',
    'bass-4-drop-d': 'G2 D2 A1 D1',
    'bass-4-d-standard': 'F2 C2 G1 D1',
    'bass-5-standard-b': 'G2 D2 A1 E1 B0',
    'bass-5-drop-a': 'G2 D2 A1 E1 A0',
    'bass-6-standard-b': 'C3 G2 D2 A1 E1 B0',
    'bass-6-drop-a': 'C3 G2 D2 A1 E1 A0',

    // Banjo
    'banjo-5-open-g': 'D4 B3 G3 D3 G4',
    'banjo-5-double-c': 'D4 C4 G3 C3 G4',
    'banjo-5-drop-c': 'D4 B3 G3 C3 G4',
    'banjo-5-open-d': 'D4 A3 F#3 D3 A4',
    'banjo-5-g-modal': 'D4 C4 G3 D3 G4',
    'banjo-4-tenor-standard': 'A4 D4 G3 C3',
    'banjo-4-tenor-irish': 'E4 A3 D3 G2',
    'banjo-4-plectrum': 'D4 B3 G3 C3',

    // Ukulele
    'ukulele-4-standard-c': 'A4 E4 C4 G4',
    'ukulele-4-low-g': 'A4 E4 C4 G3',
    'ukulele-4-d-tuning': 'B4 F#4 D4 A4',
    'ukulele-4-baritone': 'E4 B3 G3 D3',

    // Mandolin
    'mandolin-4-standard': 'E5 A4 D4 G3',
    'mandolin-4-cross-a': 'E5 A4 E4 A3',

    // Bowed strings
    'bowed-4-violin': 'E5 A4 D4 G3',
    'bowed-4-viola': 'A4 D4 G3 C3',
    'bowed-4-cello': 'A3 D3 G2 C2',
    'bowed-4-double-bass': 'G2 D2 A1 E1',

    // Shamisen
    'shamisen-3-honchoshi': 'D4 G3 D3',
    'shamisen-3-niagari': 'D4 A3 D3',
    'shamisen-3-sansagari': 'C4 G3 D3',
  };
  expect(Object.fromEntries(tuningPresets.map(p => [p.id, formatTuning(p.tuning)]))).toEqual(expected);
  expect(tuningPresets.find(p => p.id === 'bass-6-standard-b')?.tuning).not.toEqual(tuningPresets.find(p => p.id === 'guitar-6-standard-e')?.tuning);
});

it('formats readable instrument titles for group headings', () => {
  expect(instrumentTitle('guitar')).toBe('Guitar');
  expect(instrumentTitle('bass')).toBe('Bass');
  expect(instrumentTitle('banjo')).toBe('Banjo');
  expect(instrumentTitle('ukulele')).toBe('Ukulele');
  expect(instrumentTitle('mandolin')).toBe('Mandolin');
  expect(instrumentTitle('bowed')).toBe('Bowed strings');
  expect(instrumentTitle('shamisen')).toBe('Shamisen');
});

it('detects presets by pitches including equivalent flats and leaves invalid custom drafts unmatched', () => {
  expect(findTuningPreset('Eb4 Bb3 Gb3 Db3 Ab2 Eb2')?.id).toBe('guitar-6-half-step-down');
  expect(findTuningPreset('C3 G2 D2 A1 E1 B0')?.id).toBe('bass-6-standard-b');
  expect(findTuningPreset('D4 B3 G3 D3 G4')?.id).toBe('banjo-5-open-g');
  expect(findTuningPreset('A4 E4 C4 G4')?.id).toBe('ukulele-4-standard-c');
  expect(findTuningPreset('D4 G3 D3')?.id).toBe('shamisen-3-honchoshi');
  expect(findTuningPreset('invalid')).toBeUndefined();
  // Shared pitches never rename the instrument: guitar/bass ties keep their ids, other ties are undetected.
  expect(findTuningPreset('G2 D2 A1 E1')?.id).toBe('bass-4-standard-e');
  expect(findTuningPreset('E5 A4 D4 G3')).toBeUndefined();
  expect(findTuningPreset('A4 D4 G3 C3')).toBeUndefined();
  expect(presetWithPitches('bowed-4-violin', 'E5 A4 D4 G3')?.id).toBe('bowed-4-violin');
  expect(presetWithPitches('bowed-4-violin', 'A4 D4 G3 C3')).toBeUndefined();
  expect(findTuningPreset('E4 B3 G3 D3 A2 F2')).toBeUndefined();
});
