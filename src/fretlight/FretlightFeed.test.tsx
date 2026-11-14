// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { trackIdentity } from '../engine';
import { announceInstrumentFocus, readInstrumentViewPreferences, writeInstrumentViewPreferences } from '../instruments/view-preferences';
import { FretlightFeed } from './FretlightFeed';
import { litSet } from './frame';
import { createFretlightSession, fretlightSession, type FretlightBridge } from './fretlight-session';

const at = (bar: number, beat: number) => ({ track: 0, staff: 0, bar, voice: 0, beat });
/** Quarter notes: bar 0 holds 0, 1, 2, 3 on the low E; bar 1 holds 5, 6, 7, 8. Strings count from the lowest. */
function music(tuning = [64, 59, 55, 50, 45, 40], capo = 0) {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff();
  track.playbackInfo.program = 25; staff.stringTuning.tunings = tuning; staff.capo = capo;
  track.addStaff(staff); score.addTrack(track);
  for (const frets of [[0, 1, 2, 3], [5, 6, 7, 8]]) {
    score.addMasterBar(new model.MasterBar());
    const bar = new model.Bar(), voice = new model.Voice();
    for (const fret of frets) { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; const note = new model.Note(); note.string = 1; note.fret = fret; beat.addNote(note); voice.addBeat(beat); }
    bar.addVoice(voice); staff.addBar(bar);
  }
  score.finish(new Settings());
  return { score, plan: buildPlaybackPlan(score, 1) };
}
const ready = { ready: true, error: null };
const idle = { tick: null, counting: false, loop: null, range: null };
function playerFor(m: ReturnType<typeof music>, active: () => readonly never[] = () => []) {
  const id = trackIdentity(m.score.tracks[0]);
  return { subscribe: () => () => {}, getState: () => ready, activeNotes: () => active(), scheduledNotes: (track: string) => ({ ...idle, notes: track === id ? m.plan.notes : [], beats: track === id ? m.plan.performedBeats ?? [] : [] }) } as never;
}
function connectedBridge() {
  const sent: boolean[][] = [];
  const bridge = {
    connect: vi.fn(async () => 1),
    sendFrame: vi.fn(async (_session: number, leds: boolean[]) => { sent.push(leds); }),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => ({ session: 0, state: 'disconnected' as const, device: '', message: '', sent: 0, coalesced: 0 })),
    subscribe: vi.fn(async () => () => {}),
  } satisfies FretlightBridge;
  return { bridge, sent };
}
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const lit = (leds: boolean[]) => litSet({ leds, problem: null, dropped: 0 });

beforeEach(() => { localStorage.clear(); announceInstrumentFocus('beat'); });
afterEach(cleanup);

describe('the Fretlight feed', () => {
  it('does nothing, and sends nothing, until the guitar is connected', async () => {
    const { bridge, sent } = connectedBridge(), m = music();
    render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={bridge} />);
    await flush();
    expect(bridge.sendFrame).not.toHaveBeenCalled(); expect(sent).toEqual([]);
  });
  it('lights the selected beat with no instrument view on screen, and follows the selection', async () => {
    const { bridge, sent } = connectedBridge(), m = music();
    const view = render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={bridge} />);
    await act(async () => { await fretlightSession(bridge).connect(); });
    await flush();
    // The low E string is device string 6; the beat's note is at fret 1.
    expect(lit(sent.at(-1)!)).toEqual([{ string: 6, fret: 1 }]);
    view.rerender(<FretlightFeed score={m.score} target={at(1, 2)} player={playerFor(m)} bridge={bridge} />);
    await flush();
    expect(lit(sent.at(-1)!)).toEqual([{ string: 6, fret: 7 }]);
    const count = sent.length;
    // The same lit set again sends nothing.
    view.rerender(<FretlightFeed score={m.score} target={at(1, 2)} player={playerFor(m)} bridge={bridge} />);
    await flush();
    expect(sent).toHaveLength(count);
  });
  it('follows the Show choice: the bar, the next beat, and the notes playing now', async () => {
    const { bridge, sent } = connectedBridge(), m = music();
    const active = [m.plan.notes.find(note => note.key - 40 === 3)!];
    const view = render(<FretlightFeed score={m.score} target={at(1, 0)} player={playerFor(m, () => active as never)} bridge={bridge} />);
    await act(async () => { await fretlightSession(bridge).connect(); });
    await flush();
    act(() => announceInstrumentFocus('bar')); await flush();
    expect(lit(sent.at(-1)!).map(position => position.fret)).toEqual([5, 6, 7, 8]);
    act(() => announceInstrumentFocus('next')); await flush();
    expect(lit(sent.at(-1)!)).toEqual([{ string: 6, fret: 6 }]);
    act(() => announceInstrumentFocus('playing')); await flush();
    expect(lit(sent.at(-1)!)).toEqual([{ string: 6, fret: 3 }]);
    view.unmount();
  });
  it('lights the physical fret under a capo and ignores the tuning', async () => {
    const { bridge, sent } = connectedBridge(), m = music([64, 59, 55, 50, 45, 38], 2);
    render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={bridge} />);
    await act(async () => { await fretlightSession(bridge).connect(); });
    await flush();
    expect(lit(sent.at(-1)!)).toEqual([{ string: 6, fret: 3 }]);
  });
  it('lights the same LEDs whether the on-screen view is left-handed or not', async () => {
    const right = connectedBridge(), m = music([64, 59, 55, 50, 45, 40]);
    render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={right.bridge} />);
    await act(async () => { await fretlightSession(right.bridge).connect(); });
    await flush();
    cleanup();
    // The handedness the instrument view mirrors with is read from the same preferences the feed follows.
    expect(writeInstrumentViewPreferences({ leftHanded: true })).toBe(true);
    expect(readInstrumentViewPreferences().leftHanded).toBe(true);
    const left = connectedBridge();
    render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={left.bridge} />);
    await act(async () => { await fretlightSession(left.bridge).connect(); });
    await flush();
    expect(left.sent.at(-1)).toEqual(right.sent.at(-1));
    expect(lit(left.sent.at(-1)!)).toEqual([{ string: 6, fret: 1 }]);
  });
  it('sends all lights off for a track that is not a six-string guitar and says so', async () => {
    const { bridge, sent } = connectedBridge(), m = music([43, 38, 33, 28]);
    render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={bridge} />);
    await act(async () => { await fretlightSession(bridge).connect(); });
    await flush();
    expect(lit(sent.at(-1)!)).toEqual([]);
    expect(fretlightSession(bridge).get().frameProblem).toBe('not_six_string');
  });
  it('stops following when the guitar is disconnected', async () => {
    const { bridge, sent } = connectedBridge(), m = music();
    const view = render(<FretlightFeed score={m.score} target={at(0, 1)} player={playerFor(m)} bridge={bridge} />);
    await act(async () => { await fretlightSession(bridge).connect(); });
    await flush();
    await act(async () => { await fretlightSession(bridge).disconnect(); });
    const count = sent.length;
    view.rerender(<FretlightFeed score={m.score} target={at(1, 1)} player={playerFor(m)} bridge={bridge} />);
    await flush();
    expect(sent).toHaveLength(count);
    expect(createFretlightSession(bridge)).toBeTruthy();
  });
});
