// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddTrackDialog } from './AddTrackDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] })),
}));

afterEach(cleanup);

const open = (props: Partial<Parameters<typeof AddTrackDialog>[0]> = {}) => {
  const onAdd = vi.fn(), onClose = vi.fn();
  const view = render(<AddTrackDialog busy={false} onAdd={onAdd} onClose={onClose} {...props} />);
  return { onAdd, onClose, view };
};
const addDialog = () => screen.getByRole('dialog', { name: 'Add track' });
const tuning = () => screen.getByRole('dialog', { name: 'Tuning' });
const newEdit = () => screen.getByRole('button', { name: /^Edit new track tuning/ });
const notes = () => within(tuning()).getByLabelText('Notes, high to low') as HTMLInputElement;
const inTuning = (name: string | RegExp) => within(tuning()).getByRole('button', { name });
const select = (label: string, value: string) => fireEvent.change(within(tuning()).getByLabelText(label), { target: { value } });
const clickTab = (name: string) => fireEvent.click(within(addDialog()).getByRole('tab', { name }));
const pickGroup = (name: string) => fireEvent.click(within(within(addDialog()).getByRole('listbox', { name: 'Instrument groups' })).getByRole('option', { name }));
const pickInstrument = (name: string) => fireEvent.click(within(within(addDialog()).getByRole('listbox', { name: 'Instruments' })).getByRole('option', { name }));

it('opens on Stringed -> Electric Guitar -> Overdrive with a non-red default color, focus on name, and Enter adds in one edit', () => {
  const { onAdd, onClose } = open();
  const nameInput = screen.getByLabelText('New track name') as HTMLInputElement;
  expect(nameInput).toHaveFocus();
  expect(nameInput).toHaveValue('Electric Guitar');
  expect(screen.getByLabelText('Track short name')).toHaveValue('el.guit.');
  const colorInput = screen.getByLabelText('Track color') as HTMLInputElement;
  expect(colorInput.value).toBe('#d9534f');
  expect(colorInput.value).not.toBe('#c80000');
  expect(within(addDialog()).getByRole('heading', { level: 3 })).toHaveTextContent(/Overdrive settings/i);

  fireEvent.change(nameInput, { target: { value: 'Lead Guitar' } });
  fireEvent.keyDown(nameInput, { key: 'Enter' });
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'addTrack',
    name: 'Lead Guitar',
    shortName: 'el.guit.',
    color: '#d9534f',
    program: 29,
    tuning: [64, 59, 55, 50, 45, 40],
    tuningName: 'Standard E',
    showTab: true,
    showNotation: true,
    showSlash: false,
  }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('switches across Stringed, Orchestra, Drums, and MIDI with distinct default colors and appropriate track commands', () => {
  const { onAdd } = open();
  const colors = new Set<string>();
  const colorOf = () => (screen.getByLabelText('Track color') as HTMLInputElement).value;

  // Stringed -> Other -> Ukulele
  pickGroup('Other');
  pickInstrument('Ukulele');
  expect(screen.getByLabelText('New track name')).toHaveValue('Ukulele');
  expect(screen.getByLabelText('Track short name')).toHaveValue('uke.');
  expect(colorOf()).toBe('#e86c6a');
  colors.add(colorOf());

  // Stringed -> Bass -> Electric Bass
  pickGroup('Bass');
  expect(screen.getByLabelText('New track name')).toHaveValue('Bass');
  expect(screen.getByLabelText('Track short name')).toHaveValue('el.b.');
  expect(colorOf()).toBe('#3d7ac7');
  colors.add(colorOf());

  // Orchestra -> Keyboards -> Piano (Grand staff)
  clickTab('Orchestra');
  pickGroup('Keyboards');
  pickInstrument('Piano');
  expect(screen.getByLabelText('New track name')).toHaveValue('Piano');
  expect(screen.getByLabelText('Track short name')).toHaveValue('pno.');
  expect(colorOf()).toBe('#48a868');
  expect(within(addDialog()).getByRole('button', { name: 'Grand staff' })).toHaveAttribute('aria-pressed', 'true');
  colors.add(colorOf());

  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add track' }));
  expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'addPitchedTrack',
    name: 'Piano',
    shortName: 'pno.',
    color: '#48a868',
    program: 0,
    clef: 4,
    lowerClef: 3,
    showNotation: true,
    showSlash: false,
  }));

  // Drums -> Drums -> Drumkit
  clickTab('Drums');
  expect(screen.getByLabelText('New track name')).toHaveValue('Drums');
  expect(screen.getByLabelText('Track short name')).toHaveValue('dr.');
  expect(colorOf()).toBe('#7d8a99');
  colors.add(colorOf());
  // Toggle drum tablature on as well
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Tablature' }));
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add track' }));
  expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'addPercussionTrack',
    name: 'Drums',
    shortName: 'dr.',
    color: '#7d8a99',
    showTab: true,
    showNotation: true,
    showSlash: false,
  }));

  // MIDI -> Brass -> 57. Trumpet
  clickTab('MIDI');
  pickGroup('Brass');
  pickInstrument('57. Trumpet');
  expect(screen.getByLabelText('New track name')).toHaveValue('Trumpet');
  expect(colorOf()).toBe('#d9ae38');
  colors.add(colorOf());
  expect(colors.size).toBe(5);
  expect(colors.has('#c80000')).toBe(false);
});

