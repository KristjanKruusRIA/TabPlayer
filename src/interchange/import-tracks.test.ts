import { describe, expect, it } from 'vitest';
import { exporter, model, Settings } from '@coderline/alphatab';
import { usedDrumSounds, withDrumMap } from '../audio/drum-map';
import { defaultEffects, defaultMix } from '../document-settings';
import type { EditCommand } from '../edit-types';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { exportGpInterchange, loadInterchangeScore } from './gp';
import { buildImportClip, prepareImportTracks } from './import-tracks';
import { importMidi } from './midi-import';
import { readMidiFile } from './midi-smf';

type Ev = [number, number[]];
const vlq = (value: number) => {
  const out = [value & 0x7f];
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
};
const track = (events: Ev[]) => {
  const body = events.flatMap(([delta, data]) => [...vlq(delta), ...data]);
  body.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
};
const file = (format: number, division: number, tracks: number[][]) =>
  new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 255, ...tracks.flat()]);
const line = (notes: [number, number, number][], channel = 0): Ev[] => {
  const events = notes
    .flatMap(([start, length, key]) => [[start, [0x90 | channel, key, 90]], [start + length, [0x80 | channel, key, 0]]] as [number, number[]][])
    .sort((a, b) => a[0] - b[0] || (a[1][0] & 0xf0) - (b[1][0] & 0xf0));
  let last = 0;
  return events.map(([at, data]) => {
    const delta = at - last;
    last = at;
    return [delta, data] as Ev;
  });
};

const settings = new Settings();

