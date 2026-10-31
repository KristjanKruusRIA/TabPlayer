// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SoundPanel, soundPreset } from './SoundPanel';
import { factorySound } from './factory-sounds';
import { copySound, saveSoundPreset } from './sound-library';
import type { NativePlaybackController } from './NativePlaybackController';
import type { EditCommand, TrackSound } from '../edit-types';

afterEach(() => { cleanup(); localStorage.clear(); });
const kit = (sound: TrackSound, drumKit?: number): TrackSound => drumKit === undefined ? sound : { ...sound, drumKit };
const lastSound = (onEdit: ReturnType<typeof vi.fn>) => (onEdit.mock.calls.at(-1)![0] as Extract<EditCommand, { type: 'setTrackSound' }>).sound;
const panel = (sound: TrackSound, onEdit: (edit: EditCommand) => void, extra: object = {}) => <SoundPanel trackId="d" percussion sound={sound} onEdit={onEdit} {...extra} />;
const state = {};
function previewer() {
  let preview: { track: string; sound: TrackSound } | null = null;
  const fake = { subscribe: () => () => {}, getState: () => state, devices: async () => [], deviceId: () => null, selectDevice: vi.fn(), soundPreview: () => preview,
    previewSound: vi.fn(async (track: string, sound: TrackSound | null) => { preview = sound ? { track, sound } : null; }) };
  return fake as unknown as NativePlaybackController;
}

// Each of these fails if the kit-keeping clause in useSoundEditing.withLock is removed.
it('keeps the drum kit through a preset, Restore preset and a changed source', () => {
  const onEdit = vi.fn();
  render(panel(kit(soundPreset('lead', 'gm'), 40), onEdit));
  fireEvent.change(screen.getByLabelText('Sound preset'), { target: { value: 'crunch' } });
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('crunch', 'gm'), 40));
  fireEvent.click(screen.getByRole('button', { name: 'Restore preset' }));
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('lead', 'gm'), 40));
  fireEvent.change(screen.getByLabelText('Sound source'), { target: { value: 'green-guitar' } });
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('lead', 'green-guitar'), 40));
});
it('keeps the drum kit through a factory sound, and leaves an unkitted track unkitted', () => {
  const onEdit = vi.fn();
  const { rerender } = render(panel(kit(soundPreset('clean', 'gm'), 8), onEdit));
  fireEvent.change(screen.getByLabelText('Factory sound'), { target: { value: 'surf-tremolo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply factory sound' }));
  expect(lastSound(onEdit)).toEqual(kit(factorySound('surf-tremolo', 'gm')!, 8));
  rerender(panel(soundPreset('clean', 'gm'), onEdit));
  fireEvent.click(screen.getByRole('button', { name: 'Apply factory sound' }));
  expect(lastSound(onEdit)).not.toHaveProperty('drumKit');
});
it('keeps the track its own kit through Paste sound and never carries a kit to another track', () => {
  copySound(kit(soundPreset('lead', 'gm'), 32));
  const onEdit = vi.fn();
  const { rerender } = render(panel(soundPreset('clean', 'gm'), onEdit));
  fireEvent.click(screen.getByRole('button', { name: 'Paste sound' }));
  expect(lastSound(onEdit)).toEqual(soundPreset('lead', 'gm'));
  expect(lastSound(onEdit)).not.toHaveProperty('drumKit');
  copySound(soundPreset('crunch', 'gm'));
  rerender(panel(kit(soundPreset('clean', 'gm'), 40), onEdit));
  fireEvent.click(screen.getByRole('button', { name: 'Paste sound' }));
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('crunch', 'gm'), 40));
});
it('keeps the drum kit when a saved sound is applied or a preview is kept', async () => {
  saveSoundPreset('Saved lead', kit(soundPreset('lead', 'gm'), 32));
  const onEdit = vi.fn(), playback = previewer();
  render(panel(kit(soundPreset('clean', 'gm'), 40), onEdit, { playback }));
  fireEvent.change(screen.getByLabelText('Saved sound'), { target: { value: 'Saved lead' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply saved sound' }));
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('lead', 'gm'), 40));
  await act(async () => { fireEvent.change(screen.getByLabelText('Preview sound'), { target: { value: 'preset:crunch' } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep previewed sound' })); });
  expect(lastSound(onEdit)).toEqual(kit(soundPreset('crunch', 'gm'), 40));
});

it('the drum kit select is for drum tracks only, in the inspector Sound task', () => {
  const onEdit = vi.fn();
  const { rerender } = render(panel(soundPreset('lead', 'gm'), onEdit));
  expect(Array.from(screen.getByLabelText('Drum kit').querySelectorAll('option')).map(o => o.textContent)).toEqual(['Standard', 'Room', 'Jazz', 'Brush']);
  rerender(<SoundPanel trackId="g" sound={soundPreset('lead', 'gm')} onEdit={onEdit} />);
  expect(screen.queryByLabelText('Drum kit')).toBeNull();
});
it('one choice is one setTrackSound edit that keeps the rest, Standard clears the field, the current kit records nothing', () => {
  const onEdit = vi.fn();
  const { rerender } = render(panel(soundPreset('lead', 'gm'), onEdit));
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '0' } });
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '32' } });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackSound', trackId: 'd', sound: kit(soundPreset('lead', 'gm'), 32) });
  rerender(panel({ ...kit(soundPreset('lead', 'gm'), 8), locked: true }, onEdit));
  expect(screen.getByLabelText('Drum kit')).toHaveValue('8');
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '8' } });
  expect(onEdit).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Drum kit'), { target: { value: '0' } });
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(lastSound(onEdit)).toEqual({ ...soundPreset('lead', 'gm'), locked: true });
  expect(lastSound(onEdit)).not.toHaveProperty('drumKit');
});
it('Escape closes the hits table and returns focus to its summary, without leaving the panel', () => {
  const onEdit = vi.fn(), outer = vi.fn();
  render(<div onKeyDown={outer}>{panel(soundPreset('lead', 'gm'), onEdit)}</div>);
  const summary = screen.getByText('Which hits differ'), details = summary.closest('details')!;
  fireEvent.click(summary); details.open = true;
  const inside = details.querySelector('.drum-kit-table')!;
  fireEvent.keyDown(inside, { key: 'Escape' });
  expect(details.open).toBe(false);
  expect(summary).toHaveFocus();
  expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(summary, { key: 'Escape' });
  expect(outer).toHaveBeenCalledTimes(1);
});
it('the drum kit select keeps focus while busy and refuses the change', () => {
  const onEdit = vi.fn();
  const { rerender } = render(panel(soundPreset('lead', 'gm'), onEdit));
  screen.getByLabelText('Drum kit').focus();
  rerender(panel(soundPreset('lead', 'gm'), onEdit, { busy: true }));
  const select = screen.getByLabelText('Drum kit');
  expect(select).not.toBeDisabled(); expect(select).toHaveAttribute('aria-disabled', 'true'); expect(select).toHaveFocus();
  fireEvent.change(select, { target: { value: '40' } });
  expect(onEdit).not.toHaveBeenCalled();
});