it('supports custom color, short name, notation toggles, grand staff stringed tuning, and Cancel/Escape', () => {
  const { onAdd, onClose } = open();
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onAdd).not.toHaveBeenCalled();

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onAdd).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Track color'), { target: { value: '#12aa88' } });
  fireEvent.change(screen.getByLabelText('New track name'), { target: { value: 'Double Neck' } });
  fireEvent.change(screen.getByLabelText('Track short name'), { target: { value: 'dn.' } });
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Slash notation' }));
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Standard notation' }));
  // Cannot turn off the last remaining notation toggle (Tablature + Slash are on; turn off Slash, then Tab stays locked on)
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Slash notation' }));
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Tablature' }));
  expect(within(addDialog()).getByRole('button', { name: 'Tablature' })).toHaveAttribute('aria-pressed', 'true');

  // Enable Grand staff and change lower staff instrument to 4-string Bass
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Grand staff' }));
  fireEvent.change(screen.getByLabelText('Lower staff instrument'), { target: { value: 'bass' } });
  fireEvent.change(screen.getByLabelText('Lower staff strings'), { target: { value: '4' } });
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add track' }));
  expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'addTrack',
    name: 'Double Neck',
    shortName: 'dn.',
    color: '#12aa88',
    showTab: true,
    showNotation: false,
    showSlash: false,
    lowerTuning: [43, 38, 33, 28],
    lowerTuningName: 'Standard E',
  }));
});

it('previews sound via onAudition for stringed, orchestra, and drums', () => {
  const onAudition = vi.fn();
  open({ onAudition });
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Preview sound' }));
  expect(onAudition).toHaveBeenLastCalledWith(
    expect.objectContaining({ program: 29, percussion: false }),
    [64, 59, 55, 50, 45, 40],
    true,
  );

  clickTab('Orchestra');
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Preview sound' }));
  expect(onAudition).toHaveBeenLastCalledWith(
    expect.objectContaining({ program: 40, percussion: false }),
    [60, 64, 67, 72],
    true,
  );

  clickTab('Drums');
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Preview sound' }));
  expect(onAudition).toHaveBeenLastCalledWith(
    expect.objectContaining({ program: 0, percussion: true }),
    [36, 42, 38, 49],
    true,
  );
});

it('refuses adds while busy or finalized, keeping focus on the name', () => {
  const { onAdd, onClose, view } = open({ busy: true });
  const name = screen.getByLabelText('New track name');
  expect(name).toHaveFocus();
  fireEvent.keyDown(name, { key: 'Enter' });
  const addBtn = within(addDialog()).getByRole('button', { name: 'Add track' });
  fireEvent.click(addBtn);
  expect(addBtn).toHaveAttribute('aria-disabled', 'true');
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  view.rerender(<AddTrackDialog busy={false} locked onAdd={onAdd} onClose={onClose} />);
  fireEvent.keyDown(screen.getByLabelText('New track name'), { key: 'Enter' });
  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add track' }));
  expect(onAdd).not.toHaveBeenCalled();
});

it('uses the Tuning dialog as a draft: Use tuning fills only the new track, Cancel leaves it, and Escape keeps Add track open', () => {
  const { onAdd, onClose } = open();
  pickGroup('Bass');
  expect(newEdit()).toHaveTextContent('G2 D2 A1 E1');
  newEdit().focus();
  fireEvent.click(newEdit());
  expect(within(tuning()).queryByRole('button', { name: 'Keep pitch' })).toBeNull();
  expect(within(tuning()).queryByRole('button', { name: 'Keep fingering' })).toBeNull();
  fireEvent.change(notes(), { target: { value: 'G2 bad' } });
  fireEvent.click(inTuning('Use tuning'));
  expect(tuning()).toBeInTheDocument();
  expect(notes()).toHaveAttribute('aria-invalid', 'true');
  expect(within(tuning()).getByRole('alert')).toHaveTextContent('bad');
  expect(onAdd).not.toHaveBeenCalled();

  fireEvent.click(inTuning('Cancel'));
  expect(newEdit()).toHaveFocus();
  expect(newEdit()).toHaveTextContent('G2 D2 A1 E1');
  expect(addDialog()).toBeInTheDocument();

  fireEvent.click(newEdit());
  select('Instrument', 'bass');
  select('Number of strings', '4');
  select('Preset', 'bass-4-drop-d');
  expect(notes()).toHaveValue('G2 D2 A1 D1');
  fireEvent.click(inTuning('Use tuning'));
  expect(newEdit()).toHaveTextContent('G2 D2 A1 D1');
  expect(onAdd).not.toHaveBeenCalled();

  fireEvent.click(newEdit());
  fireEvent.change(notes(), { target: { value: 'E4 B3 G3 D3 A2 E2 B1' } });
  expect(within(tuning()).queryByLabelText('Strings kept in place')).toBeNull();
  fireEvent.click(inTuning('Use tuning'));
  fireEvent.click(newEdit());
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Tuning' })).toBeNull();
  expect(addDialog()).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(within(addDialog()).getByRole('button', { name: 'Add track' }));
  expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'addTrack',
    name: 'Bass',
    program: 33,
    tuning: [64, 59, 55, 50, 45, 40, 35],
    tuningName: '',
  }));
});
