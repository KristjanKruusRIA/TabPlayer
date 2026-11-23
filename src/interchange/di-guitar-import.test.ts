import { model, Settings } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import type { TranscribedDiNote } from '../audio/di-transcribe';
import type { EditCommand } from '../edit-types';
import { buildDocument, previewEdit } from '../engine';
import { exportGpInterchange, loadInterchangeScore } from './gp';
import { buildImportClip } from './import-tracks';
import {
  defaultDiGuitarImportOptions,
  diImportFileName,
  extractScoreTempoMap,
  importDiGuitarNotes,
  secondsToTick,
  solveGuitarFingering,
} from './di-guitar-import';

const settings = new Settings();

const note = (
  pitch: number,
  startSec: number,
  endSec: number,
  palmMuteScore = 0,
  velocity = 95,
): TranscribedDiNote => ({
  pitch,
  startSec,
  endSec,
  onsetConfidence: 0.8,
  frameConfidence: 0.75,
  velocity,
  palmMuteScore,
  bendSemitones: 0,
});

const DROP_C = [62, 57, 53, 48, 43, 36] as const;
const STANDARD_E = [64, 59, 55, 50, 45, 40] as const;
const SEVEN_STRING_DROP_A = [64, 59, 55, 50, 45, 40, 33] as const;

function firstBeats(score: model.Score, trackIndex = 0) {
  return score.tracks[trackIndex].staves[0].bars.flatMap(bar =>
    bar.voices[0].beats.filter(beat => beat.notes.length > 0),
  );
}

