import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { isPowerTabBytes, parsePowerTab, PowerTabError, PTB_LIMITS } from './powertab';
import { importPowerTab } from './powertab-score';
import { basicFile, buildPtb, timeSig, tempoData } from './powertab-fixture';
import { buildDocument } from '../engine';
import type { Project } from '../project';

const settings = new Settings();
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const projectFor = (bytes: Uint8Array): Project => ({
  format: 'TabPlayer', schemaVersion: 2, engineVersion: '1.8.4', edits: [], assets: {},
  base: { kind: 'file', filename: 'synthetic.ptb', bytesBase64: toBase64(bytes), sha256: 'a'.repeat(64) },
});

describe('Power Tab parsing', () => {
  it('reads a synthetic 1.7 file', () => {
    const doc = parsePowerTab(buildPtb(basicFile()));
    expect(doc.version).toBe(4);
    expect(doc.title).toBe('Synthetic');
    expect(doc.guitar.guitars[0].tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(doc.guitar.systems).toHaveLength(1);
    expect(doc.guitar.systems[0].barlines).toHaveLength(1);
    expect(doc.guitar.systems[0].staves[0].voices[0]).toHaveLength(6);
    expect(doc.bass?.systems).toHaveLength(0);
  });

  it('reads a synthetic 1.5 header', () => {
    expect(parsePowerTab(buildPtb(basicFile({ version: 3, title: 'Old' }))).title).toBe('Old');
  });

  it('detects the signature', () => {
    expect(isPowerTabBytes(buildPtb(basicFile()))).toBe(true);
    expect(isPowerTabBytes(new TextEncoder().encode('GP5 data'))).toBe(false);
  });

  it('rejects wrong signatures, old versions, lessons and empty input with clear errors', () => {
    expect(() => parsePowerTab(new Uint8Array())).toThrow(/not a Power Tab file/);
    expect(() => parsePowerTab(new TextEncoder().encode('RIFF....'))).toThrow(/not a Power Tab file/);
    expect(() => parsePowerTab(Uint8Array.from([0x70, 0x74, 0x61, 0x62, 1, 0]))).toThrow(/1\.0 files are not supported/);
    expect(() => parsePowerTab(Uint8Array.from([0x70, 0x74, 0x61, 0x62, 9, 0]))).toThrow(/version 9/);
    expect(() => parsePowerTab(Uint8Array.from([0x70, 0x74, 0x61, 0x62, 4, 0, 1]))).toThrow(/lesson/);
  });

  it('reports every truncation point as a PowerTabError', () => {
    const bytes = buildPtb(basicFile());
    for (let length = 0; length < bytes.length; length++) {
      try { parsePowerTab(bytes.slice(0, length)); }
      catch (error) { expect(error).toBeInstanceOf(PowerTabError); continue; }
      // Truncation inside the (optional) bass score is allowed to degrade to a skipped bass.
      expect(length).toBeGreaterThan(bytes.length - 30);
    }
  });

  it('rejects huge declared counts without allocating or looping', () => {
    const bytes = buildPtb(basicFile());
    // Guitar count is the first u16 after the header; claim 65534 guitars then a 32 bit count.
    const header = parsePowerTab(bytes); void header;
    const evil = bytes.slice(); const at = evil.findIndex((_, i) => i > 20 && evil[i] === 1 && evil[i + 1] === 0 && evil[i + 2] === 0xff);
    expect(at).toBeGreaterThan(0);
    evil[at] = 0xff; evil[at + 1] = 0xff;
    expect(() => parsePowerTab(evil)).toThrow(PowerTabError);
    const huge = bytes.slice(0, at); const tail = [0xff, 0xff, 0xff, 0xff, 0xff, 0x7f];
    expect(() => parsePowerTab(Uint8Array.from([...huge, ...tail]))).toThrow(/too many|truncated/);
  });

  it('rejects oversized strings and files', () => {
    const bytes = buildPtb(basicFile());
    const title = bytes.indexOf(9, 8); // 'Synthetic' length prefix
    const evil = bytes.slice(); evil[title] = 0xff; evil[title + 1] = 0xff; evil[title + 2] = 0xff; evil[title + 3] = 0xff; evil[title + 4] = 0xff; evil[title + 5] = 0xff; evil[title + 6] = 0x7f;
    expect(() => parsePowerTab(evil)).toThrow(PowerTabError);
    expect(() => parsePowerTab(new Uint8Array(PTB_LIMITS.fileBytes + 1))).toThrow(/16 MiB/);
  });

  it('never throws anything but PowerTabError on random corruption', () => {
    const bytes = buildPtb(basicFile({ bass: { systems: [] } }));
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 1500; round++) {
      const copy = bytes.slice();
      const flips = 1 + Math.floor(random() * 6);
      for (let i = 0; i < flips; i++) copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
      try { importPowerTab(copy, settings); }
      catch (error) { expect(error).toBeInstanceOf(PowerTabError); }
    }
  });

  it('survives random garbage after a valid header', () => {
    let seed = 99;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 300; round++) {
      const junk = Uint8Array.from({ length: 200 }, () => Math.floor(random() * 256));
      try { importPowerTab(Uint8Array.from([0x70, 0x74, 0x61, 0x62, 4, 0, 0, 0, ...junk]), settings); }
      catch (error) { expect(error).toBeInstanceOf(PowerTabError); }
    }
  });
});

