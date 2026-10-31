import { parseTuning } from './tuning';

export type PresetInstrument = 'guitar' | 'bass' | 'banjo' | 'ukulele' | 'mandolin' | 'bowed' | 'shamisen';

export interface TuningPreset {
  id: string;
  name: string;
  instrument: PresetInstrument;
  strings: number;
  tuning: readonly number[];
}

export function instrumentTitle(instrument: PresetInstrument): string {
  switch (instrument) {
    case 'guitar': return 'Guitar';
    case 'bass': return 'Bass';
    case 'banjo': return 'Banjo';
    case 'ukulele': return 'Ukulele';
    case 'mandolin': return 'Mandolin';
    case 'bowed': return 'Bowed strings';
    case 'shamisen': return 'Shamisen';
  }
}

const preset = (instrument: PresetInstrument, strings: number, id: string, name: string, notes: string): TuningPreset => ({
  id: `${instrument}-${strings}-${id}`,
  name,
  instrument,
  strings,
  tuning: parseTuning(notes),
});

export const tuningPresets: readonly TuningPreset[] = [
  // Guitar (6-9 strings)
  preset('guitar', 6, 'standard-e', 'Standard E', 'E4 B3 G3 D3 A2 E2'),
  preset('guitar', 6, 'half-step-down', 'Half step down (E♭)', 'D#4 A#3 F#3 C#3 G#2 D#2'),
  preset('guitar', 6, 'd-standard', 'D standard', 'D4 A3 F3 C3 G2 D2'),
  preset('guitar', 6, 'drop-d', 'Drop D', 'E4 B3 G3 D3 A2 D2'),
  preset('guitar', 6, 'drop-csharp', 'Drop C#', 'D#4 A#3 F#3 C#3 G#2 C#2'),
  preset('guitar', 6, 'drop-c', 'Drop C', 'D4 A3 F3 C3 G2 C2'),
  preset('guitar', 6, 'dadgad', 'DADGAD', 'D4 A3 G3 D3 A2 D2'),
  preset('guitar', 6, 'open-d', 'Open D', 'D4 A3 F#3 D3 A2 D2'),
  preset('guitar', 6, 'open-g', 'Open G', 'D4 B3 G3 D3 G2 D2'),
  preset('guitar', 7, 'standard-b', 'Standard B', 'E4 B3 G3 D3 A2 E2 B1'),
  preset('guitar', 7, 'drop-a', 'Drop A', 'E4 B3 G3 D3 A2 E2 A1'),
  preset('guitar', 7, 'a-standard', 'A standard', 'D4 A3 F3 C3 G2 D2 A1'),
  preset('guitar', 7, 'drop-g', 'Drop G', 'D4 A3 F3 C3 G2 D2 G1'),
  preset('guitar', 8, 'standard-fsharp', 'Standard F#', 'E4 B3 G3 D3 A2 E2 B1 F#1'),
  preset('guitar', 8, 'drop-e', 'Drop E', 'E4 B3 G3 D3 A2 E2 B1 E1'),
  preset('guitar', 8, 'e-standard', 'E standard', 'D4 A3 F3 C3 G2 D2 A1 E1'),
  preset('guitar', 9, 'standard-csharp', 'Standard C#', 'E4 B3 G3 D3 A2 E2 B1 F#1 C#1'),
  preset('guitar', 9, 'drop-b', 'Drop B', 'E4 B3 G3 D3 A2 E2 B1 F#1 B0'),

  // Bass (4-6 strings)
  preset('bass', 4, 'standard-e', 'Standard E', 'G2 D2 A1 E1'),
  preset('bass', 4, 'drop-d', 'Drop D', 'G2 D2 A1 D1'),
  preset('bass', 4, 'd-standard', 'D standard', 'F2 C2 G1 D1'),
  preset('bass', 5, 'standard-b', 'Standard B', 'G2 D2 A1 E1 B0'),
  preset('bass', 5, 'drop-a', 'Drop A', 'G2 D2 A1 E1 A0'),
  preset('bass', 6, 'standard-b', 'Standard B', 'C3 G2 D2 A1 E1 B0'),
  preset('bass', 6, 'drop-a', 'Drop A', 'C3 G2 D2 A1 E1 A0'),

  // Banjo (5-string and 4-string)
  preset('banjo', 5, 'open-g', 'Open G (Standard)', 'D4 B3 G3 D3 G4'),
  preset('banjo', 5, 'double-c', 'Double C', 'D4 C4 G3 C3 G4'),
  preset('banjo', 5, 'drop-c', 'Drop C', 'D4 B3 G3 C3 G4'),
  preset('banjo', 5, 'open-d', 'Open D', 'D4 A3 F#3 D3 A4'),
  preset('banjo', 5, 'g-modal', 'G modal (Sawmill)', 'D4 C4 G3 D3 G4'),
  preset('banjo', 4, 'tenor-standard', 'Tenor standard', 'A4 D4 G3 C3'),
  preset('banjo', 4, 'tenor-irish', 'Irish tenor', 'E4 A3 D3 G2'),
  preset('banjo', 4, 'plectrum', 'Plectrum standard', 'D4 B3 G3 C3'),

  // Ukulele (4-string)
  preset('ukulele', 4, 'standard-c', 'Standard C (High-G)', 'A4 E4 C4 G4'),
  preset('ukulele', 4, 'low-g', 'Low G (Linear)', 'A4 E4 C4 G3'),
  preset('ukulele', 4, 'd-tuning', 'D tuning (Traditional)', 'B4 F#4 D4 A4'),
  preset('ukulele', 4, 'baritone', 'Baritone standard', 'E4 B3 G3 D3'),

  // Mandolin (4-course/string)
  preset('mandolin', 4, 'standard', 'Standard', 'E5 A4 D4 G3'),
  preset('mandolin', 4, 'cross-a', 'Cross A', 'E5 A4 E4 A3'),

  // Bowed strings (4-string)
  preset('bowed', 4, 'violin', 'Violin standard', 'E5 A4 D4 G3'),
  preset('bowed', 4, 'viola', 'Viola standard', 'A4 D4 G3 C3'),
  preset('bowed', 4, 'cello', 'Cello standard', 'A3 D3 G2 C2'),
  preset('bowed', 4, 'double-bass', 'Double bass standard', 'G2 D2 A1 E1'),

  // Shamisen (3-string)
  preset('shamisen', 3, 'honchoshi', 'Honchōshi', 'D4 G3 D3'),
  preset('shamisen', 3, 'niagari', 'Niagari', 'D4 A3 D3'),
  preset('shamisen', 3, 'sansagari', 'Sansagari', 'C4 G3 D3'),
];

