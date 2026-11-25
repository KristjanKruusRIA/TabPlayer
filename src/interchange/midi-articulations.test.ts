import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIDI_ARTICULATION_PRESET,
  countDetectedKeyswitches,
  extractMidiArticulations,
  midiArticulationPresetById,
  midiArticulationPresets,
  presetKeyswitchSet,
  resolveForcedStringIndex,
} from './midi-articulations';

describe('midi-articulations presets and extraction', () => {
  it('ships SubMission Audio (Default) first and The Primer second', () => {
    const presets = midiArticulationPresets();
    expect(DEFAULT_MIDI_ARTICULATION_PRESET).toBe('submission-audio-default');
    expect(presets.map(p => [p.id, p.name])).toEqual([
      ['submission-audio-default', 'SubMission Audio (Default)'],
      ['the-primer', 'The Primer'],
    ]);
    expect(midiArticulationPresetById('submission-audio-default')).toBeDefined();
    expect(midiArticulationPresetById('the-primer')).toBeDefined();
  });

  it('resolves forceString constraints for lowest-anchored and highest-anchored presets across string counts', () => {
    // SubMission Audio Default: 127 = lowest string (offset 0), 123 = 5th lowest (highest on 5-string bass).
    expect(resolveForcedStringIndex({ anchor: 'lowest', offset: 0 }, 5)).toBe(0);
    expect(resolveForcedStringIndex({ anchor: 'lowest', offset: 4 }, 5)).toBe(4);
    expect(resolveForcedStringIndex({ anchor: 'lowest', offset: 4 }, 4)).toBeNull();

    // The Primer: 1 = highest string (offset 0 -> index 4 on 5-string), 5 = lowest string (offset 4 -> index 0).
    expect(resolveForcedStringIndex({ anchor: 'highest', offset: 0 }, 5)).toBe(4);
    expect(resolveForcedStringIndex({ anchor: 'highest', offset: 3 }, 5)).toBe(1);
    expect(resolveForcedStringIndex({ anchor: 'highest', offset: 4 }, 5)).toBe(0);
    expect(resolveForcedStringIndex({ anchor: 'highest', offset: 4 }, 4)).toBeNull();
  });

  it('applies momentary switches across [start - leadTolerance, end), respects half-open end boundary, and handles latch in The Primer', () => {
    const raw = [
      // Momentary Force String 3 (key 3 -> anchor highest offset 2) spanning 960..1920
      { key: 3, start: 960, end: 1920 },
      // Latched Normal (key 0 -> normal) at 2880 (cannot undo momentary, clears any latch)
      { key: 0, start: 2880, end: 3360 },
      // Momentary Harmonic (key 8) + Force String 5 (key 5) overlapping at 1440
      { key: 8, start: 1440, end: 1920 },
      { key: 5, start: 1440, end: 1920 },
      // Playable notes
      { key: 52, start: 950, end: 1440 }, // within 15-tick lead tolerance before 960 -> gets Force String 3
      { key: 52, start: 1440, end: 1920 }, // gets Force String 5 + Harmonic
      { key: 52, start: 1920, end: 2400 }, // starts exactly at ks.end -> unannotated
    ];

    const out = extractMidiArticulations(raw, 'the-primer', 960, 0);
    expect(out.keyswitchesFound).toBe(4);
    expect(out.notesAnnotated).toBe(2);
    expect(out.notes.map(n => [n.key, n.start, n.articulation])).toEqual([
      [52, 950, { forceString: { anchor: 'highest', offset: 2 } }],
      [52, 1440, { forceString: { anchor: 'highest', offset: 4 }, harmonic: true }],
      [52, 1920, undefined],
    ]);
  });

  it('supports keyswitch octave shifting without altering playable notes', () => {
    const raw = [
      { key: 12 + 3, start: 0, end: 480 }, // Dead note shifted +1 octave in SubMission Audio Default (3 -> 15 at shift +1)
      { key: 36, start: 0, end: 480 },
    ];
    const atZero = extractMidiArticulations(raw, 'submission-audio-default', 480, 0);
    // At shift 0, key 15 is Dead Thump Down (deadSlap + dead)
    expect(atZero.notes[0].articulation).toEqual({ deadSlap: true, dead: true });

    const atPlusOne = extractMidiArticulations(raw, 'submission-audio-default', 480, 1);
    expect(atPlusOne.notes[0].articulation).toEqual({ dead: true });
    expect(presetKeyswitchSet('submission-audio-default', 0).has(127)).toBe(true);
    expect(countDetectedKeyswitches([{ key: 2, count: 3 }, { key: 5, count: 12 }, { key: 37, count: 40 }], 'the-primer', 0)).toBe(15);
  });
});
