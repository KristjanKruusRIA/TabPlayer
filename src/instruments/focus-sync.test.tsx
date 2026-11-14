// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { LiveInstrumentView } from './LiveInstrumentView';
import { announceInstrumentFocus, currentInstrumentFocus } from './view-preferences';

afterEach(() => { cleanup(); localStorage.clear(); announceInstrumentFocus('playing'); });
const at = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
function guitar() {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff();
  track.playbackInfo.program = 25; staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.duration = model.Duration.Quarter;
  voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return score;
}
function player() {
  let state = { ready: true, error: null };
  const listeners = new Set<() => void>(), activeNotes = vi.fn(() => []);
  return { activeNotes, tick: () => { state = { ready: true, error: null }; listeners.forEach(listener => listener()); }, api: { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getState: () => state, activeNotes, scheduledNotes: () => ({ notes: [], beats: [], tick: null, counting: false, loop: null, range: null }) } as never };
}

it('keeps every open instrument view on the same Show choice, whoever changes it, and adds no renders per playback tick', () => {
  const score = guitar(), p = player();
  render(<><LiveInstrumentView score={score} track={0} staff={0} target={at} player={p.api} /><LiveInstrumentView panel="keyboard" score={score} track={0} staff={0} target={at} player={p.api} /></>);
  const selects = () => screen.getAllByRole('combobox', { name: 'Show' }) as HTMLSelectElement[];
  expect(selects().map(select => select.value)).toEqual(['playing', 'playing']);
  // A choice made in one view reaches the other, and the one made from outside (the Fretlight section) reaches both.
  fireEvent.change(selects()[0], { target: { value: 'bar' } });
  expect(selects().map(select => select.value)).toEqual(['bar', 'bar']);
  act(() => announceInstrumentFocus('next'));
  expect(selects().map(select => select.value)).toEqual(['next', 'next']);
  expect(currentInstrumentFocus()).toBe('next');
  // A playback tick renders each view once, as before.
  const before = p.activeNotes.mock.calls.length;
  act(() => p.tick());
  expect(p.activeNotes.mock.calls.length - before).toBe(2);
});