describe('di-guitar-import', () => {
  it('fingers Drop C barre power chords and Standard E power chords idiomaticaly', () => {
    const dropCChords = [
      { start: 0, end: 120, keys: [36, 43, 48], voice: 0 }, // C2-G2-C3 (0-0-0)
      { start: 120, end: 240, keys: [38, 45, 50], voice: 0 }, // D2-A2-D3 (2-2-2)
    ];
    const dropCSolved = solveGuitarFingering(dropCChords, DROP_C, 0, 24, 'auto');
    expect(dropCSolved.unplayableCount).toBe(0);
    expect([...dropCSolved.placements.get(dropCChords[0])!.values()]).toEqual([
      { string: 1, fret: 0 },
      { string: 2, fret: 0 },
      { string: 3, fret: 0 },
    ]);
    expect([...dropCSolved.placements.get(dropCChords[1])!.values()]).toEqual([
      { string: 1, fret: 2 },
      { string: 2, fret: 2 },
      { string: 3, fret: 2 },
    ]);

    const stdEChords = [
      { start: 0, end: 120, keys: [40, 47, 52], voice: 0 }, // E5 (0-2-2)
      { start: 120, end: 240, keys: [43, 50, 55], voice: 0 }, // G5 (3-5-5)
    ];
    const stdESolved = solveGuitarFingering(stdEChords, STANDARD_E, 0, 24, 'auto');
    expect(stdESolved.unplayableCount).toBe(0);
    expect([...stdESolved.placements.get(stdEChords[0])!.values()]).toEqual([
      { string: 1, fret: 0 },
      { string: 2, fret: 2 },
      { string: 3, fret: 2 },
    ]);
    expect([...stdESolved.placements.get(stdEChords[1])!.values()]).toEqual([
      { string: 1, fret: 3 },
      { string: 2, fret: 5 },
      { string: 3, fret: 5 },
    ]);
  });

  it('keeps fretted hand anchor across open-string pedal notes and handles 7-string Drop A', () => {
    // Mid-position pedal riff on the A string (frets 7, 9, 10) separated by open low E (40).
    const pedalChords = [
      { start: 0, end: 60, keys: [52], voice: 0 }, // A str fret 7
      { start: 60, end: 120, keys: [40], voice: 0 }, // open low E
      { start: 120, end: 180, keys: [54], voice: 0 }, // A str fret 9
      { start: 180, end: 240, keys: [40], voice: 0 }, // open low E
      { start: 240, end: 300, keys: [56], voice: 0 }, // A str fret 11 (or G/D elsewhere)
    ];
    const midSolved = solveGuitarFingering(pedalChords, STANDARD_E, 0, 24, 'mid');
    expect(midSolved.placements.get(pedalChords[0])!.get(52)).toEqual({ string: 2, fret: 7 });
    expect(midSolved.placements.get(pedalChords[1])!.get(40)).toEqual({ string: 1, fret: 0 });
    expect(midSolved.placements.get(pedalChords[2])!.get(54)).toEqual({ string: 2, fret: 9 });
    expect(midSolved.placements.get(pedalChords[4])!.get(56)).toEqual({ string: 2, fret: 11 });

    const dropAChords = [{ start: 0, end: 120, keys: [33, 40, 45], voice: 0 }];
    const dropASolved = solveGuitarFingering(dropAChords, SEVEN_STRING_DROP_A, 0, 24, 'low');
    expect([...dropASolved.placements.get(dropAChords[0])!.values()]).toEqual([
      { string: 1, fret: 0 },
      { string: 2, fret: 0 },
      { string: 3, fret: 0 },
    ]);
  });

  it('respects low, mid, and high position preferences on single-note lines', () => {
    const line = [
      { start: 0, end: 60, keys: [52], voice: 0 }, // E3
      { start: 60, end: 120, keys: [54], voice: 0 }, // F#3
      { start: 120, end: 180, keys: [55], voice: 0 }, // G3
    ];
    const low = solveGuitarFingering(line, STANDARD_E, 0, 24, 'low');
    const mid = solveGuitarFingering(line, STANDARD_E, 0, 24, 'mid');
    const high = solveGuitarFingering(line, STANDARD_E, 0, 24, 'high');

    expect(low.placements.get(line[0])!.get(52)!.fret).toBeLessThanOrEqual(4);
    expect(mid.placements.get(line[0])!.get(52)).toEqual({ string: 2, fret: 7 });
    expect(high.placements.get(line[0])!.get(52)).toEqual({ string: 1, fret: 12 });
  });

  it('tags palm mutes according to detectPalmMutes and allowStringTechniques flags', () => {
    const input: TranscribedDiNote[] = [
      note(36, 0.0, 0.18, 0.82),
      note(36, 0.25, 0.43, 0.78),
      note(48, 0.5, 0.95, 0.08),
    ];

    const withPm = importDiGuitarNotes(input, {
      ...defaultDiGuitarImportOptions,
      bpm: 120,
      tuning: [...DROP_C],
      detectPalmMutes: true,
    });
    const pmBeats = firstBeats(withPm.score);
    expect(pmBeats.map(b => b.notes[0].isPalmMute)).toEqual([true, true, false]);
    expect(withPm.summary.palmMutedCount).toBe(2);

    const noTech = importDiGuitarNotes(input, {
      ...defaultDiGuitarImportOptions,
      bpm: 120,
      tuning: [...DROP_C],
      detectPalmMutes: true,
      allowStringTechniques: false,
    });
    expect(firstBeats(noTech.score).every(b => !b.notes[0].isPalmMute)).toBe(true);
    expect(noTech.summary.palmMutedCount).toBe(0);
  });

  it('aligns timestamps to an open project mixed-meter tempo map and supports Replace track + undo', () => {
    const project = {
      format: 'TabPlayer' as const,
      schemaVersion: 3 as const,
      engineVersion: '1.8.4' as const,
      base: {
        kind: 'blank' as const,
        title: 'Target Project',
        artist: '',
        tempo: 120,
        tuning: [...STANDARD_E],
        measureCount: 2,
      },
      assets: {},
      baselineEdits: [],
      edits: [
        // Bar 0 plays at 120 BPM (4/4 = 2.0s); shorten bar 1 to 3 beats before changing meter & tempo to 60 BPM.
        { type: 'deleteBeat', target: { track: 0, staff: 0, bar: 1, voice: 0, beat: 3 } },
        {
          type: 'setMeasureSettings',
          bar: 1,
          numerator: 3,
          denominator: 4,
          pickup: false,
          freeTime: false,
          repeatStart: false,
          repeatCount: 0,
          endings: [],
          section: '',
          tempos: [{ beat: 0, bpm: 60, linear: false }],
        },
      ] as EditCommand[],
    };
    const built = buildDocument(project);
    const tempoMap = extractScoreTempoMap(built.score);
    expect(secondsToTick(2.0, tempoMap)).toBeCloseTo(3840, 3); // end of bar 0 (4/4 at 120 BPM)
    expect(secondsToTick(3.0, tempoMap)).toBeCloseTo(3840 + 960, 3); // 1 beat into bar 1 at 60 BPM

    const targetBars = built.score.masterBars.map(mb => ({
      numerator: mb.timeSignatureNumerator,
      denominator: mb.timeSignatureDenominator,
    }));
    const diResult = importDiGuitarNotes(
      [
        note(40, 0.0, 0.45, 0.8),
        note(47, 0.0, 0.45, 0.8),
        note(45, 2.0, 2.95, 0.1), // beat 1 of bar 1 (2.0 s)
        note(50, 3.0, 3.95, 0.1), // beat 2 of bar 1 (3.0 s)
      ],
      {
        ...defaultDiGuitarImportOptions,
        tuning: [...STANDARD_E],
        targetBars,
        targetTempoMap: tempoMap,
      },
      'riff-take',
    );
    expect(diResult.score.masterBars.length).toBe(2);
    expect(diResult.score.masterBars[1].timeSignatureNumerator).toBe(3);

    const clip = buildImportClip(diResult.score);
    const edited = previewEdit(project, { type: 'importTracks', clip, targetTrack: 0 }, built);
    expect(edited.score.masterBars.length).toBe(2);
    expect(edited.score.masterBars[1].timeSignatureNumerator).toBe(3);
    const bar0Notes = edited.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
    expect(bar0Notes.map(n => [n.string, n.fret, n.isPalmMute])).toEqual([
      [1, 0, true],
      [2, 2, true],
    ]);
    const bar1Beats = edited.score.tracks[0].staves[0].bars[1].voices[0].beats;
    expect(bar1Beats[0].notes[0].realValue).toBe(45);
    expect(bar1Beats[1].notes[0].realValue).toBe(50);

    const gpBytes = exportGpInterchange(edited.score, settings);
    const gpReloaded = loadInterchangeScore(gpBytes, settings);
    expect(gpReloaded.masterBars.length).toBe(2);
    expect(gpReloaded.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].isPalmMute).toBe(true);

    // Undo (replay without the importTracks edit) restores original empty bars.
    const undone = buildDocument(project);
    expect(undone.score.tracks[0].staves[0].bars[0].voices[0].beats.every(b => b.notes.length === 0)).toBe(true);
  });

  it('allows open-string drone pairings with high fretted notes on custom Drop D1 tuning', () => {
    const DROP_D1 = [52, 47, 43, 38, 33, 26] as const;
    // Open D2 (38, s3f0) paired with high-fret 7th+ dyad [54, 59] (s5f7 + s6f7) must keep string 3 open (fret 0).
    const chords = [
      { start: 0, end: 120, keys: [38, 54, 59], voice: 0 },
      { start: 120, end: 240, keys: [38, 53, 58], voice: 0 },
    ];
    const solved = solveGuitarFingering(chords, DROP_D1, 0, 24, 'auto');
    expect(solved.unplayableCount).toBe(0);
    const p0 = solved.placements.get(chords[0])!;
    expect(p0.get(38)).toEqual({ string: 3, fret: 0 });
    expect(p0.get(54)).toEqual({ string: 5, fret: 7 });
    expect(p0.get(59)).toEqual({ string: 6, fret: 7 });
    const p1 = solved.placements.get(chords[1])!;
    expect(p1.get(38)).toEqual({ string: 3, fret: 0 });
    expect(p1.get(53)).toEqual({ string: 5, fret: 6 });
    expect(p1.get(58)).toEqual({ string: 6, fret: 6 });
  });

  it('counts unplayable notes beyond maxFret and sanitizes exported filename', () => {
    const res = importDiGuitarNotes(
      [note(40, 0.0, 0.4), note(108, 0.5, 0.9)],
      { ...defaultDiGuitarImportOptions, maxFret: 24 },
      'riff',
    );
    expect(res.summary.notesCount).toBe(1);
    expect(res.summary.notes).toContainEqual({ code: 'unplayable_notes', count: 1 });
    expect(diImportFileName('C:\\takes\\chug/01*.wav')).toBe('C takes chug 01.gp');
  });
});
