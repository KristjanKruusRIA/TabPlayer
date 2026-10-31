import { describe, expect, it } from 'vitest';
import { model, rendering } from '@coderline/alphatab';
import type { ScreenSystem } from '../engraving/screen-pages';
import { music } from './fixtures';
import { isClefGlyph, resolveSymbol } from './symbol-hit';

const { Bounds, BeatBounds, BarBounds, MasterBarBounds, StaffSystemBounds } = rendering;
const G_CLEF = String.fromCodePoint(0xe050), TAB_CLEF = String.fromCodePoint(0xe06d);

/** Two measures of 200px each in one system; the staff row is y 40..100. */
function setup() {
  const score = music();
  score.title = 'Etude';
  const chord = new model.Chord();
  chord.name = 'Am';
  chord.strings = [0, 0, 2, 2, 1, 0];
  const staff = score.tracks[0].staves[0];
  staff.addChord('c1', chord);
  staff.bars[1].voices[0].beats[2].chordId = 'c1';
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0.5, 140, 2)];
  const system = new StaffSystemBounds();
  system.visualBounds = new Bounds(0, 0, 400, 140);
  system.realBounds = new Bounds(0, 0, 400, 140);
  [0, 1].forEach(index => {
    const master = new MasterBarBounds();
    master.index = index;
    master.realBounds = new Bounds(index * 200, 0, 200, 140);
    master.visualBounds = new Bounds(index * 200, 0, 200, 140);
    const row = new BarBounds();
    row.bar = staff.bars[index];
    row.realBounds = new Bounds(index * 200, 40, 200, 60);
    row.visualBounds = new Bounds(index * 200, 20, 200, 100);
    row.masterBarBounds = master;
    staff.bars[index].voices[0].beats.forEach((beat, at) => {
      const bounds = new BeatBounds();
      bounds.beat = beat;
      bounds.realBounds = new Bounds(index * 200 + 20 + at * 45, 40, 40, 60);
      bounds.barBounds = row;
      row.beats.push(bounds);
    });
    master.bars.push(row);
    master.staffSystemBounds = system;
    system.bars.push(master);
  });
  const probe = (text: string, x: number, y: number, tracks = [0]) => resolveSymbol({ score, tracks, text, system: system as unknown as ScreenSystem, point: { x, y }, sourceBeat: beat => beat });
  return { score, system, probe };
}

describe('resolving a clicked symbol', () => {
  it('recognises music-font clef glyphs and not the tab clef', () => {
    expect(isClefGlyph(G_CLEF)).toBe(true);
    expect(isClefGlyph(String.fromCodePoint(0xe062))).toBe(true);
    expect(isClefGlyph(String.fromCodePoint(0xe069))).toBe(true);
    expect(isClefGlyph(TAB_CLEF)).toBe(false);
    expect(isClefGlyph('A')).toBe(false);
    expect(isClefGlyph(G_CLEF + G_CLEF)).toBe(false);
  });

  it('finds the clef of the measure and staff under the glyph, even just left of the measure', () => {
    const { probe } = setup();
    expect(probe(G_CLEF, 210, 70)).toEqual({ kind: 'clef', track: 0, staff: 0, bar: 1 });
    expect(probe(G_CLEF, -10, 30)).toEqual({ kind: 'clef', track: 0, staff: 0, bar: 0 });
    expect(probe(G_CLEF, 800, 30)).toBeNull();
    expect(probe(G_CLEF, 210, 70, [3])).toBeNull();
    expect(probe(TAB_CLEF, 210, 70)).toBeNull();
  });

  it('finds a tempo mark by its text and its position in the measure', () => {
    const { probe, score } = setup();
    expect(probe(' = 140', 300, 10)).toEqual({ kind: 'tempo', bar: 1, index: 0 });
    expect(probe('= 120', 20, 10)).toEqual({ kind: 'tempo', bar: 0, index: 0 });
    expect(probe('= 99', 20, 10)).toBeNull();
    score.masterBars[0].tempoAutomations[0].text = 'Allegro';
    expect(probe('Allegro', 20, 10)).toEqual({ kind: 'tempo', bar: 0, index: 0 });
  });

  it('chooses between two marks with the same value by position', () => {
    const { probe, score } = setup();
    score.masterBars[1].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 140, 2), model.Automation.buildTempoAutomation(false, 0.75, 140, 2)];
    expect(probe('= 140', 215, 10)).toEqual({ kind: 'tempo', bar: 1, index: 0 });
    expect(probe('= 140', 380, 10)).toEqual({ kind: 'tempo', bar: 1, index: 1 });
  });

  it('finds a chord by its name at the nearest beat that carries it', () => {
    const { probe, score } = setup();
    expect(probe('Am', 330, 10)).toEqual({ kind: 'chord', target: { track: 0, staff: 0, bar: 1, voice: 0, beat: 2 } });
    // The same characters at a measure with no such chord are not a chord symbol.
    expect(probe('Am', 100, 10)).toBeNull();
    score.tracks[0].staves[0].bars[0].voices[0].beats[1].chordId = 'c1';
    expect(probe('Am', 100, 10)).toEqual({ kind: 'chord', target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 1 } });
  });

  it('finds the title outside every system, but not the same words inside a measure', () => {
    const { score, system } = setup();
    const resolve = (text: string, inside: boolean) => resolveSymbol({ score, tracks: [0], text, system: inside ? system as unknown as ScreenSystem : null, point: inside ? { x: 50, y: 50 } : null, sourceBeat: beat => beat });
    expect(resolve('Etude', false)).toEqual({ kind: 'title' });
    expect(resolve(' Etude ', false)).toEqual({ kind: 'title' });
    expect(resolve('Etude', true)).toBeNull();
    expect(resolve('Other', false)).toBeNull();
    score.title = '';
    expect(resolve('', false)).toBeNull();
  });
});
