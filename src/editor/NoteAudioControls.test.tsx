// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TechniquePanel } from './TechniquePanel';
import { music, noteAt, target } from './fixtures';
import { setNoteAudio } from './note-audio';
import { applyNoteTechniques } from './techniques';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })) }));
afterEach(cleanup);

const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const patch = (audio: unknown) => ({ type: 'setNoteTechniques', target, string: 6, patch: { audio } });

it('shows the plain values for a note without settings, and its own for a note with them', () => {
  const score = music(), onEdit = vi.fn(), props = { score, target, string: 6, busy: false, onEdit };
  const view = render(<TechniquePanel {...props} />);
  expect([field(/Sounding length/).value, field(/Start offset/).value, field(/Velocity change/).value]).toEqual(['100', '0', '0']);
  expect(screen.getByRole('button', { name: 'Reset note audio' })).toBeDisabled();
  setNoteAudio(noteAt(score), { length: 60, offset: -12, velocity: 4 });
  view.rerender(<TechniquePanel {...props} score={music()} />);
  expect(field(/Sounding length/).value).toBe('100');
  const other = music(); setNoteAudio(noteAt(other), { length: 60, offset: -12, velocity: 4 });
  view.rerender(<TechniquePanel {...props} score={other} />);
  expect([field(/Sounding length/).value, field(/Start offset/).value, field(/Velocity change/).value]).toEqual(['60', '-12', '4']);
  expect(screen.getByRole('button', { name: 'Reset note audio' })).toBeEnabled();
});

it('commits a value on blur or Enter, never while typing, and sends the other two fields unchanged', () => {
  const score = music(), onEdit = vi.fn();
  render(<TechniquePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} />);
  fireEvent.change(field(/Sounding length/), { target: { value: '5' } });
  fireEvent.change(field(/Sounding length/), { target: { value: '50' } });
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.blur(field(/Sounding length/));
  expect(onEdit).toHaveBeenLastCalledWith(patch({ length: 50, offset: 0, velocity: 0 }));
  fireEvent.change(field(/Start offset/), { target: { value: '-30' } });
  fireEvent.keyDown(field(/Start offset/), { key: 'Enter' });
  expect(onEdit).toHaveBeenLastCalledWith(patch({ length: 50, offset: -30, velocity: 0 }));
  expect(onEdit).toHaveBeenCalledTimes(2);
});

it('refuses an out-of-range or fractional value with a message and restores the last good one', () => {
  const onEdit = vi.fn();
  render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit} />);
  for (const text of ['9', '401', '50.5', '']) {
    fireEvent.change(field(/Sounding length/), { target: { value: text } }); fireEvent.blur(field(/Sounding length/));
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number from 10 to 400/); expect(field(/Sounding length/).value).toBe('100');
  }
  fireEvent.change(field(/Velocity change/), { target: { value: '65' } }); fireEvent.blur(field(/Velocity change/));
  expect(screen.getByRole('alert')).toHaveTextContent(/from -64 to 64/);
  expect(onEdit).not.toHaveBeenCalled();
});

it('clears the settings with the reset button, and when the last field returns to its plain value', () => {
  const score = music(), onEdit = vi.fn(); setNoteAudio(noteAt(score), { length: 50, offset: 0, velocity: 0 });
  render(<TechniquePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reset note audio' }));
  expect(onEdit).toHaveBeenLastCalledWith(patch(null));
  fireEvent.change(field(/Sounding length/), { target: { value: '100' } }); fireEvent.blur(field(/Sounding length/));
  expect(onEdit).toHaveBeenLastCalledWith(patch(null));
});

it('is disabled while busy or locked, and explains a tie destination and a bent note', () => {
  const score = music(), onEdit = vi.fn();
  const view = render(<TechniquePanel score={score} target={target} string={6} busy onEdit={onEdit} />);
  for (const name of [/Sounding length/, /Start offset/, /Velocity change/]) {
    const input = field(name);
    expect(input).not.toHaveAttribute('disabled'); expect(input).toHaveAttribute('aria-disabled', 'true'); expect(input.closest('fieldset')).toHaveAttribute('aria-disabled', 'true');
    input.focus(); fireEvent.change(input, { target: { value: '120' } }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input);
    expect(input).toHaveFocus();
  }
  expect(onEdit).not.toHaveBeenCalled();
  view.unmount();
  const tied = music(); const first = noteAt(tied), second = noteAt(tied, 0, 1);
  first.tieDestination = second; second.tieOrigin = first; second.isTieDestination = true;
  render(<TechniquePanel score={tied} target={{ ...target, beat: 1 }} string={6} busy={false} onEdit={onEdit} />);
  expect(field(/Sounding length/)).toBeDisabled(); expect(screen.getByText(/tied note continues the note before it/)).toBeInTheDocument();
  cleanup();
  const bent = music(); applyNoteTechniques(bent, { target, string: 6 }, { bend: { type: 2, style: 0, points: [{ offset: 0, value: 0 }, { offset: 60, value: 4 }] } });
  render(<TechniquePanel score={bent} target={target} string={6} busy={false} onEdit={onEdit} />);
  expect(field(/Sounding length/)).toBeDisabled(); expect(field(/Start offset/)).toBeDisabled(); expect(field(/Velocity change/)).toBeEnabled();
  expect(screen.getByText(/keeps its start and length/)).toBeInTheDocument();
});

it('sends one edit for Enter followed by blur, and builds a second field on what the first sent', () => {
  const onEdit = vi.fn();
  render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit} />);
  fireEvent.change(field(/Sounding length/), { target: { value: '50' } });
  fireEvent.keyDown(field(/Sounding length/), { key: 'Enter' }); fireEvent.blur(field(/Sounding length/));
  expect(onEdit).toHaveBeenCalledTimes(1);
  // The score has not changed yet: the second field must not undo the first.
  fireEvent.change(field(/Start offset/), { target: { value: '20' } }); fireEvent.blur(field(/Start offset/));
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(onEdit).toHaveBeenLastCalledWith(patch({ length: 50, offset: 20, velocity: 0 }));
});

it('forgets what a refused edit sent, and shows a message', async () => {
  const onEdit = vi.fn(async () => false);
  render(<TechniquePanel score={music()} target={target} string={6} busy={false} onEdit={onEdit} />);
  fireEvent.change(field(/Sounding length/), { target: { value: '50' } }); fireEvent.blur(field(/Sounding length/));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not applied/));
  expect(field(/Sounding length/).value).toBe('100');
  fireEvent.change(field(/Start offset/), { target: { value: '20' } }); fireEvent.blur(field(/Start offset/));
  expect(onEdit).toHaveBeenLastCalledWith(patch({ length: 100, offset: 20, velocity: 0 }));
});

it('busy flipping after a value was typed refuses Enter and blur, records nothing and shows the saved value', () => {
  const score = music(), onEdit = vi.fn(), props = { score, target, string: 6, onEdit };
  const view = render(<TechniquePanel {...props} busy={false} />);
  const input = field(/Sounding length/);
  input.focus(); fireEvent.change(input, { target: { value: '120' } });
  view.rerender(<TechniquePanel {...props} busy />);
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input); fireEvent.doubleClick(input);
  expect(onEdit).not.toHaveBeenCalled();
  expect(input.value).toBe('100');
  expect(input).not.toHaveAttribute('disabled');
});