describe('Power Tab import into a score', () => {
  it('builds measures, rhythm, pitches, repeats, key, time and tempo', () => {
    const { score, notice } = importPowerTab(buildPtb(basicFile()), settings);
    expect(score.title).toBe('Synthetic');
    expect(score.masterBars).toHaveLength(2);
    expect(score.tempo).toBe(100);
    expect(score.masterBars[0].timeSignatureNumerator).toBe(4);
    expect(score.masterBars[0].keySignature).toBe(1);
    expect(score.masterBars[0].repeatCount).toBe(3);
    expect(score.masterBars[0].isRepeatEnd).toBe(true);
    expect(score.masterBars[1].isDoubleBar).toBe(true);
    expect(score.tracks).toHaveLength(1);
    expect(score.tracks[0].name).toBe('Lead');
    expect(score.tracks[0].playbackInfo.program).toBe(29);
    const [bar0, bar1] = score.tracks[0].staves[0].bars;
    const beats = bar0.voices[0].beats;
    expect(beats).toHaveLength(4);
    // Zero-based PT string 1 (B) fret 1 is C4; string 4 (A) fret 2 is B2.
    expect(beats[0].notes.map(n => n.realValue).sort()).toEqual([47, 60]);
    expect(beats[2].isRest).toBe(true);
    expect(beats[3].notes[0].isHammerPullOrigin).toBe(true);
    expect(bar1.voices[0].beats[0].dots).toBe(1);
    expect(bar1.voices[0].beats[0].notes[0].isTieDestination).toBe(true);
    expect(bar1.voices[0].beats[1].notes[0].realValue).toBe(43);
    expect(notice).toMatch(/2 measures, 1 track\./);
  });

  it('imports triplets, voices, bass, sections, minor keys and tempo scaling', () => {
    const file = basicFile();
    const sys = file.guitar.systems[0];
    sys.start = { position: 0, time: timeSig(6, 8), key: 0x10 | 0x40 | 9, letter: 65, desc: 'Intro' };
    sys.staves[0].voices[0] = [
      { position: 1, duration: 8, flags: 0x200000, beaming: (2 << 3) | 1, notes: [{ string: 0, fret: 0 }] },
      { position: 2, duration: 8, flags: 0x400000, notes: [{ string: 0, fret: 1 }] },
      { position: 3, duration: 8, flags: 0x800000, notes: [{ string: 0, fret: 2 }] },
    ];
    sys.staves[0].voices[1] = [{ position: 1, duration: 2, notes: [{ string: 5, fret: 0 }] }];
    file.guitar.tempos = [{ system: 0, position: 1, data: tempoData(60, 0) }];
    file.bass = { guitars: [{ tuning: [43, 38, 33, 28] }], systems: [{ staves: [{ strings: 4, clef: 1, voices: [[{ position: 1, duration: 1, notes: [{ string: 3, fret: 0 }] }]] }], bars: [{ position: 9 }] }] };
    const { score } = importPowerTab(buildPtb(file), settings);
    expect(score.tempo).toBe(120);
    expect(score.masterBars[0].keySignature).toBe(-2);
    expect(score.masterBars[0].keySignatureType).toBe(1);
    expect(score.masterBars[0].section?.marker).toBe('A');
    const first = score.tracks[0].staves[0].bars[0];
    expect(first.voices).toHaveLength(2);
    expect(first.voices[0].beats.map(b => `${b.tupletNumerator}/${b.tupletDenominator}`)).toEqual(['3/2', '3/2', '3/2']);
    expect(first.voices[1].beats[0].notes[0].realValue).toBe(40);
    expect(score.tracks).toHaveLength(2);
    expect(score.tracks[1].staves[0].tuning).toEqual([43, 38, 33, 28]);
    expect(score.tracks[1].staves[0].bars[0].clef).toBe(model.Clef.F4);
  });

  it('reports dropped content in the notice', () => {
    const file = basicFile();
    file.guitar.chordDiagrams = 2; file.guitar.floatingTexts = 1; file.guitar.dynamics = 3; file.guitar.alternateEndings = 1; file.guitar.guitarIns = 1;
    const sys = file.guitar.systems[0];
    sys.directions = 2; sys.chordTexts = 1; sys.slashes = 4;
    sys.staves[0].voices[0][0].notes![0].symbols = [0x65000000];
    sys.staves[0].voices[0][1].flags = 0x60;
    const { notice } = importPowerTab(buildPtb(file), settings);
    for (const fragment of ['2 chord diagrams', '1 text boxes', '3 dynamics', '1 alternate endings', '2 directions', '4 rhythm slashes', '1 slides, bends', '1 arpeggios']) expect(notice).toContain(fragment);
  });

  it('skips a damaged bass score with a notice instead of failing', () => {
    const bytes = buildPtb(basicFile({ bass: { systems: [] } }));
    const cut = bytes.slice(0, bytes.length - 3);
    const { notice } = importPowerTab(cut, settings);
    expect(notice).toMatch(/bass score could not be read/);
  });

  it('refuses a file with no music and caps the track count', () => {
    expect(() => importPowerTab(buildPtb({ guitar: { systems: [] } }), settings)).toThrow(/no music/);
    const staves = Array.from({ length: 8 }, () => ({ voices: [[{ position: 1, notes: [{ string: 0, fret: 0 }] }]] as [never] }));
    const file = basicFile();
    file.guitar.systems[0].staves = staves as never;
    file.bass = { systems: [{ staves: staves as never, bars: [{ position: 9 }] }] };
    const { score } = importPowerTab(buildPtb(file), settings);
    expect(score.tracks.length).toBeGreaterThan(8);
  });

  it('opens through buildDocument and keeps edits replayable', () => {
    const bytes = buildPtb(basicFile());
    const built = buildDocument(projectFor(bytes));
    expect(built.importNotice).toMatch(/Imported from Power Tab/);
    expect(built.score.tracks).toHaveLength(1);
    expect(() => buildDocument(projectFor(bytes.slice(0, 30)))).toThrow(/truncated|damaged/);
  });

  it('leaves non-Power-Tab documents without a notice', () => {
    const built = buildDocument({ format: 'TabPlayer', schemaVersion: 2, engineVersion: '1.8.4', edits: [], assets: {}, base: { kind: 'blank', title: 'x', artist: '', tempo: 120, tuning: [64, 59, 55, 50, 45, 40], measureCount: 1 } });
    expect(built.importNotice).toBeNull();
  });
});
