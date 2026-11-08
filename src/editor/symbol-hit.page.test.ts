// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import { LayoutMode, model, rendering, Settings } from '@coderline/alphatab';
import { arrangeScreenPages, paginateScreenScore, unmapScreenPoint, type ScreenRenderChunk } from '../engraving/screen-pages';
import { resolveSymbol } from './symbol-hit';

/**
 * E19: the hit path of the paper layouts, with real alphaTab output. ScoreView turns a click into a point on the page layout with
 * unmapScreenPoint (page position, zoom), then asks resolveSymbol what the clicked <text> is. Here the click is placed on a <text>
 * of the rendered SVG where ScoreView draws it: the chunk at (block.x + chunk.x - sourceBounds.x) on its sheet, scaled by the zoom.
 */
const page = { widthMm: 210, heightMm: 297, marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }, scale: 1, profile: 'document' as const };
const G2 = 0xe050, F4 = 0xe062, TAB = 0xe06d, NOTE = 0xeca5;

function build() {
  const score = new model.Score();
  score.title = 'Etude';
  const track = new model.Track(); track.name = 'Guitar'; track.playbackInfo.program = 25;
  const staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; staff.showStandardNotation = true; staff.showTablature = true;
  track.addStaff(staff); score.addTrack(track);
  const chord = new model.Chord(); chord.name = 'Am'; chord.strings = [0, 0, 2, 2, 1, 0]; staff.addChord('c1', chord);
  for (let i = 0; i < 24; i++) {
    const master = new model.MasterBar(); score.addMasterBar(master);
    if (i === 0) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
    if (i === 20) master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 140, 2)];
    const bar = new model.Bar(); bar.clef = i === 21 ? model.Clef.F4 : model.Clef.G2;
    const voice = new model.Voice();
    for (let b = 0; b < 4; b++) {
      const beat = new model.Beat(); beat.duration = 4; beat.isEmpty = false;
      const note = new model.Note(); note.string = 6; note.fret = 3; beat.addNote(note); voice.addBeat(beat);
      if (i === 19 && b === 2) beat.chordId = 'c1';
    }
    bar.addVoice(voice); staff.addBar(bar);
  }
  score.finish(new Settings());
  const settings = new Settings();
  settings.core.engine = 'svg'; settings.core.useWorkers = false; settings.core.enableLazyLoading = false; settings.core.includeNoteBounds = true;
  settings.display.layoutMode = LayoutMode.Page;
  const renderer = new rendering.ScoreRenderer(settings); renderer.width = 660;
  const chunks: ScreenRenderChunk[] = [];
  renderer.partialRenderFinished.on(e => { chunks.push({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height, firstMasterBarIndex: e.firstMasterBarIndex, lastMasterBarIndex: e.lastMasterBarIndex, svg: e.renderResult as string }); });
  renderer.renderScore(score, [0]);
  return { score, renderer, chunks, pagination: paginateScreenScore(chunks, renderer.boundsLookup!, page) };
}
const world = build();
afterAll(() => world.renderer.destroy());

interface Found { text: Element; chunk: ScreenRenderChunk; x: number; y: number }
/** The nth <text> of the rendered chunks that satisfies `want`, with its anchor in chunk coordinates (own x/y, or its group's translate). */
function findText(want: (content: string) => boolean, nth = 0, firstBar?: number): Found {
  const found: Found[] = [];
  for (const chunk of world.chunks.filter(c => firstBar === undefined || c.firstMasterBarIndex === firstBar)) {
    const doc = new DOMParser().parseFromString(chunk.svg, 'image/svg+xml');
    for (const text of doc.querySelectorAll('text')) {
      if (!want(text.textContent ?? '')) continue;
      let x = Number(text.getAttribute('x') ?? NaN), y = Number(text.getAttribute('y') ?? NaN);
      if (Number.isNaN(x)) {
        const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(text.closest('g[transform]')?.getAttribute('transform') ?? '');
        if (m) { x = Number(m[1]); y = Number(m[2]); }
      }
      found.push({ text, chunk, x, y });
    }
  }
  const hit = found[nth];
  if (!hit || Number.isNaN(hit.x)) throw new Error('No such rendered text.');
  return hit;
}
const glyph = (code: number) => (content: string) => content.codePointAt(0) === code && content.length === String.fromCodePoint(code).length;

