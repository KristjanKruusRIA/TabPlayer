// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { heldNotes } from './focus';
import { InstrumentView } from './InstrumentView';
import { LiveInstrumentView } from './LiveInstrumentView';
import { trackIdentity } from '../engine';

afterEach(() => { cleanup(); localStorage.clear(); });
/** Bar 0: beat 0 attacks string 1 fret 3 (G2), beat 1 holds it by a tie, beat 2 attacks string 2 fret 0 (A2), beat 3 holds string 2 by a tie. Bar 1: one fresh note. */
function music(keyboard = false) {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = 'Guitar'; track.playbackInfo.program = keyboard ? 0 : 25;
  if (!keyboard) staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar()); score.addMasterBar(new model.MasterBar());
  const make = (a: number, b: number) => { const note = new model.Note(); if (keyboard) { note.octave = a; note.tone = b; } else { note.string = a; note.fret = b; } return note; };
  const bar = new model.Bar(), voice = new model.Voice(), notes: model.Note[] = [];
  for (const [a, b] of keyboard ? [[5, 7], [5, 7], [5, 9], [5, 9]] : [[1, 3], [1, 3], [2, 0], [2, 0]]) { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; const note = make(a, b); beat.addNote(note); voice.addBeat(beat); notes.push(note); }
  for (const [origin, destination] of [[0, 1], [2, 3]]) { notes[origin].tieDestination = notes[destination]; notes[destination].tieOrigin = notes[origin]; notes[destination].isTieDestination = true; }
  bar.addVoice(voice); staff.addBar(bar);
  const next = new model.Bar(), nextVoice = new model.Voice(), beat = new model.Beat(); beat.duration = model.Duration.Quarter; beat.addNote(make(keyboard ? 5 : 3, keyboard ? 0 : 2)); nextVoice.addBeat(beat); next.addVoice(nextVoice); staff.addBar(next);
  score.finish(new Settings());
  return { score, plan: buildPlaybackPlan(score, 1) };
}
const at = (bar: number, beat: number) => ({ track: 0, staff: 0, bar, voice: 0, beat });
const inBar = (plan: ReturnType<typeof buildPlaybackPlan>) => plan.notes.filter(note => note.source.target.bar === 0);

it('finds the tied continuations of the selected beat or bar, which the playback plan leaves out', () => {
  const { score, plan } = music();
  expect(inBar(plan)).toHaveLength(2);
  expect(heldNotes(score, 'beat', at(0, 1)).map(note => [note.source.target.beat, note.source.string, note.key])).toEqual([[1, 1, 43]]);
  expect(heldNotes(score, 'beat', at(0, 0))).toEqual([]);
  expect(heldNotes(score, 'bar', at(0, 0)).map(note => note.source.target.beat)).toEqual([1, 3]);
  expect(heldNotes(score, 'bar', at(1, 0))).toEqual([]);
  expect(heldNotes(score, 'playing', at(0, 1))).toEqual([]);
  expect(heldNotes(score, 'next', at(0, 0))).toEqual([]);
  expect(heldNotes(score, 'beat', null)).toEqual([]);
  expect(heldNotes(score, 'beat', at(9, 9))).toEqual([]);
});

it('draws a tied continuation on the neck as held, different from a fresh note, and says so', () => {
  const { score, plan } = music(), held = heldNotes(score, 'bar', at(0, 0)), { container } = render(<InstrumentView score={score} track={0} staff={0} notes={inBar(plan)} held={held} caption="Notes in the selected bar" />);
  const marks = [...container.querySelectorAll('g[data-note-id]')];
  expect(marks).toHaveLength(4);
  const tied = marks.filter(mark => mark.getAttribute('data-held') === 'true'), fresh = marks.filter(mark => mark.getAttribute('data-held') === null);
  expect(tied.map(mark => [mark.getAttribute('data-string'), mark.getAttribute('data-fret')])).toEqual([['1', '3'], ['2', '0']]);
  expect(fresh).toHaveLength(2); expect(tied.every(mark => mark.classList.contains('held'))).toBe(true); expect(fresh.some(mark => mark.classList.contains('held'))).toBe(false);
  expect(tied[0].querySelector('title')).toHaveTextContent('G2 · string 1 · fret 3 · tied, held from an earlier note');
  expect(screen.getByRole('group', { name: 'Notes in the selected bar' })).toHaveTextContent('G2 (tied)');
});

it('shows a held key differently on the keyboard, and a key that is also freshly struck stays fresh', () => {
  const { score, plan } = music(true), held = heldNotes(score, 'bar', at(0, 0)), { container } = render(<InstrumentView score={score} track={0} staff={0} notes={[]} held={held} />);
  const g = (key: number) => container.querySelector(`g[data-key="${key}"]`)!;
  expect(g(67)).toHaveAttribute('data-active', 'true'); expect(g(67)).toHaveAttribute('data-held', 'true'); expect(g(67).classList.contains('held')).toBe(true);
  cleanup();
  const struck = inBar(plan).filter(note => note.key === 67), again = render(<InstrumentView score={score} track={0} staff={0} notes={struck} held={held} />);
  expect(struck).toHaveLength(1);
  expect(again.container.querySelector('g[data-key="67"]')).toHaveAttribute('data-active', 'true');
  expect(again.container.querySelector('g[data-key="67"]')).not.toHaveAttribute('data-held');
});

it('shows the tied continuations of the selected beat in edit mode, where marks come from the score', () => {
  const { score } = music(), onEdit = () => {};
  const view = (beat: number) => <InstrumentView score={score} track={0} staff={0} notes={[]} entry={{ target: at(0, beat), busy: false, onEdit }} />;
  const { container, rerender } = render(view(1));
  expect(container.querySelector('g[data-note-id][data-held="true"]')).toHaveAttribute('data-fret', '3');
  rerender(view(0));
  expect(container.querySelector('g[data-note-id]')).not.toHaveAttribute('data-held');
});

it('lets the live view show tied continuations for the selected beat and bar', () => {
  const { score, plan } = music(), id = trackIdentity(score.tracks[0]), ready = { ready: true, error: null };
  const scheduled = { tick: null, counting: false, loop: null, range: null, notes: plan.notes, beats: plan.performedBeats ?? [] };
  const player = { subscribe: () => () => {}, getState: () => ready, activeNotes: () => [], scheduledNotes: (track: string) => track === id ? scheduled : { ...scheduled, notes: [], beats: [] } };
  const { container } = render(<LiveInstrumentView score={score} track={0} staff={0} target={at(0, 1)} player={player as never} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'beat' } });
  expect(container.querySelectorAll('g[data-note-id][data-held="true"]')).toHaveLength(1);
  expect(screen.getByRole('group', { name: 'Notes in the selected beat' })).toHaveTextContent('G2 (tied)');
  fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'bar' } });
  expect(container.querySelectorAll('g[data-note-id][data-held="true"]')).toHaveLength(2);
});
