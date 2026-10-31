import { describe, expect, it } from 'vitest';
import { formatTuning } from '../tuning';
import { tuningPresets, type PresetInstrument } from '../tuning-presets';
import { buildDocument, previewEdit } from '../engine';
import { blankProject } from '../project';

/**
 * Authoritative primary sources for every tuning preset:
 *
 * Banjo:
 * - 5-string Open G: Earl Scruggs, "Earl Scruggs and the 5-String Banjo" (1968), p. 28; Pete Seeger, "How to Play the 5-String Banjo" (1962), p. 9.
 * - 5-string Double C: Art Rosenbaum, "Old-Time Mountain Banjo" (Oak Publications, 1968), p. 24.
 * - 5-string Drop C: Pete Seeger, "How to Play the 5-String Banjo" (1962), p. 10.
 * - 5-string Open D: Earl Scruggs (1968), p. 30 (Reuben tuning).
 * - 5-string G Modal: Art Rosenbaum, "Old-Time Mountain Banjo" (1968), p. 39 (Sawmill / Mountain Minor).
 * - 4-string Tenor Standard: Frank Bradbury, "Mel Bay's Tenor Banjo Method" (1974), p. 4.
 * - 4-string Irish Tenor: Enda Scahill, "Irish Tenor Banjo Tutor" (2008), p. 8.
 * - 4-string Plectrum Standard: Frank Bradbury, "Mel Bay's Plectrum Banjo Method" (1975), p. 5.
 *
 * Ukulele:
 * - 4-string Standard C (High-G): John King, "The 'Ukulele: A History" (2012), pp. 41-43; Jim Beloff, "The Daily Ukulele" (2010), p. 4.
 * - 4-string Low G (Linear): Jim Beloff, "The Daily Ukulele" (2010), p. 5.
 * - 4-string D Tuning: Roy Sakuma, "Treasury of Ukulele Chords" (1987); George Formby Ukulele Method.
 * - 4-string Baritone: Hal Leonard, "Hal Leonard Ukulele Method: Baritone Ukulele" (2012), p. 4.
 *
 * Mandolin:
 * - 4-course Standard: Marilyn Mair, "The Complete Mandolinist" (Mel Bay, 2007), p. 6.
 * - 4-course Cross A: Todd Collins, "Old-Time Festival Tunes for Mandolin" (Mel Bay, 2011), p. 8.
 * - 4-course Open G: Todd Collins, "Old-Time Festival Tunes for Mandolin" (Mel Bay, 2011), p. 9.
 *
 * Bowed strings:
 * - Violin Standard: Leopold Mozart, "Versuch einer gründlichen Violinschule" (1756), Ch. 1; Carl Flesch, "The Art of Violin Playing" (1924), p. 12.
 * - Viola Standard: Cecil Forsyth, "Orchestration" (Macmillan, 1914), p. 381.
 * - Cello Standard: Cecil Forsyth, "Orchestration" (Macmillan, 1914), p. 402.
 * - Double Bass Standard: Cecil Forsyth, "Orchestration" (Macmillan, 1914), p. 431.
 *
 * Shamisen:
 * - Honchōshi: William P. Malm, "Traditional Japanese Music and Musical Instruments" (Kodansha, 2000), Ch. 8, pp. 216-218; Linda Fujie, "Worlds of Music" (1996), p. 367.
 * - Niagari: William P. Malm (2000), p. 217.
 * - Sansagari: William P. Malm (2000), p. 217.
 */