type Mode = 'verticalPage' | 'grid';
/** Click a rendered text at an offset inside it, as ScoreView receives it, and resolve it. */
function click(found: Found, dx: number, dy: number, zoom: number, mode: Mode, score: model.Score = world.score) {
  const pagination = world.pagination, arrangement = arrangeScreenPages(pagination, mode, zoom, 2400);
  const block = pagination.blocks.find(b => b.chunk === found.chunk)!, sheet = arrangement.pages[block.page];
  const point = { x: sheet.x + (block.x + found.chunk.x - block.sourceBounds.x + found.x + dx) * zoom, y: sheet.y + (block.y + found.chunk.y - block.sourceBounds.y + found.y + dy) * zoom };
  const hit = unmapScreenPoint(pagination, arrangement, point);
  const ref = resolveSymbol({
    score, tracks: [0], text: found.text.textContent ?? '', centered: found.text.getAttribute('text-anchor') === 'middle',
    system: hit?.system ?? null, point: hit?.point ?? null, sourceBeat: beat => beat,
  });
  return { ref, page: block.page };
}

const zooms = [0.5, 1, 1.5, 2.5];

describe('symbol hits on the paper layouts, rendered by alphaTab', () => {
  it('lays the fixture out on three pages, with every symbol under test after the first except the title', () => {
    expect(world.pagination.pageCount).toBe(3);
    const pageOf = (bar: number) => world.pagination.blocks.find(b => b.chunk.firstMasterBarIndex <= bar && bar <= b.chunk.lastMasterBarIndex)!.page;
    expect([pageOf(19), pageOf(20), pageOf(21)]).toEqual([1, 2, 2]);
  });

  describe.each<Mode>(['verticalPage', 'grid'])('%s', mode => {
    it.each(zooms)('finds the title on the first page at zoom %s', zoom => {
      const { ref, page: at } = click(findText(content => content === 'Etude'), 0, 12, zoom, mode);
      expect(at).toBe(0);
      expect(ref).toEqual({ kind: 'title' });
    });

    it.each(zooms)('finds a tempo mark on the third page by its value and by its metronome note at zoom %s', zoom => {
      const value = click(findText(content => content === ' = 140', 0, 20), 12, -4, zoom, mode);
      expect(value.page).toBe(2);
      expect(value.ref).toEqual({ kind: 'tempo', bar: 20, index: 0 });
      // The metronome note drawn before the value, in the same system.
      const note = click(findText(content => content.codePointAt(0) === NOTE, 0, 20), 2, -2, zoom, mode);
      expect(note.page).toBe(2);
      expect(note.ref).toEqual({ kind: 'tempo', bar: 20, index: 0 });
    });

    it.each(zooms)('finds a chord name on the second page at zoom %s', zoom => {
      const { ref, page: at } = click(findText(content => content === 'Am', 0, 18), 0, -3, zoom, mode);
      expect(at).toBe(1);
      expect(ref).toEqual({ kind: 'chord', target: { track: 0, staff: 0, bar: 19, voice: 0, beat: 2 } });
    });

    it.each(zooms)('finds the clef of a system start and a mid-system clef change on the third page at zoom %s', zoom => {
      // The first system of the third page starts at bar 20.
      const start = click(findText(glyph(G2), 0, 20), 0, -6, zoom, mode);
      expect(start.page).toBe(2);
      expect(start.ref).toEqual({ kind: 'clef', track: 0, staff: 0, bar: 20 });
      const change = click(findText(glyph(F4), 0, 20), 0, -6, zoom, mode);
      expect(change.page).toBe(2);
      expect(change.ref).toEqual({ kind: 'clef', track: 0, staff: 0, bar: 21 });
    });

    it('does not take the tab clef for a clef, nor the title words inside a measure on a later page for the title', () => {
      expect(click(findText(glyph(TAB), 0, 20), 0, -6, 1, mode).ref).toBeNull();
      const other = new model.Score(); other.title = '3';
      expect(click(findText(content => content === '3', 0, 20), 0, 0, 1, mode, other).ref).toBeNull();
    });
  });
});
