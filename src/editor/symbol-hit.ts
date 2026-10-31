import type { model } from '@coderline/alphatab';
import type { ScreenSystem } from '../engraving/screen-pages';
import type { SymbolRef } from './symbol-edit';

/**
 * Finds which score symbol a click on the rendered notation landed on. alphaTab reports bounds for bars and beats but none for
 * the title, tempo marks, chord names or clefs, so the clicked <text> says what it is (its characters), and the bounds of the
 * system it sits in say where (which measure, staff and beat).
 */
export interface SymbolProbe {
  /** The document's own score, not the rendered copy. */
  score: model.Score;
  tracks: readonly number[];
  /** Characters of the clicked <text> element. */
  text: string;
  /** The staff system under the pointer and the pointer in that system's coordinates; null off the systems (the title). */
  system: ScreenSystem | null;
  point: { x: number; y: number } | null;
  /** The document's beat for a rendered one, or null when it has none. */
  sourceBeat: (beat: model.Beat) => model.Beat | null;
}

/** Clef glyphs of the music font: G, C and F clefs with their octave variants, and the unpitched percussion clef. The tab clef is not one. */
const CLEF_GLYPHS = new Set([0xe050, 0xe051, 0xe052, 0xe053, 0xe054, 0xe05c, 0xe05d, 0xe062, 0xe063, 0xe064, 0xe065, 0xe066, 0xe069]);
const TEMPO = /^=\s*(\d+(?:\.\d+)?)$/;
/** How far outside a measure a click may be and still belong to it: a clef sits just left of the first beat, and a label can overhang. */
const REACH = 48;

export const isClefGlyph = (text: string) => { const code = text.codePointAt(0); return code !== undefined && text.length === String.fromCodePoint(code).length && CLEF_GLYPHS.has(code); };

function distance(low: number, size: number, value: number) { return value < low ? low - value : value > low + size ? value - low - size : 0; }

function nearestMaster(system: ScreenSystem, x: number) {
  let best: { master: ScreenSystem['bars'][number]; gap: number } | null = null;
  for (const master of system.bars) {
    const gap = distance(master.realBounds.x, master.realBounds.w, x);
    if (!best || gap < best.gap) best = { master, gap };
  }
  return best && best.gap <= REACH ? best.master : null;
}

export function resolveSymbol(probe: SymbolProbe): SymbolRef | null {
  const text = probe.text.trim();
  if (!text) return null;
  const { score, system, point } = probe;
  if (system && point) {
    const master = nearestMaster(system, point.x);
    if (master) {
      if (isClefGlyph(text)) {
        // The bar under the pointer, or the nearest staff row of that measure; the glyph itself says it is a clef.
        const rows = master.bars.filter(row => probe.tracks.includes(row.bar.staff.track.index) && row.bar.staff.showStandardNotation);
        const row = rows.find(item => distance(item.visualBounds.y, item.visualBounds.h, point.y) === 0)
          ?? rows.reduce<typeof rows[number] | null>((best, item) => (!best || distance(item.visualBounds.y, item.visualBounds.h, point.y) < distance(best.visualBounds.y, best.visualBounds.h, point.y) ? item : best), null);
        if (row) return { kind: 'clef', track: row.bar.staff.track.index, staff: row.bar.staff.index, bar: row.bar.index };
        return null;
      }
      const automations = score.masterBars[master.index]?.tempoAutomations ?? [];
      const relative = master.realBounds.w > 0 ? (point.x - master.realBounds.x) / master.realBounds.w : 0;
      const nearestAutomation = (indices: number[]) => indices.reduce<number | null>((best, index) => (best === null || Math.abs(automations[index].ratioPosition - relative) < Math.abs(automations[best].ratioPosition - relative) ? index : best), null);
      const tempo = TEMPO.exec(text);
      const shown = automations.flatMap((automation, index) => (automation.isVisible ? [index] : []));
      const byValue = tempo ? nearestAutomation(shown.filter(index => automations[index].value === Number(tempo[1]))) : null;
      const byLabel = !tempo ? nearestAutomation(shown.filter(index => automations[index].text.trim() === text)) : null;
      const index = byValue ?? byLabel;
      if (index !== null) return { kind: 'tempo', bar: master.index, index };
      // A chord name: the nearest beat of this measure whose chord carries these characters.
      let best: { target: SymbolRef; gap: number } | null = null;
      for (const row of master.bars) for (const beat of row.beats) {
        const source = probe.sourceBeat(beat.beat);
        if (!source?.chord || source.chord.name.trim() !== text || !probe.tracks.includes(source.voice.bar.staff.track.index)) continue;
        const centre = beat.realBounds.x + beat.realBounds.w / 2, gap = Math.abs(point.x - centre) + distance(row.visualBounds.y, row.visualBounds.h, point.y) * 4;
        if (!best || gap < best.gap) best = { gap, target: { kind: 'chord', target: { track: source.voice.bar.staff.track.index, staff: source.voice.bar.staff.index, bar: source.voice.bar.index, voice: source.voice.index, beat: source.index } } };
      }
      if (best) return best.target;
    }
  }
  // The title sits above the first system, outside every measure.
  if (score.title && text === score.title.trim() && !(system && point)) return { kind: 'title' };
  return null;
}