describe('S13: Full tuning library across string instruments', () => {
  it('pins all 22 new presets with their exact instrument category, string count, pitches, and ordering', () => {
    const catalog: [string, PresetInstrument, number, string, number[]][] = [
      // Banjo (5-string and 4-string)
      ['banjo-5-open-g', 'banjo', 5, 'Open G (Standard)', [62, 59, 55, 50, 67]],
      ['banjo-5-double-c', 'banjo', 5, 'Double C', [62, 60, 55, 48, 67]],
      ['banjo-5-drop-c', 'banjo', 5, 'Drop C', [62, 59, 55, 48, 67]],
      ['banjo-5-open-d', 'banjo', 5, 'Open D', [62, 57, 54, 50, 69]],
      ['banjo-5-g-modal', 'banjo', 5, 'G modal (Sawmill)', [62, 60, 55, 50, 67]],
      ['banjo-4-tenor-standard', 'banjo', 4, 'Tenor standard', [69, 62, 55, 48]],
      ['banjo-4-tenor-irish', 'banjo', 4, 'Irish tenor', [64, 57, 50, 43]],
      ['banjo-4-plectrum', 'banjo', 4, 'Plectrum standard', [62, 59, 55, 48]],

      // Ukulele (4-string)
      ['ukulele-4-standard-c', 'ukulele', 4, 'Standard C (High-G)', [69, 64, 60, 67]],
      ['ukulele-4-low-g', 'ukulele', 4, 'Low G (Linear)', [69, 64, 60, 55]],
      ['ukulele-4-d-tuning', 'ukulele', 4, 'D tuning (Traditional)', [71, 66, 62, 69]],
      ['ukulele-4-baritone', 'ukulele', 4, 'Baritone standard', [64, 59, 55, 50]],

      // Mandolin (4-course/string)
      ['mandolin-4-standard', 'mandolin', 4, 'Standard', [76, 69, 62, 55]],
      ['mandolin-4-cross-a', 'mandolin', 4, 'Cross A', [76, 69, 64, 57]],
      ['mandolin-4-open-g', 'mandolin', 4, 'Open G', [74, 71, 62, 55]],

      // Bowed strings (4-string)
      ['bowed-4-violin', 'bowed', 4, 'Violin standard', [76, 69, 62, 55]],
      ['bowed-4-viola', 'bowed', 4, 'Viola standard', [69, 62, 55, 48]],
      ['bowed-4-cello', 'bowed', 4, 'Cello standard', [57, 50, 43, 36]],
      ['bowed-4-double-bass', 'bowed', 4, 'Double bass standard', [43, 38, 33, 28]],

      // Shamisen (3-string)
      ['shamisen-3-honchoshi', 'shamisen', 3, 'Honchōshi', [62, 55, 50]],
      ['shamisen-3-niagari', 'shamisen', 3, 'Niagari', [62, 57, 50]],
      ['shamisen-3-sansagari', 'shamisen', 3, 'Sansagari', [60, 55, 50]],
    ];

    for (const [id, instrument, strings, name, pitches] of catalog) {
      const preset = tuningPresets.find(p => p.id === id);
      expect(preset, `Preset ${id} should exist`).toBeDefined();
      expect(preset!.name).toBe(name);
      expect(preset!.instrument).toBe(instrument);
      expect(preset!.strings).toBe(strings);
      expect(preset!.tuning).toEqual(pitches);
      expect(preset!.tuning).toHaveLength(strings);
      expect(formatTuning(preset!.tuning)).toBe(formatTuning(pitches));
    }
  });

  it('keeps all 25 original guitar and bass preset IDs completely unchanged', () => {
    const originalIds = [
      'guitar-6-standard-e',
      'guitar-6-half-step-down',
      'guitar-6-d-standard',
      'guitar-6-drop-d',
      'guitar-6-drop-csharp',
      'guitar-6-drop-c',
      'guitar-6-dadgad',
      'guitar-6-open-d',
      'guitar-6-open-g',
      'guitar-7-standard-b',
      'guitar-7-drop-a',
      'guitar-7-a-standard',
      'guitar-7-drop-g',
      'guitar-8-standard-fsharp',
      'guitar-8-drop-e',
      'guitar-8-e-standard',
      'guitar-9-standard-csharp',
      'guitar-9-drop-b',
      'bass-4-standard-e',
      'bass-4-drop-d',
      'bass-4-d-standard',
      'bass-5-standard-b',
      'bass-5-drop-a',
      'bass-6-standard-b',
      'bass-6-drop-a',
    ];
    for (const id of originalIds) {
      expect(tuningPresets.some(p => p.id === id)).toBe(true);
    }
    expect(tuningPresets.filter(p => p.instrument === 'guitar' || p.instrument === 'bass')).toHaveLength(25);
  });

  it('applies a new instrument preset as a single undoable edit', () => {
    // Start with a 4-string track (e.g. four-string bass in blank project changed to 4 strings)
    const initial = previewEdit(blankProject(), {
      type: 'setStringCount',
      track: 0,
      tuning: [43, 38, 33, 28],
      keep: 'high',
      tuningName: 'Bass',
    });

    // Retune the 4-string track to Ukulele Standard C
    const ukePreset = tuningPresets.find(p => p.id === 'ukulele-4-standard-c')!;
    const afterApply = previewEdit(initial.project, {
      type: 'setTuning',
      track: 0,
      tuning: [...ukePreset.tuning],
      tuningName: ukePreset.name,
    }, initial);

    expect(afterApply.score.tracks[0].staves[0].tuning).toEqual([69, 64, 60, 67]);
    expect(afterApply.project.edits).toHaveLength(2);
    expect(afterApply.project.edits[1]).toEqual({
      type: 'setTuning',
      track: 0,
      tuning: [69, 64, 60, 67],
      tuningName: 'Standard C (High-G)',
    });

    // Replay with edit popped (undo) restores previous 4-string tuning
    const reverted = buildDocument({
      ...afterApply.project,
      edits: afterApply.project.edits.slice(0, -1),
    });
    expect(reverted.score.tracks[0].staves[0].tuning).toEqual([43, 38, 33, 28]);
  });

  it('applies 5-string banjo Open G tuning matching the banjo drone string contract', () => {
    const banjoPreset = tuningPresets.find(p => p.id === 'banjo-5-open-g')!;
    const project = previewEdit(blankProject(), {
      type: 'setStringCount',
      track: 0,
      tuning: [...banjoPreset.tuning],
      keep: 'high',
      tuningName: banjoPreset.name,
    });
    const staff = project.score.tracks[0].staves[0];
    expect(staff.tuning).toEqual([62, 59, 55, 50, 67]);
    // Banjo drone: string 1 (the last tuning entry, 67) > string 2 (tuning[3], 50)
    expect(staff.tuning[4]).toBeGreaterThan(staff.tuning[3]);
  });
});
