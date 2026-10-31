// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SoundPanel, soundPreset } from './SoundPanel';
import { useSoundEditing } from './useSoundEditing';
import { factorySound } from './factory-sounds';
import { copySound, saveSoundPreset } from './sound-library';
import type { NativePlaybackController } from './NativePlaybackController';
import type { EditCommand, TrackSound } from '../edit-types';

afterEach(() => { cleanup(); localStorage.clear(); });
const locked = (sound: TrackSound): TrackSound => ({ ...sound, locked: true });
const lastSound = (onEdit: ReturnType<typeof vi.fn>) => (onEdit.mock.calls.at(-1)![0] as Extract<EditCommand, { type: 'setTrackSound' }>).sound;
function previewer() {
  let preview: { track: string; sound: TrackSound } | null = null;
  const state = {};
  const fake = { subscribe: () => () => {}, getState: () => state, devices: async () => [], deviceId: () => null, selectDevice: vi.fn(), soundPreview: () => preview,
    previewSound: vi.fn(async (track: string, sound: TrackSound | null) => { preview = sound ? { track, sound } : null; }) };
  return { fake, playback: fake as unknown as NativePlaybackController };
}

it('keeps a track locked through a preset, Restore preset and a changed source', () => {
  const onEdit = vi.fn();
  render(<SoundPanel trackId="a" sound={locked(soundPreset('lead', 'green-guitar'))} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Sound preset'), { target: { value: 'crunch' } });
  expect(lastSound(onEdit)).toEqual(locked(soundPreset('crunch', 'green-guitar')));
  fireEvent.click(screen.getByRole('button', { name: 'Restore preset' }));
  expect(lastSound(onEdit)).toEqual(locked(soundPreset('lead', 'green-guitar')));
  fireEvent.change(screen.getByLabelText('Sound source'), { target: { value: 'black-guitar' } });
  expect(lastSound(onEdit)).toEqual(locked(soundPreset('lead', 'black-guitar')));
});

it('keeps a track locked through a factory sound', () => {
  const onEdit = vi.fn();
  render(<SoundPanel trackId="a" sound={locked(soundPreset('clean', 'green-guitar'))} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Factory sound'), { target: { value: 'surf-tremolo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply factory sound' }));
  expect(lastSound(onEdit)).toEqual(locked(factorySound('surf-tremolo', 'green-guitar')!));
});

it('keeps an unlocked track unlocked when a factory sound is applied', () => {
  const onEdit = vi.fn();
  render(<SoundPanel trackId="a" sound={soundPreset('clean', 'green-guitar')} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Factory sound'), { target: { value: 'surf-tremolo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply factory sound' }));
  expect(lastSound(onEdit)).toEqual(factorySound('surf-tremolo', 'green-guitar'));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
});

it('previews with the track lock and keeps it when the preview is kept', async () => {
  const { fake, playback } = previewer(), onEdit = vi.fn();
  render(<SoundPanel trackId="a" sound={locked(soundPreset('clean', 'green-guitar'))} onEdit={onEdit} playback={playback} />);
  await act(async () => { fireEvent.change(screen.getByLabelText('Preview sound'), { target: { value: 'preset:crunch' } }); });
  expect(fake.previewSound).toHaveBeenLastCalledWith('a', locked(soundPreset('crunch', 'green-guitar')));
  await act(async () => { fireEvent.change(screen.getByLabelText('Preview sound'), { target: { value: 'factory:surf-tremolo' } }); });
  expect(fake.previewSound).toHaveBeenLastCalledWith('a', locked(factorySound('surf-tremolo', 'green-guitar')!));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep previewed sound' })); });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(lastSound(onEdit)).toEqual(locked(factorySound('surf-tremolo', 'green-guitar')!));
});

it('previews a sound saved from a locked track without locking an unlocked one', async () => {
  saveSoundPreset('From a locked track', locked(soundPreset('lead', 'green-guitar')));
  const { fake, playback } = previewer(), onEdit = vi.fn();
  render(<SoundPanel trackId="b" sound={soundPreset('clean', 'green-guitar')} onEdit={onEdit} playback={playback} />);
  await act(async () => { fireEvent.change(screen.getByLabelText('Preview sound'), { target: { value: 'saved:From a locked track' } }); });
  expect(fake.previewSound.mock.calls.at(-1)![1]).not.toHaveProperty('locked');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep previewed sound' })); });
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
});

it('does not carry the lock to another track by Paste sound, and keeps the track its own', () => {
  copySound(locked(soundPreset('lead', 'green-guitar')));
  const onEdit = vi.fn();
  const { rerender } = render(<SoundPanel trackId="b" sound={soundPreset('clean', 'green-guitar')} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste sound' }));
  expect(lastSound(onEdit)).toEqual(soundPreset('lead', 'green-guitar'));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
  copySound(soundPreset('crunch', 'green-guitar'));
  rerender(<SoundPanel trackId="a" sound={locked(soundPreset('clean', 'green-guitar'))} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste sound' }));
  expect(lastSound(onEdit)).toEqual(locked(soundPreset('crunch', 'green-guitar')));
});

it('Copy sound and Save sound store the sound without the lock of the track they came from', () => {
  const onEdit = vi.fn();
  const { rerender } = render(<SoundPanel trackId="a" sound={locked(soundPreset('lead', 'green-guitar'))} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy sound' }));
  fireEvent.change(screen.getByLabelText('Saved sound name'), { target: { value: 'Lead' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save sound' }));
  rerender(<SoundPanel trackId="b" sound={soundPreset('clean', 'green-guitar')} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste sound' }));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
  fireEvent.change(screen.getByLabelText('Saved sound'), { target: { value: 'Lead' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply saved sound' }));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
});

it('Apply saved sound neither unlocks a locked track nor locks another', () => {
  saveSoundPreset('Plain', soundPreset('lead', 'green-guitar'));
  saveSoundPreset('Locked', locked(soundPreset('crunch', 'green-guitar')));
  const onEdit = vi.fn();
  const { rerender } = render(<SoundPanel trackId="a" sound={locked(soundPreset('clean', 'green-guitar'))} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Saved sound'), { target: { value: 'Plain' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply saved sound' }));
  expect(lastSound(onEdit)).toEqual(locked(soundPreset('lead', 'green-guitar')));
  rerender(<SoundPanel trackId="b" sound={soundPreset('clean', 'green-guitar')} onEdit={onEdit} />);
  fireEvent.change(screen.getByLabelText('Saved sound'), { target: { value: 'Locked' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply saved sound' }));
  expect(lastSound(onEdit)).toEqual(soundPreset('crunch', 'green-guitar'));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
});

it('setLocked records one edit for a change and nothing for the value it already has', async () => {
  const onEdit = vi.fn();
  const { result, rerender } = renderHook(({ sound }: { sound: TrackSound }) => useSoundEditing({ trackId: 'a', sound, onEdit }), { initialProps: { sound: soundPreset('lead', 'green-guitar') } });
  await act(async () => { expect(await result.current.setLocked(false)).toBe(false); });
  expect(onEdit).not.toHaveBeenCalled();
  await act(async () => { await result.current.setLocked(true); });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackSound', trackId: 'a', sound: locked(soundPreset('lead', 'green-guitar')) });
  rerender({ sound: locked(soundPreset('lead', 'green-guitar')) });
  await act(async () => { expect(await result.current.setLocked(true)).toBe(false); });
  expect(onEdit).toHaveBeenCalledTimes(1);
  await act(async () => { await result.current.setLocked(false); });
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(lastSound(onEdit)).toEqual(soundPreset('lead', 'green-guitar'));
  expect(lastSound(onEdit)).not.toHaveProperty('locked');
});
