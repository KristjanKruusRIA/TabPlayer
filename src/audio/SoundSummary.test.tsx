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

it('a drum track names its automatic source as the recorded drum kit, in the summary and the editor, unless its kit is one the sound bank plays', () => {
  const { rerender } = render(<SoundSummary trackId="drums" percussion sound={soundPreset('gm')} onEdit={vi.fn()} />);
  const first = (select: HTMLElement) => (select as HTMLSelectElement).options[0];
  expect(first(screen.getByLabelText('Sound source')).textContent).toBe('Recorded drum kit');expect(first(screen.getByLabelText('Sound source')).value).toBe('');
  const offered = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map(option => option.textContent);
  expect(offered(screen.getByLabelText('Sound source'))).toEqual(['Recorded drum kit', 'General MIDI drums']);
  fireEvent.click(screen.getByRole('button', { name: /Sound and pedalboard|Open/ }));
  expect(first(within(screen.getByRole('dialog')).getByLabelText('Sound source')).textContent).toBe('Recorded drum kit');
  fireEvent.keyDown(document, { key: 'Escape' });
  rerender(<SoundSummary trackId="drums" percussion sound={{ ...soundPreset('gm'), drumKit: 8 }} onEdit={vi.fn()} />);
  expect(first(screen.getByLabelText('Sound source')).textContent).toBe('Automatic instrument');
  // A guitar voice a drum track already stores stays in its list, so the list shows what is set.
  rerender(<SoundSummary trackId="drums" percussion sound={{ ...soundPreset('gm'), voiceId: 'green-guitar' }} onEdit={vi.fn()} />);
  expect(offered(screen.getByLabelText('Sound source'))).toEqual(['Recorded drum kit', 'General MIDI drums', 'Green Guitar']);expect(screen.getByLabelText('Sound source')).toHaveValue('green-guitar');
  rerender(<SoundSummary trackId="guitar" sound={soundPreset('gm')} onEdit={vi.fn()} />);
  expect(offered(screen.getByLabelText('Sound source'))).toEqual(['Automatic instrument', 'General MIDI', 'Green Guitar', 'Black Guitar', 'Darkblack Bass', 'Babyblue Bass']);
  expect(first(screen.getByLabelText('Sound source')).textContent).toBe('Automatic instrument');
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

const slot = { format: 'vst3' as const, classId: 'A'.repeat(32), name: 'Amp Rig', vendor: 'Vendor', active: true, inputDb: 0, outputDb: 0, state: '' };
it('has a Plug-in row naming the chosen plug-in, its state when it is not ready, or None', () => {
  const { rerender } = render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
  const row = () => document.querySelector('.sound-plugin-row') as HTMLElement;
  expect(row()).toHaveTextContent('Plug-in');expect(row()).toHaveTextContent('None');
  rerender(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: slot }} onEdit={vi.fn()} status="ready" />);
  expect(row()).toHaveTextContent('Amp Rig');expect(row()).not.toHaveTextContent('Ready');
  rerender(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: slot }} onEdit={vi.fn()} status="missing" />);
  expect(row()).toHaveTextContent('Amp Rig · Missing');
  rerender(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: { ...slot, active: false } }} onEdit={vi.fn()} status="ready" />);
  expect(row()).toHaveTextContent('Amp Rig · Bypassed');
});
const dialogs = () => screen.queryAllByRole('dialog');
it.each([['a guitar track', false], ['a drum track', true]])('the Plug-in… button opens the Plug-in dialog with the plug-in slot and nothing of the sound editor, for %s', (_name, percussion) => {
  const onEdit = vi.fn();
  render(<SoundSummary trackId="track" percussion={percussion} sound={soundPreset(percussion ? 'gm' : 'lead')} onEdit={onEdit} />);
  const open = screen.getByRole('button', { name: 'Plug-in…' });expect(open).toHaveAttribute('aria-haspopup', 'dialog');
  open.focus();fireEvent.click(open);
  expect(dialogs()).toHaveLength(1);
  const dialog = within(screen.getByRole('dialog', { name: 'Plug-in' }));
  expect(dialog.getByRole('combobox', { name: 'VST3 plug-in' })).toHaveFocus();expect(dialog.getByRole('button', { name: 'Add plug-in…' })).toBeInTheDocument();
  for (const label of ['Sound source', 'Sound preset', 'Saved sound', 'Factory sound']) expect(dialog.queryByLabelText(label)).toBeNull();
  for (const text of ['My sounds', 'Signal chain', 'Copy sound']) expect(dialog.queryByText(text)).toBeNull();
  expect(document.querySelector('.plugin-dialog .sound-block')).toBeNull();expect(document.querySelector('.plugin-dialog .drum-kit')).toBeNull();
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });expect(screen.queryByRole('dialog')).toBeNull();expect(open).toHaveFocus();
});
it('Sound and pedalboard… opens the sound dialog without the plug-in slot, and its focus returns to the button', () => {
  render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} />);
  const open = screen.getByRole('button', { name: 'Sound and pedalboard…' });open.focus();fireEvent.click(open);
  expect(dialogs()).toHaveLength(1);const dialog = within(screen.getByRole('dialog', { name: 'Sound and pedalboard' }));
  expect(dialog.getByText('My sounds')).toBeInTheDocument();expect(dialog.getByText('Signal chain')).toBeInTheDocument();
  expect(dialog.queryByRole('combobox', { name: 'VST3 plug-in' })).toBeNull();expect(dialog.queryByRole('button', { name: 'Add plug-in…' })).toBeNull();expect(document.querySelector('.sound-dialog .sound-plugin-slot')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });expect(open).toHaveFocus();
});
it('a request from the Sound menu opens the Plug-in dialog once and says it was taken', () => {
  const taken = vi.fn();
  const { rerender } = render(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} request={null} onRequestHandled={taken} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<SoundSummary trackId="guitar" sound={soundPreset('lead')} onEdit={vi.fn()} request="plugin" onRequestHandled={taken} />);
  expect(taken).toHaveBeenCalledTimes(1);expect(dialogs()).toHaveLength(1);
  expect(within(screen.getByRole('dialog', { name: 'Plug-in' })).getByRole('combobox', { name: 'VST3 plug-in' })).toHaveFocus();
});
it('the drum map follows the plug-in slot in the Plug-in dialog for an instrument on a drum track, and is in no other case there or in the sound editor', () => {
  const view = render(<SoundSummary trackId="drums" percussion sound={{ ...soundPreset('gm'), plugin: { ...slot, kind: 'instrument' } }} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Plug-in…' }));
  const dialog = screen.getByRole('dialog', { name: 'Plug-in' });
  const section = dialog.querySelector('.sound-plugin-slot') as HTMLElement, map = dialog.querySelector('.drum-map') as HTMLElement | null;
  expect(map).not.toBeNull();expect(section.nextElementSibling).toBe(map);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Sound and pedalboard…' }));
  expect(document.querySelector('.sound-dialog .drum-map')).toBeNull();expect(document.querySelector('.sound-dialog .drum-kit')).not.toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  view.rerender(<SoundSummary trackId="drums" percussion sound={{ ...soundPreset('gm'), plugin: slot }} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Plug-in…' }));expect(document.querySelector('.plugin-dialog .drum-map')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  view.rerender(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: { ...slot, kind: 'instrument' } }} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Plug-in…' }));expect(document.querySelector('.plugin-dialog .drum-map')).toBeNull();
});
it('the effect note in the sound editor opens the Plug-in dialog in its place, and the focus goes back to the sidebar button that opened the editor', () => {
  render(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: slot }} onEdit={vi.fn()} />);
  const opener = screen.getByRole('button', { name: 'Sound and pedalboard…' });opener.focus();fireEvent.click(opener);
  const note = document.querySelector('.sound-dialog .sound-plugin-link') as HTMLElement;expect(note).not.toBeNull();
  fireEvent.click(within(note).getByRole('button', { name: 'Plug-in…' }));
  expect(dialogs()).toHaveLength(1);expect(screen.getByRole('dialog', { name: 'Plug-in' })).toBeInTheDocument();expect(document.querySelector('.sound-dialog')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });expect(screen.queryByRole('dialog')).toBeNull();expect(opener).toHaveFocus();
});
it('the drum kit note opens the Plug-in dialog in its place for an instrument on a drum track', () => {
  render(<SoundSummary trackId="drums" percussion sound={{ ...soundPreset('gm'), plugin: { ...slot, kind: 'instrument' } }} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sound and pedalboard…' }));
  const note = screen.getByText(/The kit and its mix apply to the built-in kit/);fireEvent.click(within(note).getByRole('button', { name: 'Plug-in…' }));
  expect(dialogs()).toHaveLength(1);expect(screen.getByRole('dialog', { name: 'Plug-in' })).toBeInTheDocument();expect(document.querySelector('.plugin-dialog .drum-map')).not.toBeNull();
});
it('choosing a plug-in in its dialog is one setTrackSound edit, and choosing the current one records nothing', () => {
  const onEdit = vi.fn();
  render(<SoundSummary trackId="guitar" sound={{ ...soundPreset('lead'), plugin: slot }} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Plug-in…' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Plug-in' }));
  fireEvent.change(dialog.getByRole('combobox', { name: 'VST3 plug-in' }), { target: { value: slot.classId } });expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(dialog.getByRole('combobox', { name: 'VST3 plug-in' }), { target: { value: '' } });
  expect(onEdit).toHaveBeenCalledTimes(1);expect(recorded(onEdit)).toMatchObject({ type: 'setTrackSound', trackId: 'guitar' });expect(recorded(onEdit).sound.plugin).toBeUndefined();
});
