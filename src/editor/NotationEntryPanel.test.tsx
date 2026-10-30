// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { buildScore } from '../engine';
import { blankProject, type EditCommand } from '../project';
import { NotationEntryPanel } from './NotationEntryPanel';

afterEach(cleanup);
const base: EditCommand[] = [{ type: 'addPitchedTrack', name: 'Piano', program: 0 }];
const pitched = { track: 1, staff: 0, bar: 0, voice: 0, beat: 0 }, fretted = { ...pitched, track: 0 };

/** Applies each accepted edit to a real score, the way the app does, and lets a test refuse edits. */
function Harness({ target, edits: first = base, locked = false, busy = false, refuse = false, log }: { target: typeof pitched; edits?: EditCommand[]; locked?: boolean; busy?: boolean; refuse?: boolean; log: EditCommand[] }) {
  const [edits, setEdits] = useState(first), list = useRef(first), latest = useRef<model.Score>(null!);
  const score = buildScore({ ...blankProject(), edits });
  latest.current = score;
  const onEdit = async (command: EditCommand) => {
    if (refuse) return false;
    const next = [...list.current, command];
    try { latest.current = buildScore({ ...blankProject(), edits: next }); } catch { return false; }
    log.push(command); list.current = next; setEdits(next);
    return true;
  };
  return <NotationEntryPanel score={score} target={target} busy={busy} locked={locked} onEdit={onEdit} latestScore={() => latest.current} />;
}
const staff = () => screen.getByRole('group', { name: 'Pitch entry staff' });
const target = (name: string) => screen.getByRole('button', { name });
const press = async (key: string) => { await act(async () => { fireEvent.keyDown(staff(), { key }); }); };
const settle = () => act(async () => { await Promise.resolve(); });

it('writes the pitch of the clicked line and names every target', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  expect(target('E4')).toHaveAttribute('data-step', '0');
  await act(async () => { fireEvent.click(target('G4')); });
  expect(log).toEqual([{ type: 'addPitchedNote', target: pitched, pitch: 67 }]);
  expect(screen.getByRole('status')).toHaveTextContent('Entered G4');
  expect(target('Remove G4')).toBeInTheDocument();
  await act(async () => { fireEvent.click(target('Remove G4')); });
  expect(log[1]).toMatchObject({ type: 'removeNoteByIndex', noteIndex: 0 });
  expect(screen.getByRole('status')).toHaveTextContent('Removed G4');
});
it('enters letters in the chosen octave with accidentals that last for one note', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await press('c');
  await press('#'); expect(screen.getByRole('button', { name: 'Sharp' })).toHaveAttribute('aria-pressed', 'true');
  await press('f');
  expect(screen.getByRole('button', { name: 'Key signature' })).toHaveAttribute('aria-pressed', 'true');
  await press('ArrowUp'); expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 5');
  await press('-'); await press('B');
  // Bb5 reads as a flat in a key without flats, so the new note gets a spelling edit of its own; F# does not.
  expect(log.map(command => command.type === 'addPitchedNote' ? command.pitch : command.type)).toEqual([60, 66, 82, 'setNoteSpelling']);
  await press('ArrowDown'); await press('ArrowDown'); await press('b');
  expect(screen.getByRole('button', { name: 'Remove B3' })).toBeInTheDocument();
});
it('sets the spelling of a flat as a second edit when automatic spelling would read a sharp', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await press('-'); await press('b');
  expect(log).toEqual([{ type: 'addPitchedNote', target: pitched, pitch: 70 }, { type: 'setNoteSpelling', target: pitched, noteIndex: 0, accidentalMode: 5 }]);
  await press('#'); await press('f');
  expect(log).toHaveLength(3);
});
it('moves to the octave of a clicked note', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await act(async () => { fireEvent.click(target('D5')); });
  expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 5');
  await press('e');
  expect(log[1]).toEqual({ type: 'addPitchedNote', target: pitched, pitch: 76 });
});
it('enters on a fretted staff as the sounding pitch and continues from the written string', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={fretted} edits={[]} log={log} />);
  await act(async () => { fireEvent.click(target('E4')); });
  expect(log).toEqual([{ type: 'setNote', target: fretted, string: 3, fret: 2 }]);
  await settle();
  for (let i = 0; i < 4; i++) await press('ArrowUp');
  await press('e');
  expect(screen.getByRole('status')).toHaveTextContent('No free string can play E8');
  expect(log).toHaveLength(1);
});
it('is unavailable while locked or busy, and on a percussion staff', async () => {
  const log: EditCommand[] = [];
  const { rerender } = render(<Harness target={pitched} log={log} locked />);
  await act(async () => { fireEvent.click(target('E4')); }); await press('c');
  expect(log).toEqual([]); expect(screen.getByRole('button', { name: 'Sharp' })).toBeDisabled();
  rerender(<Harness target={pitched} log={log} busy />);
  await press('c'); expect(log).toEqual([]);
  cleanup();
  render(<Harness target={{ ...pitched, track: 2 }} edits={[...base, { type: 'addPercussionTrack', name: 'Drums', program: 0 }]} log={log} />);
  expect(screen.getByRole('status')).toHaveTextContent(/drum kit/);
  await press('c'); expect(log).toEqual([]);
});
it('reports nothing as entered when the edit is refused', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} refuse />);
  await press('c');
  expect(log).toEqual([]); expect(screen.getByRole('status')).not.toHaveTextContent('Entered');
  expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 4');
  expect(vi.isMockFunction(console.error)).toBe(false);
});
