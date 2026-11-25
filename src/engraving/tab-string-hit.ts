import type { model } from '@coderline/alphatab';
import { rendererTop, type EntryLayout, type TabLineRenderer } from './score-entry-hit';

export interface TabRect { x: number; y: number; w: number; h: number }
export interface TabNoteBox { note: model.Note; noteHeadBounds: TabRect }
export interface TabBeatBox {
  beat: model.Beat;
  realBounds: TabRect;
  visualBounds: TabRect;
  onNotesX?: number;
  barBounds?: { realBounds: TabRect } | null;
  notes?: readonly TabNoteBox[];
}

export interface TabLineGeometry {
  top: number;
  firstLineY: number;
  spacing: number;
  stringCount: number;
  lineY: (string: number) => number;
}

const finiteRect = (rect: TabRect | null | undefined): rect is TabRect =>
  Boolean(rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0);

/**
 * Vertical line geometry of a rendered tablature bar in source pixel space (already multiplied by `scale`).
 * Returns null for percussion staves, unstringed staves, hidden tablature, or mocked/unavailable layouts.
 */
export function tabLineGeometry(layout: EntryLayout | null | undefined, bar: model.Bar, scale: number): TabLineGeometry | null {
  if (!layout || !Number.isFinite(scale) || scale <= 0) return null;
  if (bar.staff.isPercussion || bar.staff.tuning.length < 1) return null;
  const renderer = layout.getRendererForBar('tab', bar) as Partial<TabLineRenderer> | null;
  if (
    !renderer ||
    typeof renderer.getLineY !== 'function' ||
    !renderer.staff ||
    renderer.staff.isVisible === false ||
    !Number.isFinite(renderer.lineOffset) ||
    !(renderer.lineOffset! > 0) ||
    !Number.isFinite(renderer.y) ||
    !renderer.staff.system
  ) {
    return null;
  }
  const full = renderer as TabLineRenderer;
  const top = rendererTop(full, scale);
  const spacing = full.lineOffset * scale;
  const firstLineY = top + full.getLineY(0) * scale;
  const stringCount = bar.staff.tuning.length;
  if (![top, spacing, firstLineY].every(Number.isFinite) || spacing <= 0) return null;
  return {
    top,
    firstLineY,
    spacing,
    stringCount,
    lineY: (string: number) => {
      const clamped = Math.max(1, Math.min(stringCount, Math.round(string)));
      return top + full.getLineY(stringCount - clamped) * scale;
    },
  };
}

function pickTabBeatBound(bounds: readonly TabBeatBox[], geom: TabLineGeometry): TabBeatBox | null {
  if (!bounds.length) return null;
  const tolerance = Math.max(4, geom.spacing * 2);
  let byBar: TabBeatBox | null = null;
  let bestDistance = Infinity;
  for (const bound of bounds) {
    const barY = bound.barBounds?.realBounds.y;
    if (barY !== undefined && Number.isFinite(barY)) {
      const distance = Math.abs(barY - geom.top);
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance;
        byBar = bound;
      }
    }
  }
  if (byBar) return byBar;
  const bandTop = geom.firstLineY - geom.spacing;
  const bandBottom = geom.firstLineY + Math.max(0, geom.stringCount - 1) * geom.spacing + geom.spacing;
  return bounds.find(bound => {
    const r = bound.realBounds;
    return Number.isFinite(r.y) && Number.isFinite(r.h) && r.y < bandBottom && r.y + r.h > bandTop;
  }) ?? null;
}

/**
 * Caret box on the tablature string line in source pixel space, preferring the TAB notehead bounds over any
 * accompanying notation staff notehead, and centering on the target string line when the beat or string is empty.
 */
export function tabCaretBox(
  layout: EntryLayout | null | undefined,
  beatBoundsList: readonly TabBeatBox[],
  bar: model.Bar,
  editString: number,
  note: model.Note | null | undefined,
  scale: number,
): { box: TabRect; onNote: boolean } | null {
  const geom = tabLineGeometry(layout, bar, scale);
  if (!geom) return null;
  const tabBound = pickTabBeatBound(beatBoundsList, geom);
  if (!tabBound) return null;
  if (note) {
    const head = tabBound.notes?.find(item => item.note === note)?.noteHeadBounds;
    if (finiteRect(head)) return { box: head, onNote: true };
  }
  const cx =
    Number.isFinite(tabBound.onNotesX) && tabBound.onNotesX! >= tabBound.realBounds.x - 1
      ? tabBound.onNotesX!
      : tabBound.visualBounds.w > 0
        ? tabBound.visualBounds.x + tabBound.visualBounds.w / 2
        : tabBound.realBounds.x + Math.min(20, Math.max(8, tabBound.realBounds.w / 2));
  const cy = geom.lineY(editString);
  const w = Math.max(14, geom.spacing * 1.35);
  const h = Math.max(12, geom.spacing * 1.15);
  const box = { x: cx - w / 2, y: cy - h / 2, w, h };
  return finiteRect(box) ? { box, onNote: false } : null;
}

/**
 * Maps a vertical source-space coordinate onto the nearest 1-based tablature string (`stringCount` at top line down to `1`
 * at bottom line), or undefined if outside the tablature staff band.
 */
export function tabStringAtPoint(
  layout: EntryLayout | null | undefined,
  bar: model.Bar,
  pointY: number,
  scale: number,
): number | undefined {
  if (!Number.isFinite(pointY)) return undefined;
  const geom = tabLineGeometry(layout, bar, scale);
  if (!geom) return undefined;
  const minY = geom.firstLineY - geom.spacing * 0.65;
  const maxY = geom.firstLineY + Math.max(0, geom.stringCount - 1) * geom.spacing + geom.spacing * 0.65;
  if (pointY < minY || pointY > maxY) return undefined;
  const line = Math.max(0, Math.min(geom.stringCount - 1, Math.round((pointY - geom.firstLineY) / geom.spacing)));
  return geom.stringCount - line;
}
