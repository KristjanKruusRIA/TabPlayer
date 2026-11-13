// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { InstrumentView } from './InstrumentView';
import { LiveInstrumentView } from './LiveInstrumentView';

afterEach(() => { cleanup(); localStorage.clear(); });
/** Bar 0 beat 0 holds E2 (string 1 fret 0) and C4 (string 5 fret 1); bar 0 beat 1 holds A2 (string 2 fret 0). */
function music(keyboard = false) {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = 'Guitar'; track.playbackInfo.program = keyboard ? 0 : 25;
  if (!keyboard) staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice();
  const quarter = (notes: [number, number][]) => { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; for (const [a, b] of notes) { const note = new model.Note(); if (keyboard) { note.octave = a; note.tone = b; } else { note.string = a; note.fret = b; } beat.addNote(note); } voice.addBeat(beat); };
  if (keyboard) { quarter([[5, 0], [5, 4]]); quarter([[5, 7]]); } else { quarter([[1, 0], [5, 1]]); quarter([[2, 0]]); }
  bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  return { score, notes: buildPlaybackPlan(score, 1).notes };
}
const at = (beat: number) => ({ track: 0, staff: 0, bar: 0, voice: 0, beat });

it('selects the matching note in the score when a note on the neck is clicked', () => {
  const { score, notes } = music(), onSelect = vi.fn(), { container } = render(<InstrumentView score={score} track={0} staff={0} notes={notes} onSelect={onSelect} />);
  fireEvent.click(container.querySelector('g[data-note-id][data-string="5"]')!);
  expect(onSelect).toHaveBeenCalledWith(at(0), 5, 1);
  fireEvent.click(container.querySelector('g[data-note-id][data-string="2"]')!);
  expect(onSelect).toHaveBeenLastCalledWith(at(1), 2, 0);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it('lets keyboard users select a note on the neck and names the control', () => {
  const { score, notes } = music(), onSelect = vi.fn(), { container } = render(<InstrumentView score={score} track={0} staff={0} notes={notes} onSelect={onSelect} />);
  const note = screen.getByRole('button', { name: 'Select C4 in the score' });
  expect(note).toHaveAttribute('tabindex', '0'); expect(container.querySelectorAll('g[data-note-id][role="button"]')).toHaveLength(3);
  fireEvent.keyDown(note, { key: 'Enter' }); fireEvent.keyDown(note, { key: ' ' }); fireEvent.keyDown(note, { key: 'a' });
  expect(onSelect).toHaveBeenCalledTimes(2); expect(onSelect).toHaveBeenCalledWith(at(0), 5, 1);
});

it('selects the beat that holds a lit key on the keyboard, and leaves other keys alone', () => {
  const { score, notes } = music(true), onSelect = vi.fn(), { container } = render(<InstrumentView score={score} track={0} staff={0} notes={notes} onSelect={onSelect} />);
  fireEvent.click(container.querySelector('g[data-key="67"]')!);
  expect(onSelect).toHaveBeenCalledWith(at(1), undefined, 0);
  fireEvent.click(container.querySelector('g[data-key="64"]')!);
  expect(onSelect).toHaveBeenLastCalledWith(at(0), undefined, 1);
  fireEvent.click(container.querySelector('g[data-key="62"]')!);
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(container.querySelector('g[data-key="62"]')).not.toHaveAttribute('role');
});

it('does nothing without a selection handler, and edits instead of selecting in entry mode', () => {
  const { score, notes } = music(), onSelect = vi.fn(), onEdit = vi.fn();
  const plain = render(<InstrumentView score={score} track={0} staff={0} notes={notes} />);
  expect(plain.container.querySelector('g[data-note-id][role]')).toBeNull(); cleanup();
  const { container } = render(<InstrumentView score={score} track={0} staff={0} notes={[]} onSelect={onSelect} entry={{ target: at(0), busy: false, onEdit }} />);
  fireEvent.click(container.querySelector('[data-entry-string="3"][data-entry-fret="2"]')!);
  expect(onEdit).toHaveBeenCalledTimes(1); expect(onSelect).not.toHaveBeenCalled();
  expect(container.querySelector('g[data-note-id][role]')).toBeNull();
});

it('passes the selection from the live view and keeps playback marks selectable', () => {
  const { score } = music(), onSelect = vi.fn(), plan = buildPlaybackPlan(score, 1), ready = { ready: true, error: null };
  const player = { subscribe: () => () => {}, getState: () => ready, activeNotes: () => plan.notes.slice(0, 1), scheduledNotes: () => null };
  const { container } = render(<LiveInstrumentView score={score} track={0} staff={0} target={at(0)} player={player as never} onSelect={onSelect} />);
  fireEvent.click(container.querySelector('g[data-note-id]')!);
  expect(onSelect).toHaveBeenCalledTimes(1); expect(onSelect.mock.calls[0][0]).toEqual(at(0));
});
