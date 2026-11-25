import { expect, it } from 'vitest';
import { LayoutMode, model, rendering, Settings } from '@coderline/alphatab';
import { buildScore } from '../engine';
import type { EditCommand } from '../edit-types';
import { blankProject } from '../project';
import type { EntryLayout } from './score-entry-hit';
import { tabCaretBox, tabLineGeometry, tabStringAtPoint, type TabBeatBox } from './tab-string-hit';

const at = (beat: number, track = 0) => ({ track, staff: 0, bar: 0, voice: 0, beat });

function renderScore(edits: EditCommand[], scale = 1, showNotation = true) {
  const score = buildScore({ ...blankProject(), edits });
  if (!showNotation) score.tracks[0].staves[0].showStandardNotation = false;
  score.finish(new Settings());
  const settings = new Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;
  settings.core.enableLazyLoading = false;
  settings.core.includeNoteBounds = true;
  settings.display.layoutMode = LayoutMode.Parchment;
  settings.display.scale = scale;
  const renderer = new rendering.ScoreRenderer(settings);
  renderer.width = 1000;
  renderer.renderScore(score, [0]);
  return {
    score,
    renderer,
    layout: (renderer as unknown as { layout: EntryLayout }).layout,
  };
}

it.each([1, 1.5])('prefers TAB noteHeadBounds over standard notation noteheads and places empty caret on exact string Y at scale %s', scale => {
  const { score, renderer, layout } = renderScore([
    { type: 'setNote', target: at(0), string: 6, fret: 5 },
    { type: 'setNote', target: at(0), string: 2, fret: 3 },
  ], scale);
  try {
    const bar = score.tracks[0].staves[0].bars[0];
    const geom = tabLineGeometry(layout, bar, scale)!;
    expect(geom).not.toBeNull();
    expect(geom.stringCount).toBe(6);

    const beat0 = bar.voices[0].beats[0];
    const note6 = beat0.notes.find(n => n.string === 6)!;
    const bounds0 = renderer.boundsLookup!.findBeats(beat0) as unknown as TabBeatBox[];
    // Beat 0 has bounds on both standard notation and tablature staves.
    expect(bounds0.length).toBe(2);

    const onNote = tabCaretBox(layout, bounds0, bar, 6, note6, scale)!;
    expect(onNote.onNote).toBe(true);
    // Caret center matches TAB string 6 line (top line), NOT treble staff above it.
    const onNoteCenterY = onNote.box.y + onNote.box.h / 2;
    expect(Math.abs(onNoteCenterY - geom.lineY(6))).toBeLessThan(2);

    // String 4 has no note on beat 0: empty caret sits centered vertically on string 4's line.
    const emptyStr4 = tabCaretBox(layout, bounds0, bar, 4, null, scale)!;
    expect(emptyStr4.onNote).toBe(false);
    expect(Math.abs(emptyStr4.box.y + emptyStr4.box.h / 2 - geom.lineY(4))).toBeLessThan(0.5);

    // Monotonic downward progression from string 6 (top) to string 1 (bottom).
    const ys = [6, 5, 4, 3, 2, 1].map(s => tabCaretBox(layout, bounds0, bar, s, null, scale)!.box.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);

    // Rest beat 1 places caret on the rest aligned with its string line.
    const beat1 = bar.voices[0].beats[1];
    const bounds1 = renderer.boundsLookup!.findBeats(beat1) as unknown as TabBeatBox[];
    const restCaret = tabCaretBox(layout, bounds1, bar, 1, null, scale)!;
    expect(restCaret.onNote).toBe(false);
    expect(Math.abs(restCaret.box.y + restCaret.box.h / 2 - geom.lineY(1))).toBeLessThan(0.5);
  } finally {
    renderer.destroy();
  }
});

it('maps vertical click coordinates to exact TAB string lines and ignores standard notation above', () => {
  const { score, renderer, layout } = renderScore([
    { type: 'setNote', target: at(0), string: 6, fret: 3 },
  ], 1);
  try {
    const bar = score.tracks[0].staves[0].bars[0];
    const geom = tabLineGeometry(layout, bar, 1)!;
    for (const string of [6, 5, 4, 3, 2, 1]) {
      expect(tabStringAtPoint(layout, bar, geom.lineY(string), 1)).toBe(string);
      expect(tabStringAtPoint(layout, bar, geom.lineY(string) + geom.spacing * 0.25, 1)).toBe(string);
    }
    // Above the TAB staff (standard notation) or well below it returns undefined.
    expect(tabStringAtPoint(layout, bar, geom.firstLineY - geom.spacing * 1.5, 1)).toBeUndefined();
    expect(tabStringAtPoint(layout, bar, geom.lineY(1) + geom.spacing * 1.5, 1)).toBeUndefined();
    expect(tabStringAtPoint(layout, bar, Number.NaN, 1)).toBeUndefined();
  } finally {
    renderer.destroy();
  }
});

it('returns null gracefully for mocked layouts, percussion bars, and hidden tablature', () => {
  const score = buildScore({
    ...blankProject(),
    edits: [{ type: 'addPercussionTrack', name: 'Drums', program: 0 }],
  });
  const guitarBar = score.tracks[0].staves[0].bars[0];
  const drumBar = score.tracks[1].staves[0].bars[0];

  expect(tabLineGeometry(null, guitarBar, 1)).toBeNull();
  expect(tabCaretBox(null, [], guitarBar, 6, null, 1)).toBeNull();
  expect(tabStringAtPoint(null, guitarBar, 100, 1)).toBeUndefined();

  const { score: noTabScore, renderer, layout } = renderScore([], 1, true);
  try {
    expect(tabLineGeometry(layout, drumBar, 1)).toBeNull();
    // Standard notation only (no tab renderer) returns null.
    const gBar = noTabScore.tracks[0].staves[0].bars[0];
    gBar.staff.showTablature = false;
    const settings = new Settings();
    settings.core.engine = 'svg';
    settings.core.useWorkers = false;
    const r2 = new rendering.ScoreRenderer(settings);
    r2.width = 800;
    r2.renderScore(noTabScore, [0]);
    try {
      const l2 = (r2 as unknown as { layout: EntryLayout }).layout;
      expect(tabLineGeometry(l2, gBar, 1)).toBeNull();
      expect(tabStringAtPoint(l2, gBar, 80, 1)).toBeUndefined();
    } finally {
      r2.destroy();
    }
  } finally {
    renderer.destroy();
  }
});
