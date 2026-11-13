// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { music, target } from '../editor/fixtures';
import { ScaleToolPanel } from './ScaleToolPanel';

afterEach(cleanup);
const beatOf = (score: model.Score) => score.tracks[0].staves[0].bars[0].voices[0].beats[0];
const panel = (score: model.Score, onNote?: (...args: unknown[]) => void, extra: Partial<Parameters<typeof ScaleToolPanel>[0]> = {}) =>
  <ScaleToolPanel score={score} selection={null} busy={false} onClose={() => {}} target={target} beat={beatOf(score)} onNote={onNote} {...extra} />;

it('puts a clicked scale position on the selected beat through the existing set-note command', () => {
  const score = music(), onNote = vi.fn(); render(panel(score, onNote));
  // The fixture beat holds string 6 fret 3. C major on the first string (open E, the lowest) has its notes at frets 1, 3, 5, 7.
  fireEvent.click(screen.getByRole('button', { name: 'Put F2 on string 1, fret 1 of the selected beat' }));
  expect(onNote).toHaveBeenCalledTimes(1);
  expect(onNote).toHaveBeenCalledWith({ type: 'setNote', target, string: 1, fret: 1 }, { string: 1, fret: 1 });
  expect(screen.getByText(/Click a scale position to put that note on the selected beat/)).toBeInTheDocument();
});

it('records nothing for a position the beat already holds, and leaves other states alone', () => {
  const score = music(), onNote = vi.fn(); render(panel(score, onNote));
  // String 6 is the highest string (open E4): fret 3 is G4.
  fireEvent.click(screen.getByRole('button', { name: 'Put G4 on string 6, fret 3 of the selected beat' }));
  expect(onNote).not.toHaveBeenCalled();
  const before = model.JsonConverter.scoreToJson(score); fireEvent.click(screen.getByRole('button', { name: 'Put F2 on string 1, fret 1 of the selected beat' })); expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('is plain browsing without an edit handler, a selected written beat, or while busy, and refuses the keys of other staves', () => {
  const score = music();
  const plain = render(panel(score)); expect(screen.queryByRole('button', { name: /^Put / })).toBeNull(); expect(screen.queryByText(/Click a scale position/)).toBeNull(); plain.unmount();
  const noBeat = render(<ScaleToolPanel score={score} selection={null} busy={false} onClose={() => {}} onNote={vi.fn()} />); expect(screen.queryByRole('button', { name: /^Put / })).toBeNull(); noBeat.unmount();
  const empty = music(); beatOf(empty).isEmpty = true;
  const none = render(panel(empty, vi.fn())); expect(screen.queryByRole('button', { name: /^Put / })).toBeNull(); none.unmount();
  const onNote = vi.fn(); render(panel(score, onNote, { busy: true }));
  const position = screen.getByRole('button', { name: 'Put F2 on string 1, fret 1 of the selected beat' });
  expect(position).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(position); expect(onNote).not.toHaveBeenCalled();
});

it('puts a clicked key of the scale keyboard on the selected beat as a pitched note, and ignores the one it holds', () => {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff(); track.name = 'Piano'; track.addStaff(staff); score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.duration = model.Duration.Quarter;
  const held = new model.Note(); held.octave = 5; held.tone = 4; beat.addNote(held); voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar); score.finish(new Settings());
  const onNote = vi.fn(); render(<ScaleToolPanel score={score} selection={null} busy={false} onClose={() => {}} target={target} beat={beat} onNote={onNote} />);
  fireEvent.click(screen.getByRole('button', { name: 'Put G4 on the selected beat' }));
  expect(onNote).toHaveBeenCalledWith({ type: 'addPitchedNote', target, pitch: 67 }, { note: { pitch: 67 } });
  onNote.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Put E4 on the selected beat' })); expect(onNote).not.toHaveBeenCalled();
});

it('lets a keyboard user put a scale position on the beat', () => {
  const score = music(), onNote = vi.fn(); render(panel(score, onNote));
  const position = screen.getByRole('button', { name: 'Put F2 on string 1, fret 1 of the selected beat' });
  expect(position).toHaveAttribute('tabindex', '0'); fireEvent.keyDown(position, { key: 'Enter' }); fireEvent.keyDown(position, { key: ' ' }); fireEvent.keyDown(position, { key: 'x' });
  expect(onNote).toHaveBeenCalledTimes(2);
});
