// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import './plugin-test-support';
import { SoundSummary } from './SoundSummary';
import { soundPreset } from './sound-model';
import { forgetSessionSoundLibrary, forgetSoundClipboard } from './sound-library';

afterEach(() => { cleanup(); forgetSessionSoundLibrary(); forgetSoundClipboard(); localStorage.clear(); });
const recorded = (onEdit: ReturnType<typeof vi.fn>) => onEdit.mock.calls.at(-1)?.[0];

it('shows the source, the preset and one chip for each pedal switched on, in the chain order, instead of every pedal row', () => {
  render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
  const strip = within(screen.getByRole('list', { name: 'Effects switched on' }));
  const names = strip.getAllByRole('button').map(button => button.textContent);
  expect(names).toEqual(expect.arrayContaining(['Amp', 'Cabinet', 'Delay', 'Reverb']));
  expect(names).not.toContain('Gate');
  expect(screen.queryByText('Signal chain')).toBeNull();expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  expect(screen.getByLabelText('Sound source')).toBeInTheDocument();expect(screen.getByLabelText('Sound preset')).toHaveValue('lead');
});

it('the preset and the source record one setTrackSound each, and choosing the current one records nothing', () => {
  const onEdit = vi.fn();
  render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Sound preset'), { target: { value: 'clean' } });
  expect(onEdit).toHaveBeenCalledTimes(1);expect(recorded(onEdit)).toMatchObject({ type: 'setTrackSound', trackId: 'guitar', sound: soundPreset('clean') });
  fireEvent.change(screen.getByLabelText('Sound source'), { target: { value: 'green-guitar' } });
  expect(recorded(onEdit).sound).toMatchObject({ voiceId: 'green-guitar', presetId: 'lead' });
  expect(onEdit).toHaveBeenCalledTimes(2);
});

it('a chip opens the sound editor on that pedal; the editor holds everything the inspector held and Escape returns focus to the chip', () => {
  render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
  const chip = screen.getByRole('button', { name: 'Edit Delay' });expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
  chip.focus();fireEvent.click(chip);
  const dialog = screen.getByRole('dialog', { name: 'Sound and pedalboard' });
  expect(within(dialog).getByText('Delay', { selector: '.sound-block-name' }).closest('details')).toHaveAttribute('open');
  for (const label of ['Lock sound', 'Factory sound', 'Saved sound', 'Copy sound', 'Paste sound']) expect(within(dialog).getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();expect(chip).toHaveFocus();
});

it('a pedal switched on in the editor is one recorded edit, as before', () => {
  const onEdit = vi.fn();
  render(<SoundSummary trackId="guitar" sound={soundPreset('clean')} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sound and pedalboard…' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Sound and pedalboard' }));
  fireEvent.click(dialog.getByText('Chorus', { selector: '.sound-block-name' }));
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Enable chorus' }));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(recorded(onEdit).sound.effects.chorus.enabled).toBe(true);
});

it('while busy the selects keep focus and refuse, and the buttons that only open the editor still work', () => {
  const onEdit = vi.fn();
  const view = render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={onEdit} />);
  const preset = screen.getByLabelText('Sound preset');preset.focus();
  view.rerender(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={onEdit} busy />);
  expect(preset).toHaveFocus();expect(preset).not.toBeDisabled();fireEvent.change(preset, { target: { value: 'clean' } });expect(onEdit).not.toHaveBeenCalled();
});

it('the sound editor is drawn on the document body, not inside the inspector', () => {
  const view = render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Delay' }));
  expect(view.container.contains(screen.getByRole('dialog', { name: 'Sound and pedalboard' }))).toBe(false);
});