describe('importTracks', () => {
  it('appends percussion and melodic tracks, pads shorter imports, extends measures when longer, and replays undo/redo', () => {
    // Base project starts with 4 measures of 4/4.
    const base = blankProject();
    const built0 = buildDocument(base);
    expect(built0.score.masterBars).toHaveLength(4);

    // Import 1 bass track + 1 drum track across 5 bars of 4/4 (longer than base's 4 bars).
    const midi = file(1, 480, [
      track([[0, [0xc0, 33]], ...line([[0, 480, 40]], 0)]),
      track(line([[0, 60, 36], [1920, 60, 38], [7680, 60, 42]], 9)),
    ]);
    const imported = importMidi(readMidiFile(midi), {
      quantization: 16,
      tuplets: 'triplets',
      voices: 2,
      tablature: true,
    });
    const clip = buildImportClip(imported.score);

    const next = previewEdit(base, { type: 'importTracks', clip }, built0);
    expect(next.score.tracks).toHaveLength(3);
    expect(next.score.masterBars).toHaveLength(5);
    expect(next.score.tracks[1].playbackInfo.program).toBe(33);
    expect(next.score.tracks[1].playbackInfo.primaryChannel).not.toBe(9);
    expect(next.score.tracks[2].isPercussion).toBe(true);
    expect(next.score.tracks[2].playbackInfo.primaryChannel).toBe(9);
    // Original track's appended 5th bar is filled cleanly to match bar duration.
    const bar4Ticks = next.score.tracks[0].staves[0].bars[4].voices[0].beats.reduce((s, b) => s + b.playbackDuration, 0);
    expect(bar4Ticks).toBe(next.score.masterBars[4].calculateDuration());

    // Round-trip project JSON rebuild & undo.
    const rebuilt = buildDocument(JSON.parse(JSON.stringify(next.project)));
    expect(rebuilt.score.tracks).toHaveLength(3);
    expect(rebuilt.score.masterBars).toHaveLength(5);
    const undone = buildDocument({ ...next.project, edits: next.project.edits.slice(0, -1) });
    expect(undone.score.tracks).toHaveLength(1);
    expect(undone.score.masterBars).toHaveLength(4);
  });

  it('pads shorter appended tracks with rests to match a longer destination score', () => {
    const base = blankProject();
    const built0 = buildDocument(base);
    expect(built0.score.masterBars).toHaveLength(4);

    const midi = file(0, 480, [track(line([[0, 60, 36]], 9))]);
    const imported = importMidi(readMidiFile(midi), {
      quantization: 16,
      tuplets: 'triplets',
      voices: 2,
      tablature: true,
    });
    const next = previewEdit(base, { type: 'importTracks', clip: buildImportClip(imported.score) }, built0);
    expect(next.score.tracks).toHaveLength(2);
    expect(next.score.masterBars).toHaveLength(4);
    for (let bar = 0; bar < 4; bar++) {
      const ticks = next.score.tracks[1].staves[0].bars[bar].voices[0].beats.reduce((s, b) => s + b.playbackDuration, 0);
      expect(ticks).toBe(next.score.masterBars[bar].calculateDuration());
    }
  });

  it('replaces a GP-style percussion track preserving its native articulation table, identity, mix, drumMap, sound and GP round-trip', () => {
    // Build a GP7/GP8-style base score with a Guitar track and an empty Drumkit track that carries a full GP percussionArticulations table.
    const template = new model.Score();
    template.title = 'Template';
    for (const [num, den] of [[4, 4], [5, 4], [3, 4]] as const) {
      const mb = new model.MasterBar();
      mb.timeSignatureNumerator = num;
      mb.timeSignatureDenominator = den;
      template.addMasterBar(mb);
    }
    const guitar = new model.Track();
    guitar.name = 'Guitar';
    const gStaff = new model.Staff();
    gStaff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
    gStaff.showTablature = true;
    for (let i = 0; i < 3; i++) {
      const bar = new model.Bar();
      const voice = new model.Voice();
      const beat = new model.Beat();
      beat.duration = model.Duration.Whole;
      voice.addBeat(beat);
      bar.addVoice(voice);
      gStaff.addBar(bar);
    }
    guitar.addStaff(gStaff);
    template.addTrack(guitar);

    const drums = new model.Track();
    drums.name = 'Drumkit';
    drums.playbackInfo.primaryChannel = 9;
    drums.playbackInfo.secondaryChannel = 9;
    const dStaff = new model.Staff();
    dStaff.isPercussion = true;
    dStaff.showStandardNotation = true;
    for (let i = 0; i < 3; i++) {
      const bar = new model.Bar();
      bar.clef = model.Clef.Neutral;
      const voice = new model.Voice();
      const beat = new model.Beat();
      beat.duration = model.Duration.Whole;
      voice.addBeat(beat);
      bar.addVoice(voice);
      dStaff.addBar(bar);
    }
    drums.addStaff(dStaff);
    template.addTrack(drums);
    template.finish(settings);

    const gpBytes = new exporter.Gp7Exporter().export(template, settings);
    const sha256 = 'a'.repeat(64);
    const drumId = 'base/1';
    const customSound = { voiceId: null, presetId: 'gm' as const, effects: defaultEffects(), drumKit: 32 };
    const customMix = withDrumMap({ ...defaultMix(), gain: 0.8 }, { preset: 'ezdrummer-3', keys: [[38, 40]] });
    const baseProject = {
      format: 'TabPlayer' as const,
      schemaVersion: 3 as const,
      engineVersion: '1.8.4' as const,
      base: {
        kind: 'file' as const,
        filename: 'template.gp',
        bytesBase64: Buffer.from(gpBytes).toString('base64'),
        sha256,
      },
      baselineEdits: [],
      edits: [
        { type: 'setTrackSound', trackId: drumId, sound: customSound },
        { type: 'setTrackMix', trackId: drumId, mix: customMix },
      ] as EditCommand[],
      assets: {},
    };

    const built0 = buildDocument(baseProject);
    const origTableLen = built0.score.tracks[1].percussionArticulations.length;
    expect(origTableLen).toBeGreaterThan(90);

    // Import channel-0 drum MIDI aligned to template's 4/4, 5/4, 3/4 measures.
    const midi = file(0, 480, [
      track(line([
        [0, 60, 36],       // bar 0 (4/4: 0..1920)
        [1920, 60, 38],    // bar 1 (5/4: 1920..4320)
        [4320, 60, 49],    // bar 2 (3/4: 4320..5760)
      ], 0)),
    ]);
    const targetBars = built0.score.masterBars.map(mb => ({
      numerator: mb.timeSignatureNumerator,
      denominator: mb.timeSignatureDenominator,
    }));
    const imported = importMidi(readMidiFile(midi), {
      quantization: 16,
      tuplets: 'triplets',
      voices: 2,
      tablature: true,
      drumParts: [0],
      selectedParts: [0],
      targetBars,
    });
    const clip = buildImportClip(imported.score);

    const next = previewEdit(baseProject, { type: 'importTracks', clip, targetTrack: 1 }, built0);
    expect(next.score.tracks).toHaveLength(2);
    expect(next.score.masterBars).toHaveLength(3);
    const replacedDrums = next.score.tracks[1];
    expect(replacedDrums.name).toBe('Drumkit');
    expect(trackIdentity(replacedDrums)).toBe(drumId);
    expect(replacedDrums.percussionArticulations).toHaveLength(origTableLen);
    expect(usedDrumSounds(replacedDrums)).toEqual([36, 38, 49]);
    expect(next.settings.sounds[drumId]).toEqual(customSound);
    expect(next.settings.mixes[drumId]).toEqual(customMix);

    // Verify GP export & reload preserves the drum notes cleanly.
    const exported = exportGpInterchange(next.score, settings);
    const reloaded = loadInterchangeScore(exported, settings);
    expect(usedDrumSounds(reloaded.tracks[1])).toEqual([36, 38, 49]);

    // Verify undo returns Drumkit to empty.
    const undone = buildDocument({ ...next.project, edits: next.project.edits.slice(0, -1) });
    expect(usedDrumSounds(undone.score.tracks[1])).toEqual([]);
  });

  it('replaces a melodic track and re-fingers notes onto the destination tuning', () => {
    const base = {
      ...blankProject(),
      edits: [{ type: 'setTuning', track: 0, tuning: [62, 57, 53, 48, 43, 38] }] as EditCommand[],
    };
    const built0 = buildDocument(base);
    // MIDI guitar note E2 (40): on D-standard tuning [38=D2 lowest string], E2 is fret 2 on string 6!
    const midi = file(0, 480, [track([[0, [0xc0, 25]], ...line([[0, 480, 40]], 0)])]);
    const imported = importMidi(readMidiFile(midi), {
      quantization: 16,
      tuplets: 'triplets',
      voices: 2,
      tablature: true,
    });
    const next = previewEdit(base, { type: 'importTracks', clip: buildImportClip(imported.score), targetTrack: 0 }, built0);
    const note = next.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(note.realValue).toBe(40);
    expect(note.string).toBe(1);
    expect(note.fret).toBe(2);
  });

  it('refuses mismatched track types, invalid targetTrack, multi-track replace and mismatched meters', () => {
    const built = buildDocument(blankProject());
    const drumScore = importMidi(readMidiFile(file(0, 480, [track(line([[0, 60, 36]], 9))]))).score;
    const drumClip = buildImportClip(drumScore);
    // Replacing melodic track 0 with percussion clip
    expect(() => prepareImportTracks(built.score, { type: 'importTracks', clip: drumClip, targetTrack: 0 })).toThrow(/match the target track type/i);
    // Out-of-range targetTrack
    expect(() => prepareImportTracks(built.score, { type: 'importTracks', clip: drumClip, targetTrack: 9 })).toThrow(/existing track/i);

    // Multi-track clip on replace
    const multiScore = importMidi(readMidiFile(file(1, 480, [track(line([[0, 480, 60]], 0)), track(line([[0, 60, 36]], 9))]))).score;
    expect(() => prepareImportTracks(built.score, { type: 'importTracks', clip: buildImportClip(multiScore), targetTrack: 0 })).toThrow(/one imported track/i);

    // Mismatched bar duration (3/4 imported clip against 4/4 destination)
    const threeFour = importMidi(readMidiFile(file(1, 480, [track([[0, [0xff, 0x58, 4, 3, 2, 24, 8]]]), track(line([[0, 480, 60]], 0))]))).score;
    expect(() => prepareImportTracks(built.score, { type: 'importTracks', clip: buildImportClip(threeFour) })).toThrow(/meter/i);
  });

  it('produces compact default-stripped scoreJson in buildImportClip while round-tripping identically', () => {
    const midi = file(0, 480, [track([[0, [0xc0, 29]], ...line([[0, 240, 40], [240, 480, 47], [480, 720, 52], [720, 960, 55]], 0)])]);
    const imported = importMidi(readMidiFile(midi), {
      quantization: 16,
      tuplets: 'none',
      voices: 1,
      tablature: true,
    });
    const fullJson = model.JsonConverter.scoreToJson(imported.score);
    const clip = buildImportClip(imported.score);
    expect(clip.scoreJson.length).toBeLessThan(fullJson.length * 0.45);
    expect(clip.scoreJson).not.toContain('"displaystart"');
    expect(clip.scoreJson).not.toContain('"islefthandtapped"');

    const base = blankProject();
    const built0 = buildDocument(base);
    const next = previewEdit(base, { type: 'importTracks', clip }, built0);
    const notes = next.score.tracks[1].staves[0].bars[0].voices[0].beats.flatMap(b => b.notes.map(n => n.realValue));
    expect(notes).toEqual([40, 47, 52, 55]);
  });
});
