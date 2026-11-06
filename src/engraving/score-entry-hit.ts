import type { model } from '@coderline/alphatab';
import { highestStep, lowestStep } from '../editor/notation-entry';

/**
 * The parts of alphaTab 1.8.4's internal layout the hit test reads. They are not public API: the exact engine pin and
 * `score-entry-hit.render.test.ts`, which renders real scores and inverts their noteheads, keep this honest.
 */
export interface ScoreLineRenderer {
  y: number;
  /** Relative y of a staff position, in half-spaces from the top line downward. */
  getScoreY(steps: number): number;
  staff: { y: number; isVisible?: boolean; system: { y: number; topPadding: number } };
}
export interface EntryLayout { getRendererForBar(key: string, bar: model.Bar): ScoreLineRenderer | null }
/** The layout behind an AlphaTabApi's renderer (its `ScoreRendererWrapper` instance), or null before a render. */
export function entryLayoutOf(renderer: unknown): EntryLayout | null {
  const host = renderer as { instance?: { layout?: unknown }; layout?: unknown } | null;
  const layout = (host?.instance?.layout ?? host?.layout) as Partial<EntryLayout> | undefined;
  return typeof layout?.getRendererForBar === 'function' ? layout as EntryLayout : null;
}
interface Rect { x: number; y: number; w: number; h: number }
interface BeatBox { beat: model.Beat; realBounds: Rect; visualBounds: Rect; onNotesX?: number }
interface BarBox { bar: model.Bar; realBounds: Rect; beats: BeatBox[] }
export interface MasterBarBox { realBounds: Rect; bars: BarBox[] }

export interface ScoreEntryHit {
  /** The rendered beat under the point, in the bar's preferred voice. */
  beat: model.Beat;
  /** The staff position, counted as the entry staff does: 0 is the bottom line, each line or space adds one. */
  step: number;
  /** Where a notehead at that position would sit, in source space, and half a staff space there: for a hover preview. */
  at: { x: number; y: number }; half: number;
}

const contains = (rect: Rect, x: number) => x >= rect.x && x < rect.x + rect.w;
/** Where a renderer starts in source space: what alphaTab's own bounds lookup adds up for the bar, then scales. */
const rendererTop = (renderer: ScoreLineRenderer, scale: number) => (renderer.staff.system.y + renderer.staff.system.topPadding + renderer.staff.y + renderer.y) * scale;
const inside = (rect: Rect, point: { x: number; y: number }) => contains(rect, point.x) && point.y >= rect.y && point.y < rect.y + rect.h;

/**
 * The beat and standard-notation staff position at a source-space point: on a line or space of a visible notation
 * staff, or up to three ledger lines above or below it. Null anywhere else, including tablature, slash and hidden
 * staves, and bars whose voice has no beat to write on. Ledger room never reaches into another staff's bar, so a click on
 * tablature stays a tablature click. `scale` is the renderer's `display.scale`: bounds are scaled, layout positions are not.
 */
export function scoreEntryHit(layout: EntryLayout, masterBars: readonly MasterBarBox[], point: { x: number; y: number }, options: { scale: number; voice?: number }): ScoreEntryHit | null {
  const { scale, voice = 0 } = options;
  if (![point.x, point.y, scale].every(Number.isFinite) || !(scale > 0)) return null;
  for (const master of masterBars) {
    if (!contains(master.realBounds, point.x)) continue;
    for (const box of master.bars) {
      const bar = box.bar, renderer = layout.getRendererForBar('score', bar);
      if (!renderer || renderer.staff.isVisible === false || bar.staff.isPercussion) continue;
      const top = rendererTop(renderer, scale);
      // The score bar's own bounds start where its renderer does; tablature of the same bar starts elsewhere.
      if (Math.abs(box.realBounds.y - top) > 0.5) continue;
      if (master.bars.some(other => other !== box && inside(other.realBounds, point))) continue;
      const lines = bar.staff.standardNotationLineCount, first = top + renderer.getScoreY(0) * scale, half = (renderer.getScoreY(1) - renderer.getScoreY(0)) * scale;
      if (!(half > 0) || lines < 1) continue;
      const fromTop = Math.round((point.y - first) / half), step = 2 * (lines - 1) - fromTop;
      if (step < lowestStep || step > highestStep) continue;
      const picked = pickBeat(box.beats, point.x, voice);
      if (picked) return { beat: picked.beat, step, at: { x: centre(picked), y: first + fromTop * half }, half };
    }
  }
  return null;
}

/** The beat at x in one voice: the preferred voice when the bar shows it, else the lowest voice. Grace beats lose to the beat they lead into. */
const centre = (item: BeatBox) => item.onNotesX ?? item.visualBounds.x + item.visualBounds.w / 2;
function pickBeat(beats: readonly BeatBox[], x: number, preferredVoice: number): BeatBox | null {
  const voices = [...new Set(beats.map(item => item.beat.voice.index))].sort((a, b) => a - b);
  const voice = voices.includes(preferredVoice) ? preferredVoice : voices[0];
  const lane = beats.filter(item => item.beat.voice.index === voice);
  if (!lane.length) return null;
  const inside = lane.filter(item => contains(item.realBounds, x));
  const pool = inside.length ? inside : lane;
  return [...pool].sort((a, b) => Number(a.beat.graceType !== 0) - Number(b.beat.graceType !== 0) || Math.abs(centre(a) - x) - Math.abs(centre(b) - x))[0];
}
