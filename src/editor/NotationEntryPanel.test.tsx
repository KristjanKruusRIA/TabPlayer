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
function Harness({ target, edits: first = base, locked = false, busy = false, refuse = false, stale = false, gate, log }: { target: typeof pitched; edits?: EditCommand[]; locked?: boolean; busy?: boolean; refuse?: boolean; stale?: boolean; gate?: Promise<void>; log: EditCommand[] }) {
  const [edits, setEdits] = useState(first), list = useRef(first), latest = useRef<model.Score>(null!);
  const score = buildScore({ ...blankProject(), edits });
  latest.current = score;
  const onEdit = async (command: EditCommand) => {
    if (gate) await gate;
    if (refuse) return false;
    const next = [...list.current, command];
    try { latest.current = buildScore({ ...blankProject(), edits: next }); } catch { return false; }
    log.push(command); list.current = next; setEdits(next);
    return true;
  };
  return <NotationEntryPanel score={score} target={target} busy={busy} locked={locked} onEdit={onEdit} preview={command => stale ? buildScore({ ...blankProject(), edits: first }) : buildScore({ ...blankProject(), edits: [...list.current, command] })} />;
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
  await press('PageUp'); expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 5');
  await press('-'); await press('B');
  // Bb5 reads as a flat in a key without flats, so its spelling goes in the same edit as the note; F# needs none.
  expect(log.map(command => command.type === 'addPitchedNote' ? command.pitch : command.type === 'sequence' ? command.commands.map(step => step.type) : command.type)).toEqual([60, 66, ['addPitchedNote', 'setNoteSpelling']]);
  await press('PageDown'); await press('PageDown'); await press('b');
  expect(screen.getByRole('button', { name: 'Remove B3' })).toBeInTheDocument();
});
it('writes a flat and its spelling as one edit when automatic spelling would read a sharp', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await press('-'); await press('b');
  expect(log).toEqual([{ type: 'sequence', commands: [{ type: 'addPitchedNote', target: pitched, pitch: 70 }, { type: 'setNoteSpelling', target: pitched, noteIndex: 0, accidentalMode: 5 }] }]);
  await press('#'); await press('f');
  expect(log).toHaveLength(2);
});
it('offers both doubles and writes them as one spelled edit', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Spell with double sharp' })); });
  expect(screen.getByRole('button', { name: 'Spell with double sharp' })).toHaveAttribute('aria-pressed', 'true');
  await press('c');
  expect(log).toEqual([{ type: 'sequence', commands: [{ type: 'addPitchedNote', target: pitched, pitch: 62 }, { type: 'setNoteSpelling', target: pitched, noteIndex: 0, accidentalMode: 4 }] }]);
  expect(screen.getByRole('status')).toHaveTextContent('Entered C##4');
  expect(screen.getByRole('button', { name: 'Key signature' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Spell with double flat' })); });
  await press('b');
  expect(log).toHaveLength(2);
  expect(log[1]).toEqual({ type: 'sequence', commands: [{ type: 'addPitchedNote', target: pitched, pitch: 69 }, { type: 'setNoteSpelling', target: pitched, noteIndex: 1, accidentalMode: 6 }] });
});
it('moves to the octave of a clicked note', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  await act(async () => { fireEvent.click(target('D5')); });
  expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 5');
  await press('e');
  expect(log[1]).toEqual({ type: 'addPitchedNote', target: pitched, pitch: 76 });
});
it('enters on a fretted staff at the pitch the staff displays and refuses what no string can play', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={fretted} edits={[]} log={log} />);
  // A blank-project guitar draws sounding pitch (display transposition 0), so E4 is the open first string.
  await act(async () => { fireEvent.click(target('E4')); });
  expect(log).toEqual([{ type: 'setNote', target: fretted, string: 6, fret: 0 }]);
  await settle();
  for (let i = 0; i < 4; i++) await press('PageUp');
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
  // Keys change nothing while the staff is unavailable.
  render(<Harness target={pitched} log={log} locked />);
  for (const key of ['#', 'n', 'PageUp', 'ArrowUp', 'Enter']) await press(key);
  expect(screen.getByRole('button', { name: 'Key signature' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 4'); expect(log).toEqual([]);
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
  expect(screen.getByRole('status')).toHaveTextContent(/refused/);
  expect(screen.getByTestId('entry-octave')).toHaveTextContent('Octave 4');
  expect(vi.isMockFunction(console.error)).toBe(false);
});
it('draws existing notes where their spelling puts them', () => {
  const log: EditCommand[] = [];
  const spell = (pitch: number, accidentalMode: number): EditCommand[] => [{ type: 'addPitchedNote', target: pitched, pitch }, { type: 'setNoteSpelling', target: pitched, noteIndex: 0, accidentalMode }];
  const step = (edits: EditCommand[]) => { cleanup(); const { container } = render(<Harness target={pitched} edits={[...base, ...edits]} log={log} />); return container.querySelector('[data-note-step]')!.getAttribute('data-note-step'); };
  // Bb4 in C sits on the B line (step 4), B#3 on C4 (step -3 is B3), Cb4 on the C below the staff.
  expect(step(spell(70, 5))).toBe('4'); expect(step(spell(70, 0))).toBe('3');
  expect(step(spell(60, 3))).toBe('-3'); expect(step(spell(59, 5))).toBe('-2');
});
it('ignores held keys and says when a key arrives during an entry', async () => {
  const log: EditCommand[] = [];
  let release!: () => void;
  render(<Harness target={pitched} log={log} gate={new Promise<void>(accept => { release = accept; })} />);
  await act(async () => { fireEvent.keyDown(staff(), { key: 'c' }); fireEvent.keyDown(staff(), { key: 'c', repeat: true }); });
  await act(async () => { fireEvent.keyDown(staff(), { key: 'd' }); });
  expect(screen.getByRole('status')).toHaveTextContent(/previous note/);
  await act(async () => { release(); });
  expect(log).toEqual([{ type: 'addPitchedNote', target: pitched, pitch: 60 }]);
});
it('moves a cursor with the arrow keys and writes there with Enter or Space', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} />);
  expect(staff()).toHaveAttribute('aria-activedescendant', target('E4').id);
  await press('ArrowUp'); await press('ArrowUp'); await press('Enter');
  expect(target('Remove G4')).toHaveAttribute('data-step', '2');
  await press('ArrowDown'); await press(' ');
  expect(log).toEqual([{ type: 'addPitchedNote', target: pitched, pitch: 67 }, { type: 'addPitchedNote', target: pitched, pitch: 65 }]);
});
it('does not claim an entry whose note cannot be found afterwards', async () => {
  const log: EditCommand[] = [];
  render(<Harness target={pitched} log={log} stale />);
  await press('c');
  expect(screen.getByRole('status')).not.toHaveTextContent(/^Entered/); expect(screen.getByRole('status')).toHaveTextContent(/could not be found/);
});
