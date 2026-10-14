import { expect, it } from 'vitest';
import { formatTuning } from './tuning';
import { tuningPresets, findTuningPreset } from './tuning-presets';

it('contains exactly25 distinct presets across all guitar and bass string categories',()=>{
  expect(tuningPresets).toHaveLength(25);expect(new Set(tuningPresets.map(p=>p.id)).size).toBe(25);
  const groups:Record<string,number>={};for(const preset of tuningPresets){const key=`${preset.instrument}/${preset.strings}`;groups[key]=(groups[key]??0)+1;expect(preset.tuning).toHaveLength(preset.strings);expect(preset.tuning.every(p=>Number.isInteger(p)&&p>=0&&p<=127)).toBe(true);}
  expect(groups).toEqual({'guitar/6':9,'guitar/7':4,'guitar/8':3,'guitar/9':2,'bass/4':3,'bass/5':2,'bass/6':2});
});
it('matches curated high-to-low notes for every preset including six-string bass and nine-string guitar',()=>{
  const expected:Record<string,string>={
    'guitar-6-standard-e':'E4 B3 G3 D3 A2 E2','guitar-6-half-step-down':'D#4 A#3 F#3 C#3 G#2 D#2','guitar-6-d-standard':'D4 A3 F3 C3 G2 D2','guitar-6-drop-d':'E4 B3 G3 D3 A2 D2','guitar-6-drop-csharp':'D#4 A#3 F#3 C#3 G#2 C#2','guitar-6-drop-c':'D4 A3 F3 C3 G2 C2','guitar-6-dadgad':'D4 A3 G3 D3 A2 D2','guitar-6-open-d':'D4 A3 F#3 D3 A2 D2','guitar-6-open-g':'D4 B3 G3 D3 G2 D2',
    'guitar-7-standard-b':'E4 B3 G3 D3 A2 E2 B1','guitar-7-drop-a':'E4 B3 G3 D3 A2 E2 A1','guitar-7-a-standard':'D4 A3 F3 C3 G2 D2 A1','guitar-7-drop-g':'D4 A3 F3 C3 G2 D2 G1',
    'guitar-8-standard-fsharp':'E4 B3 G3 D3 A2 E2 B1 F#1','guitar-8-drop-e':'E4 B3 G3 D3 A2 E2 B1 E1','guitar-8-e-standard':'D4 A3 F3 C3 G2 D2 A1 E1',
    'guitar-9-standard-csharp':'E4 B3 G3 D3 A2 E2 B1 F#1 C#1','guitar-9-drop-b':'E4 B3 G3 D3 A2 E2 B1 F#1 B0',
    'bass-4-standard-e':'G2 D2 A1 E1','bass-4-drop-d':'G2 D2 A1 D1','bass-4-d-standard':'F2 C2 G1 D1','bass-5-standard-b':'G2 D2 A1 E1 B0','bass-5-drop-a':'G2 D2 A1 E1 A0','bass-6-standard-b':'C3 G2 D2 A1 E1 B0','bass-6-drop-a':'C3 G2 D2 A1 E1 A0',
  };
  expect(Object.fromEntries(tuningPresets.map(p=>[p.id,formatTuning(p.tuning)]))).toEqual(expected);
  expect(tuningPresets.find(p=>p.id==='bass-6-standard-b')?.tuning).not.toEqual(tuningPresets.find(p=>p.id==='guitar-6-standard-e')?.tuning);
});
it('detects presets by pitches including equivalent flats and leaves invalid custom drafts unmatched',()=>{
  expect(findTuningPreset('Eb4 Bb3 Gb3 Db3 Ab2 Eb2')?.id).toBe('guitar-6-half-step-down');expect(findTuningPreset('C3 G2 D2 A1 E1 B0')?.id).toBe('bass-6-standard-b');expect(findTuningPreset('invalid')).toBeUndefined();expect(findTuningPreset('E4 B3 G3 D3 A2 F2')).toBeUndefined();
});