const samePitches = (preset: TuningPreset, tuning: readonly number[]) =>
  preset.tuning.length === tuning.length && preset.tuning.every((pitch, index) => pitch === tuning[index]);

/**
 * Detects a preset from pitches alone. Different instruments share pitches (violin and mandolin,
 * viola and tenor banjo, double bass and bass guitar), so pitches cannot name the instrument.
 * Guitar and bass keep first-match detection; any other tie returns undefined rather than
 * misnaming the instrument. A control that knows which preset the user chose should keep that choice.
 */
export function findTuningPreset(notes: string): TuningPreset | undefined {
  try {
    const tuning = parseTuning(notes);
    const matches = tuningPresets.filter(p => samePitches(p, tuning));
    if (matches.length <= 1) return matches[0];
    return matches.find(p => p.instrument === 'guitar' || p.instrument === 'bass');
  } catch {
    return undefined;
  }
}

/** The preset with this id when its pitches still equal `notes`; keeps an explicit choice among shared pitches. */
export function presetWithPitches(id: string, notes: string): TuningPreset | undefined {
  try {
    const tuning = parseTuning(notes);
    const found = tuningPresets.find(p => p.id === id);
    return found && samePitches(found, tuning) ? found : undefined;
  } catch {
    return undefined;
  }
}
