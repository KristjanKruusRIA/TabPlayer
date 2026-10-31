import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Settings } from '@coderline/alphatab';
import { importTablEdit } from './tabledit-score';

// Real .tef test files from MuseScore (see .analysis/tef-corpus/SOURCE.txt). They are not committed, so this skips where they are absent.
const dir = '.analysis/tef-corpus';
const load = (name: string) => importTablEdit(new Uint8Array(readFileSync(`${dir}/${name}.tef`)), new Settings());
const beats = (name: string, bar = 0) => load(name).score.tracks[0].staves[0].bars[bar].voices[0].beats;

describe.skipIf(!existsSync(dir))('real TablEdit files', () => {
  it('imports every file', () => {
    const names = readdirSync(dir).filter(n => n.endsWith('.tef'));
    expect(names).toHaveLength(60);
    for (const name of names) expect(load(name.slice(0, -4)).score.masterBars.length, name).toBeGreaterThan(0);
  });
  it('reads a meter and key on every measure', () => {
    const meter = (name: string) => load(name).score.masterBars.map(m => `${m.timeSignatureNumerator}/${m.timeSignatureDenominator}`);
    expect(meter('time_signatures')).toEqual(['4/4', '3/4']);
    expect(load('key_signatures').score.masterBars.map(m => m.keySignature as number)).toEqual([0, 1, 2, -1]);
    expect(load('notes_dotted').notice).not.toContain('unsupported time signatures');
  });
  it('reads tuning, title and rhythm', () => {
    expect(load('guitar_drop_D').score.tracks[0].staves[0].stringTuning.tunings).toEqual([38, 45, 50, 55, 59, 64]);
    expect(load('guitar_drop_D').score.title).toBe('Guitar (drop D)');
    expect(beats('notes_normal', 1).map(b => b.duration as number)).toEqual([2, 4, 8, 16, 32, 64, 64]);
    expect(beats('notes_dotted', 1).every(b => b.dots === 1)).toBe(true);
    expect(beats('triplet_eighths').filter(b => b.hasTuplet)).toHaveLength(3);
  });
});
