import { expect, it } from 'vitest';
import { LayoutMode, model, rendering, Settings } from '@coderline/alphatab';
import { buildScore } from '../engine';
import type { EditCommand } from '../edit-types';
import { blankProject } from '../project';
import { drawnSpelling, entryClef, pitchStep, writtenPitch } from '../editor/notation-entry';
import { entryNotes } from '../instruments/entry';
import { scoreEntryHit, type EntryLayout, type MasterBarBox } from './score-entry-hit';

const at = (track: number, beat: number, bar = 0) => ({ track, staff: 0, bar, voice: 0, beat });
const edits: EditCommand[] = [
  { type: 'addPitchedTrack', name: 'Piano', program: 0 },
  { type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: 33 },
  // Guitar (written an octave up, treble clef): E3 open low string, C4, G4, B4 and E5.
  { type: 'setNote', target: at(0, 0), string: 1, fret: 0 }, { type: 'setNote', target: at(0, 1), string: 5, fret: 1 },
  { type: 'setNote', target: at(0, 2), string: 4, fret: 0 }, { type: 'setNote', target: at(0, 3), string: 6, fret: 0 },
  // Piano treble: ledger notes below and above, and a chord.
  { type: 'addPitchedNote', target: at(1, 0), pitch: 57 }, { type: 'addPitchedNote', target: at(1, 1), pitch: 84 },
  { type: 'addPitchedNote', target: at(1, 2), pitch: 64 }, { type: 'addPitchedNote', target: at(1, 2), pitch: 71 },
  // Bass clef: open strings and a fret.
  { type: 'setNote', target: at(2, 0), string: 1, fret: 0 }, { type: 'setNote', target: at(2, 1), string: 3, fret: 2 },
  { type: 'setNote', target: at(2, 2, 1), string: 4, fret: 5 },
];

function render(scale: number) {
  const score = buildScore({ ...blankProject(), edits }), settings = new Settings();
  settings.core.engine = 'svg'; settings.core.useWorkers = false; settings.core.enableLazyLoading = false; settings.core.includeNoteBounds = true;
  settings.display.layoutMode = LayoutMode.Page; settings.display.scale = scale;
  const renderer = new rendering.ScoreRenderer(settings); renderer.width = 1000;
  renderer.renderScore(score, [0, 1, 2]);
  return { scale, score, renderer, layout: (renderer as unknown as { layout: EntryLayout }).layout, masters: renderer.boundsLookup!.staffSystems.flatMap(system => system.bars) as unknown as MasterBarBox[] };
}

it.each([1, 1.5])('finds every notehead on the notation staff at its own beat and staff step, at scale %s', scale => {
  const { renderer, layout, masters } = render(scale);
  try {
    let checked = 0;
    for (const master of masters) for (const box of master.bars) {
      const lines = layout.getRendererForBar('score', box.bar);
      // Only the notation staff's own bar: its tablature shares the bar but starts lower down.
      if (!lines || Math.abs(box.realBounds.y - (lines.staff.system.y + lines.staff.system.topPadding + lines.staff.y + lines.y) * scale) > 0.5) continue;
      for (const beat of (box as unknown as { beats: { notes?: { note: model.Note; noteHeadBounds: { x: number; y: number; w: number; h: number } }[] }[] }).beats) for (const head of beat.notes ?? []) {
        const note = head.note, staff = note.beat.voice.bar.staff, sourceBar = note.beat.voice.bar, bounds = head.noteHeadBounds;
        const hit = scoreEntryHit(layout, masters, { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, { scale });
        const key = entryNotes(staff, note.beat).find(entry => entry.index === note.index)!.key;
        const drawn = drawnSpelling(sourceBar.keySignature as number, writtenPitch(staff, sourceBar, note.beat, key), note.accidentalMode);
        const step = pitchStep(entryClef(sourceBar), drawn.letter, drawn.octave), where = { track: staff.track.index, beat: note.beat.index };
        // A note further out than the entry staff's three ledger lines cannot be clicked; every other one inverts exactly.
        if (step === null) { expect({ ...where, hit }).toEqual({ ...where, hit: null }); continue; }
        expect({ ...where, beat: hit?.beat === note.beat ? note.beat.index : null, step: hit?.step }).toEqual({ ...where, step });
        checked++;
      }
    }
    // Nine of the thirteen notes sit within three ledger lines of their staff.
    expect(checked).toBe(9);
  } finally { renderer.destroy(); }
});

it('answers only on the notation staff and its ledger room, never on tablature', () => {
  const { scale, score, renderer, layout, masters } = render(1);
  try {
    const guitarBar = score.tracks[0].staves[0].bars[0], first = masters[0];
    const boxes = first.bars.filter(box => box.bar === guitarBar);
    expect(boxes.length).toBe(2); // Notation and tablature.
    const [notation, tab] = [...boxes].sort((a, b) => a.realBounds.y - b.realBounds.y);
    const x = notation.beats[0].realBounds.x + 1;
    expect(scoreEntryHit(layout, masters, { x, y: tab.realBounds.y + tab.realBounds.h / 2 }, { scale })).toBeNull();
    const renderer0 = layout.getRendererForBar('score', guitarBar)!, top = notation.realBounds.y + renderer0.getScoreY(0), half = renderer0.getScoreY(1) - renderer0.getScoreY(0);
    expect(scoreEntryHit(layout, masters, { x, y: top + 8 * half }, { scale })?.step).toBe(0); // Bottom line.
    expect(scoreEntryHit(layout, masters, { x, y: top + 8 * half + 0.4 * half }, { scale })?.step).toBe(0);
    expect(scoreEntryHit(layout, masters, { x, y: top - 6 * half }, { scale })?.step).toBe(14); // Third ledger line above.
    expect(scoreEntryHit(layout, masters, { x, y: top - 8 * half }, { scale })).toBeNull();
    // Ledger room below the staff ends where the tablature begins.
    expect(scoreEntryHit(layout, masters, { x, y: tab.realBounds.y + 1 }, { scale })).toBeNull();
    expect(scoreEntryHit(layout, masters, { x: Number.NaN, y: top }, { scale })).toBeNull();
    expect(model.Clef.G2).toBe(entryClef(guitarBar));
  } finally { renderer.destroy(); }
});
