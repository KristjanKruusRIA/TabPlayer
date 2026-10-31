import { describe, expect, it } from 'vitest';
import { model, rendering, Settings } from '@coderline/alphatab';
import { music, noteAt, reopened, target } from './fixtures';
import { applyPitchEdit } from './pitch';
import { cautionaryAccidentalsDrawn, isNoteCautionary } from './cautionary';

/** The SMuFL code points of the standard-staff accidental signs. */
const glyphs = { flat: 0xe260, natural: 0xe261, sharp: 0xe262, doubleSharp: 0xe263, doubleFlat: 0xe264 };

function svgOf(score: model.Score): string {
  const settings = new Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;
  settings.core.enableLazyLoading = false;
  const renderer = new rendering.ScoreRenderer(settings);
  renderer.width = 1200;
  const parts: string[] = [];
  renderer.partialRenderFinished.on(e => { if (typeof e.renderResult === 'string') parts.push(e.renderResult); });
  try { renderer.renderScore(score, [0]); return parts.join('\n'); } finally { renderer.destroy(); }
}
/** How many times each accidental sign is drawn in the rendered SVG. */
function signs(score: model.Score): Record<keyof typeof glyphs, number> {
  const svg = svgOf(score);
  const count = (code: number) => svg.split(`&#${code};`).length - 1;
  return { flat: count(glyphs.flat), natural: count(glyphs.natural), sharp: count(glyphs.sharp), doubleSharp: count(glyphs.doubleSharp), doubleFlat: count(glyphs.doubleFlat) };
}
const none = { flat: 0, natural: 0, sharp: 0, doubleSharp: 0, doubleFlat: 0 };
const mark = (score: model.Score, cautionary: boolean, beat = 0) =>
  applyPitchEdit(score, { type: 'setNoteCautionary', target: { ...target, beat }, noteIndex: 0, cautionary });
/** String 6 is E2: fret n sounds E2 + n semitones. */
function tuned(frets: number[], keySignature = 0): model.Score {
  const score = music();
  score.masterBars[0].keySignature = keySignature as model.KeySignature;
  frets.forEach((fret, beat) => { score.tracks[0].staves[0].bars[0].voices[0].beats[beat].notes[0].fret = fret; });
  score.finish(new Settings());
  return score;
}

describe('a cautionary mark draws a real accidental sign', () => {
  it('hooks the notation renderer', () => expect(cautionaryAccidentalsDrawn()).toBe(true));

  it('draws a natural sign for a natural the key already supplies, and only for the marked note', () => {
    const score = tuned([0, 0, 0, 0]);
    expect(signs(score)).toEqual(none);
    mark(score, true, 1);
    expect(signs(score)).toEqual({ ...none, natural: 1 });
  });

  it('draws a sign again when the bar has already shown it', () => {
    const score = tuned([2, 2, 2, 2]);
    expect(signs(score)).toEqual({ ...none, sharp: 1 });
    mark(score, true, 2);
    expect(signs(score)).toEqual({ ...none, sharp: 2 });
  });

  it('draws the key signature flat on a flat the key supplies', () => {
    const score = tuned([6, 6, 6, 6], -1);
    const keyFlats = signs(score).flat;
    mark(score, true, 1);
    expect(signs(score).flat).toBe(keyFlats + 1);
  });

  it('draws nothing for a note whose accidental mode is Force none', () => {
    const score = tuned([0, 0, 0, 0]);
    noteAt(score, 0, 1).accidentalMode = model.NoteAccidentalMode.ForceNone;
    mark(score, true, 1);
    expect(signs(score)).toEqual(none);
  });

  it('clearing the mark removes the sign', () => {
    const score = tuned([0, 0, 0, 0]);
    mark(score, true, 1);
    expect(signs(score).natural).toBe(1);
    mark(score, false, 1);
    expect(signs(score)).toEqual(none);
  });

  it('survives a save and reopen and still draws the sign', () => {
    const score = tuned([0, 0, 0, 0]);
    mark(score, true, 1);
    const copy = reopened(score);
    expect(isNoteCautionary(noteAt(copy, 0, 1))).toBe(true);
    expect(signs(copy)).toEqual({ ...none, natural: 1 });
  });

  it('follows the note when it is re-fretted: the sign is the new pitch, never a stale forced one', () => {
    const score = tuned([1, 1, 1, 1]);
    mark(score, true, 3);
    expect(signs(score)).toEqual({ ...none, natural: 1 });
    const note = noteAt(score, 0, 3);
    note.fret = 2;
    score.finish(new Settings());
    expect(note.accidentalMode).toBe(model.NoteAccidentalMode.Default);
    expect(signs(score)).toEqual({ ...none, sharp: 1 });
  });
});

describe('the mark leaves spelling alone', () => {
  it.each([
    model.NoteAccidentalMode.Default, model.NoteAccidentalMode.ForceNone, model.NoteAccidentalMode.ForceNatural, model.NoteAccidentalMode.ForceSharp,
    model.NoteAccidentalMode.ForceDoubleSharp, model.NoteAccidentalMode.ForceFlat, model.NoteAccidentalMode.ForceDoubleFlat,
  ])('mode %i is the same after marking and unmarking, and while marked', mode => {
    const score = tuned([6, 6, 6, 6]);
    const note = noteAt(score);
    note.accidentalMode = mode;
    const pitch = note.realValue;
    mark(score, true);
    expect(note.accidentalMode).toBe(mode);
    mark(score, false);
    expect(note.accidentalMode).toBe(mode);
    expect(note.realValue).toBe(pitch);
  });

  it('keeps Bb written as Bb, not A#, through mark and unmark', () => {
    const score = tuned([6, 6, 6, 6]);
    const note = noteAt(score);
    note.accidentalMode = model.NoteAccidentalMode.ForceFlat;
    const before = signs(score);
    mark(score, true);
    mark(score, false);
    expect(signs(score)).toEqual(before);
    expect(before.flat).toBe(1);
  });
});
