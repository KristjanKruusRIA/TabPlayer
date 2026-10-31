import { describe, expect, it } from 'vitest';
import { midi, model, Settings } from '@coderline/alphatab';
import { isTablEditBytes, parseTablEdit, TablEditError, TEF_LIMITS } from './tabledit';
import { importTablEdit } from './tabledit-score';
import { basicTef, buildTef, durationCode, TEF_OFFSETS, type TefFx } from './tabledit-fixture';
import { buildDocument } from '../engine';
import { adoptAdmittedBase, admitDocumentBase } from '../interchange/archive-gate';
import type { Project } from '../project';

// Every fixture here is synthetic: written by tabledit-fixture.ts from the layout the importer assumes. No real .tef was tested.
const settings = new Settings();
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const projectFor = (bytes: Uint8Array, sha = 'b'.repeat(64)): Project => ({
  format: 'TabPlayer', schemaVersion: 3, engineVersion: '1.8.4', edits: [], baselineEdits: [], assets: {},
  base: { kind: 'file', filename: 'synthetic.tef', bytesBase64: toBase64(bytes), sha256: sha },
});
const beatsOf = (score: model.Score, bar = 0, voice = 0, track = 0) => score.tracks[track].staves[0].bars[bar].voices[voice].beats;

function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }

describe('TablEdit parsing', () => {
  it('reads a synthetic file', () => {
    const doc = parseTablEdit(buildTef(basicTef()));
    expect(doc.tempo).toBe(100);
    expect(doc.title).toBe('Synthetic');
    expect(doc.copyright).toBe('(c) fixture');
    expect(doc.measures).toHaveLength(2);
    expect(doc.instruments[0].tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(doc.instruments[0].name).toBe('Guitar');
    expect(doc.events).toHaveLength(8);
    expect(doc.events[0]).toMatchObject({ position: 0, string: 0, fret: 1, kind: 'note' });
    expect(doc.events[1]).toMatchObject({ position: 0, string: 3, fret: 2 });
    expect(doc.events[3]).toMatchObject({ position: 32, kind: 'rest' });
    expect(doc.events[5].tie).toBe(true);
  });

  it('detects content by the tbed marker, not by extension or byte 0', () => {
    const bytes = buildTef(basicTef());
    expect(isTablEditBytes(bytes)).toBe(true);
    expect(isTablEditBytes(bytes.slice(0, 0x3b))).toBe(false);
    expect(isTablEditBytes(new TextEncoder().encode('GP5 data'))).toBe(false);
    expect(isTablEditBytes(new Uint8Array(200))).toBe(false);
    expect(bytes[0]).not.toBe(0x74);
  });

  it('refuses wrong, protected, reversed, old and damaged files with clear messages', () => {
    expect(() => parseTablEdit(new Uint8Array())).toThrow(/not a TablEdit file/);
    expect(() => parseTablEdit(new Uint8Array(0x100))).toThrow(/missing "tbed"/);
    expect(() => parseTablEdit(buildTef({ reversedTbed: true }))).toThrow(/byte-swapped/);
    expect(() => parseTablEdit(buildTef({ securityCode: 5 }))).toThrow(/Protected/);
    expect(() => parseTablEdit(buildTef({ formatHigh: 8 }))).toThrow(/version is not supported/);
    expect(() => parseTablEdit(buildTef({ oldNum: 3 }))).toThrow(/version is not supported/);
    expect(() => parseTablEdit(buildTef({ instruments: [{ strings: 0 }] }))).toThrow(/0 strings/);
    expect(() => parseTablEdit(buildTef({ instruments: [{ strings: 13 }] }))).toThrow(/13 strings/);
    expect(() => parseTablEdit(buildTef({ measures: [] }))).toThrow(/no measures/);
    expect(() => parseTablEdit(buildTef({ ...basicTef(), noSentinel: true }))).toThrow(/truncated/);
    const outside = buildTef(basicTef());
    new DataView(outside.buffer).setUint32(TEF_OFFSETS.measures, outside.length + 10, true);
    expect(() => parseTablEdit(outside)).toThrow(/pointer lies outside/);
    const bad = buildTef(basicTef());
    bad[0xd0 + 30] = 0xff; // corrupt something past the header; must still be a TablEditError or succeed
    try { parseTablEdit(bad); } catch (error) { expect(error).toBeInstanceOf(TablEditError); }
  });

  it('reports every truncation point as a TablEditError', () => {
    const bytes = buildTef(basicTef({ readingList: [[1, 2]], texts: ['x'] }));
    for (let length = 0; length < bytes.length; length++) {
      expect(() => parseTablEdit(bytes.slice(0, length))).toThrow(TablEditError);
    }
  });

  it('fuzzes past the signature: random corruption only ever raises TablEditError, and most rounds get beyond the header', () => {
    const valid = buildTef(basicTef({ readingList: [[1, 1], [1, 1]], instruments: [{}, { strings: 4, tuning: [43, 38, 33, 28] }], texts: ['a'] }));
    const random = prng(7);
    let pastHeader = 0;
    for (let round = 0; round < 1500; round++) {
      const bytes = valid.slice();
      const hits = 1 + Math.floor(random() * 6);
      for (let k = 0; k < hits; k++) {
        const at = 0x40 + Math.floor(random() * (bytes.length - 0x40)); // never touches the tbed marker
        bytes[at] = Math.floor(random() * 256);
      }
      expect(isTablEditBytes(bytes)).toBe(true);
      try {
        const doc = parseTablEdit(bytes);
        pastHeader++;
        importTablEdit(bytes, settings);
        expect(doc.measures.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(TablEditError);
        expect((error as Error).message).not.toMatch(/missing "tbed"|not a TablEdit file/);
      }
    }
    expect(pastHeader).toBeGreaterThan(300);
    // Random garbage that carries only the marker must also fail cleanly.
    for (let round = 0; round < 300; round++) {
      const bytes = new Uint8Array(0x100 + Math.floor(random() * 300)).map(() => Math.floor(random() * 256));
      bytes.set([0x74, 0x62, 0x65, 0x64], TEF_OFFSETS.tbed);
      try { importTablEdit(bytes, settings); } catch (error) { expect(error).toBeInstanceOf(TablEditError); }
    }
  });

  it('rejects huge declared counts without allocating or looping', () => {
    const bytes = buildTef(basicTef());
    const view = new DataView(bytes.buffer);
    const measures = view.getUint32(TEF_OFFSETS.measures, true);
    view.setUint16(measures + 2, 65535, true);
    expect(() => parseTablEdit(bytes)).toThrow(/too many measures/);
    const instruments = buildTef(basicTef());
    const iv = new DataView(instruments.buffer);
    iv.setUint16(iv.getUint32(TEF_OFFSETS.instruments, true) + 2, 40, true);
    expect(() => parseTablEdit(instruments)).toThrow(/too many instruments/);
    const stride = buildTef(basicTef());
    const sv = new DataView(stride.buffer);
    sv.setUint16(sv.getUint32(TEF_OFFSETS.instruments, true), 65535, true);
    expect(() => parseTablEdit(stride)).toThrow(/truncated or damaged/);
    expect(() => parseTablEdit(new Uint8Array(TEF_LIMITS.fileBytes + 1))).toThrow(/16 MiB/);
  });

  it('caps the number of events before building anything', () => {
    const events = Array.from({ length: TEF_LIMITS.events + 1 }, (_, i) => ({ position: i % 100, string: 1 + (i % 6), fret: 0 }));
    const bytes = buildTef({ events });
    expect(bytes.length).toBeLessThan(2_000_000);
    expect(() => parseTablEdit(bytes)).toThrow(/too large to import safely/);
    expect(() => importTablEdit(bytes, settings)).toThrow(/too large to import safely/);
  });

  it('refuses tracks x measures that would exhaust memory', () => {
    const measures = Array.from({ length: 4000 }, () => ({ num: 4, den: 4 }));
    const instruments = Array.from({ length: 4 }, () => ({}));
    const events = instruments.map((_, i) => ({ position: 0, string: 1 + i * 6, fret: 0 }));
    expect(() => importTablEdit(buildTef({ measures, instruments, events }), settings)).toThrow(/too large to import safely/);
  });
});

describe('TablEdit conversion', () => {
  it('keeps strings the right way up: string 1 is the highest, pitches follow the tuning', () => {
    const file = basicTef({
      events: [
        { position: 0, string: 1, fret: 0 }, { position: 16, string: 6, fret: 0 }, { position: 32, string: 2, fret: 5 }, { position: 48, string: 5, fret: 3 },
      ],
    });
    const { score } = importTablEdit(buildTef(file), settings);
    expect(score.tracks[0].staves[0].tuning).toEqual([64, 59, 55, 50, 45, 40]);
    const beats = beatsOf(score);
    expect(beats.map(b => b.notes[0].realValue)).toEqual([64, 40, 64, 48]);
    expect(beats[0].notes[0].string).toBe(6);
    expect(beats[1].notes[0].string).toBe(1);
  });

  it('uses the second instrument strings, tuning, program, capo and a bass clef', () => {
    const file = basicTef({
      instruments: [{ name: 'Lead', midi: 29 }, { strings: 4, midi: 33, capo: 2, name: 'Bass', tuning: [43, 38, 33, 28] }],
      events: [{ position: 0, string: 1, fret: 0 }, { position: 0, string: 7, fret: 0 }, { position: 0, string: 10, fret: 3 }],
    });
    const { score } = importTablEdit(buildTef(file), settings);
    expect(score.tracks).toHaveLength(2);
    expect(score.tracks[1].name).toBe('Bass');
    expect(score.tracks[1].playbackInfo.program).toBe(33);
    expect(score.tracks[1].staves[0].capo).toBe(2);
    expect(score.tracks[1].staves[0].bars[0].clef).toBe(model.Clef.F4);
    expect(beatsOf(score, 0, 0, 1)[0].notes.map(n => n.realValue - 2).sort()).toEqual([31, 43]);
    expect(score.tracks[1].playbackInfo.primaryChannel).not.toBe(score.tracks[0].playbackInfo.primaryChannel);
  });

  it('imports rhythm, rests, chords, ties, time, key and tempo', () => {
    const { score, notice } = importTablEdit(buildTef(basicTef({ measures: [{ num: 4, den: 4, key: 2 }, { num: 3, den: 4, key: -1 }] })), settings);
    expect(score.title).toBe('Synthetic');
    expect(score.copyright).toBe('(c) fixture');
    expect(score.tempo).toBe(100);
    expect(score.masterBars[0].keySignature).toBe(2);
    expect(score.masterBars[1].keySignature).toBe(-1);
    expect(score.masterBars[1].timeSignatureNumerator).toBe(3);
    const bar1 = beatsOf(score, 0);
    expect(bar1.map(b => b.duration)).toEqual([4, 4, 4, 4]);
    expect(bar1[0].notes.map(n => n.fret).sort()).toEqual([1, 2]);
    expect(bar1[2].notes).toHaveLength(0);
    const bar2 = beatsOf(score, 1);
    expect(bar2[0].duration).toBe(2);
    expect(bar2[0].notes[0].isTieDestination).toBe(true);
    expect(bar2[0].notes[0].fret).toBe(3);
    expect(notice).toMatch(/Imported from TablEdit \(experimental import, tested only on synthetic files\): 2 measures, 1 track\./);
  });

  it('fills bars: gaps become rests and every bar is exactly full', () => {
    const file = basicTef({ events: [{ position: 16, string: 1, fret: 0 }, { position: 100, string: 1, fret: 1, duration: 9 }] });
    const { score } = importTablEdit(buildTef(file), settings);
    const total = (beats: model.Beat[]) => beats.reduce((sum, b) => sum + (b.graceType === model.GraceType.None ? b.playbackDuration : 0), 0);
    const first = beatsOf(score, 0), second = beatsOf(score, 1);
    expect(first[0].notes).toHaveLength(0);
    expect(total(first)).toBe(total(second));
  });

  it('imports dotted, double dotted and triplet lengths', () => {
    const file = basicTef({
      measures: [{ num: 4, den: 4 }],
      events: [
        { position: 0, string: 1, fret: 0, duration: durationCode(2, 'dot') },
        { position: 24, string: 1, fret: 0, duration: 25 },
        { position: 32, string: 1, fret: 0, duration: durationCode(3, 'triplet') },
        { position: 32, string: 2, fret: 0, kind: 'rest', duration: durationCode(3, 'triplet') },
      ],
    });
    const beats = beatsOf(importTablEdit(buildTef(file), settings).score);
    expect(beats[0]).toMatchObject({ duration: 4, dots: 1 });
    expect(beats[1]).toMatchObject({ duration: 8, dots: 2 });
    expect(beats[2]).toMatchObject({ duration: 8, tupletNumerator: 3, tupletDenominator: 2 });
    expect(durationCode(2, 'dot')).toBe(4);
    expect(durationCode(2, 'triplet')).toBe(8);
  });

  it('imports grace notes, two voices and 64th notes; counts what it drops', () => {
    const file = basicTef({
      measures: [{ num: 4, den: 4 }],
      events: [
        { position: 0, string: 1, fret: 5, duration: 18, grace: { fret: 3, effect: 2 }, fingering: 3 },
        { position: 0, string: 6, fret: 0, duration: 0, voice: 3 },
        { position: 4, kind: 'text', string: 1, textIndex: 0 },
        { position: 8, string: 2, kind: 'raw', marker: 0x3a },
      ],
      texts: ['hello'], comment: 'a comment', notes: 'n',
    });
    const { score, notice } = importTablEdit(buildTef(file), settings);
    const bar = score.tracks[0].staves[0].bars[0];
    expect(bar.voices).toHaveLength(2);
    expect(bar.voices[0].beats[0].graceType).toBe(model.GraceType.BeforeBeat);
    expect(bar.voices[0].beats[0].notes[0].fret).toBe(3);
    expect(bar.voices[0].beats[1].duration).toBe(64);
    expect(bar.voices[1].beats[0].notes[0].realValue).toBe(40);
    for (const fragment of ['1 text markers', '1 grace-note effects', '1 fingerings', '1 events of an unrecognised kind', '2 comment, notes and link fields']) expect(notice).toContain(fragment);
  });

  it('turns an identical reading-list run into a repeat and reports jumps', () => {
    const measures = Array.from({ length: 6 }, () => ({ num: 4, den: 4 }));
    const events = [{ position: 0, string: 1, fret: 0 }];
    const { score, notice } = importTablEdit(buildTef({ measures, events, readingList: [[1, 2], [1, 2], [3, 3], [6, 6], [4, 5]] }), settings);
    expect(score.masterBars[0].isRepeatStart).toBe(true);
    expect(score.masterBars[1].repeatCount).toBe(2);
    expect(score.masterBars[2].repeatCount).toBe(0);
    expect(notice).toContain('reading-list jumps and endings');
  });

  it('bounds playback expansion for a tiny file full of nested or huge repeats', () => {
    const measures = Array.from({ length: 60 }, () => ({ num: 4, den: 4 }));
    const nested: [number, number][] = [];
    for (let level = 1; level <= 30; level++) for (let k = 0; k < 20; k++) nested.push([level, 60 - level], [level, 60 - level]);
    const file: TefFx = { measures, events: [{ position: 0, string: 1, fret: 0 }], readingList: [...nested, [1, 5], ...Array.from({ length: 600 }, () => [1, 5] as [number, number])] };
    const bytes = buildTef(file);
    expect(bytes.length).toBeLessThan(40000);
    const { score, notice } = importTablEdit(bytes, settings);
    let played = 0;
    const handler: midi.IMidiFileHandler = { addTickShift() {}, addTimeSignature() {}, addRest() {}, addNote() {}, addControlChange() {}, addProgramChange() {}, addTempo() {}, addBend() {}, addNoteBend() {}, finishTrack() {} };
    const generator = new midi.MidiFileGenerator(score, settings, handler);
    generator.generate();
    played = generator.tickLookup.masterBars.length;
    expect(played).toBeLessThanOrEqual(60 * MAX_REPEAT);
    expect(notice).toMatch(/overlapping an earlier repeat|reduced/);
  });

  it('puts a pickup measure on the anacrusis and does not pad it', () => {
    const file = basicTef({ measures: [{ num: 4, den: 4, flag: 0x08 }, { num: 4, den: 4 }], events: [{ position: 48, string: 1, fret: 0 }, { position: 64, string: 1, fret: 1 }] });
    const { score } = importTablEdit(buildTef(file), settings);
    expect(score.masterBars[0].isAnacrusis).toBe(true);
    expect(beatsOf(score, 0)).toHaveLength(1);
  });

  it('drops events that overflow a measure or follow the last one, and merges the counts', () => {
    const file = basicTef({
      measures: [{ num: 4, den: 4 }],
      events: [{ position: 56, string: 1, fret: 0, duration: 0 }, { position: 200, string: 1, fret: 0 }, { position: 201, string: 1, fret: 0 }],
    });
    const { notice } = importTablEdit(buildTef(file), settings);
    expect(notice).toContain('1 notes or rests that overflow their measure');
    expect(notice).toContain('2 events after the last measure');
  });

  it('keeps an unsupported-length report bounded and merged', () => {
    const events = Array.from({ length: 400 }, (_, i) => ({ position: i % 64, string: 1 + (i % 6), fret: 0, duration: 21 + (i % 10) }));
    const { notice } = importTablEdit(buildTef({ measures: [{ num: 4, den: 4 }], events }), settings);
    expect(notice.match(/unsupported note lengths/g)).toHaveLength(1);
    expect(notice.length).toBeLessThan(2000);
  });

  it('refuses a file with no notes', () => {
    expect(() => importTablEdit(buildTef({ events: [] }), settings)).toThrow(/no notes/);
  });

  it('opens through buildDocument and the file gate, and a bad file changes nothing', async () => {
    const bytes = buildTef(basicTef());
    const built = buildDocument(projectFor(bytes));
    expect(built.importNotice).toMatch(/Imported from TablEdit/);
    expect(built.score.tracks).toHaveLength(1);
    expect(() => buildDocument(projectFor(bytes.slice(0, 0x100), 'c'.repeat(64)))).toThrow(/truncated|damaged|pointer/);
    // The gate skips the alphaTab probe for TablEdit content, whatever the file name says.
    await expect(admitDocumentBase(projectFor(bytes, 'd'.repeat(64)), { createWorker: () => { throw new Error('no worker expected'); } })).resolves.toBeUndefined();
    expect(() => adoptAdmittedBase('d'.repeat(64), bytes)).not.toThrow();
  });
});

const MAX_REPEAT = 16;
