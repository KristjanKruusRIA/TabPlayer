// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { AudioOutputSettingsPanel } from './AudioOutputSettingsPanel';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge, NativeAudioStatus } from './bridge';
import { DEFAULT_PRACTICE } from './practice-types';

const players: NativePlaybackController[] = [];
afterEach(() => {
  cleanup();
  for (const player of players) player.destroy();
  players.length = 0;
});

function nativePlayer(overrides: Partial<NativeAudioBridge> = {}) {
  const bridge: NativeAudioBridge = {
    prepare: vi.fn(async () => {}),
    command: vi.fn(async () => {}),
    setMix: vi.fn(async () => {}),
    devices: vi.fn(async () => [{ id: 'speakers', name: 'Studio speakers', isDefault: false }]),
    diagnostics: vi.fn(async () => ({ deviceName: 'Studio speakers', sampleRate: 48000, bufferSize: 512 })),
    testTone: vi.fn(async () => {}),
    status: vi.fn(async () => null),
    subscribe: vi.fn(async () => () => {}),
    stageBacking: vi.fn(async () => null),
    stageEmbeddedBacking: vi.fn(async () => null),
    ...overrides,
  };
  const player = new NativePlaybackController({ bridge, onEdit: () => {} });
  players.push(player);
  return { bridge, player };
}

it('renders nothing when playback controller is absent', () => {
  const { container } = render(<AudioOutputSettingsPanel playback={null} />);
  expect(container).toBeEmptyDOMElement();
});

it('allows inspection while busy and refuses output changes without disabling focusable controls', async () => {
  const { player, bridge } = nativePlayer();
  render(<AudioOutputSettingsPanel playback={player} busy />);
  await screen.findByRole('option', { name: 'Studio speakers' });
  expect(document.querySelectorAll('fieldset[disabled]')).toHaveLength(0);
  expect(document.querySelector('fieldset')).toHaveAttribute('aria-disabled', 'true');
  const output = screen.getByLabelText('Audio output');
  expect(output).toBeEnabled();
  output.focus();
  expect(document.activeElement).toBe(output);
  fireEvent.change(output, { target: { value: 'speakers' } });
  expect(bridge.command).not.toHaveBeenCalled();
});

it('shows a real output failure and keeps device selection reachable', async () => {
  const { player, bridge } = nativePlayer();
  bridge.command = vi.fn(async () => {
    throw new Error('Output is unavailable');
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  await screen.findByRole('option', { name: 'Studio speakers' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Audio output'), { target: { value: 'speakers' } });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Output is unavailable');
  expect(screen.getByLabelText('Audio output')).toBeVisible();
  expect(screen.getByLabelText('Audio output')).toBeEnabled();
  expect(bridge.command).toHaveBeenCalledWith({
    type: 'selectDevice',
    deviceId: 'speakers',
    generation: player.generation,
  });
});

it('shows device enumeration failure without hiding the default output', async () => {
  const { player, bridge } = nativePlayer();
  bridge.devices = vi.fn(async () => {
    throw new Error('Devices could not be read');
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Devices could not be read');
  expect(screen.getByLabelText('Audio output')).toBeVisible();
});

it('displays diagnostics readout of device name, sample rate, and buffer size from backend', async () => {
  const { player } = nativePlayer();
  render(<AudioOutputSettingsPanel playback={player} />);
  const diagGroup = await screen.findByRole('group', { name: 'Audio diagnostics' });
  expect(diagGroup).toHaveTextContent('Device: Studio speakers');
  expect(diagGroup).toHaveTextContent('Sample rate: 48000 Hz');
  expect(diagGroup).toHaveTextContent('Buffer size: 512 frames');
});

it('reads unknown when diagnostic values are unreported and never uses defaults', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => ({}));
  render(<AudioOutputSettingsPanel playback={player} />);
  const diagGroup = await screen.findByRole('group', { name: 'Audio diagnostics' });
  expect(diagGroup).toHaveTextContent('Device: Unknown');
  expect(diagGroup).toHaveTextContent('Sample rate: Unknown');
  expect(diagGroup).toHaveTextContent('Buffer size: Unknown');
});

it('triggers test tone on button click and keeps control focusable while busy', async () => {
  const { player, bridge } = nativePlayer();
  const { rerender } = render(<AudioOutputSettingsPanel playback={player} />);
  const btn = screen.getByRole('button', { name: 'Test tone' });
  expect(btn).toBeEnabled();
  await userEvent.click(btn);
  expect(bridge.testTone).toHaveBeenCalledTimes(1);

  rerender(<AudioOutputSettingsPanel playback={player} busy />);
  expect(btn).not.toBeDisabled();
  btn.focus();
  expect(document.activeElement).toBe(btn);
  fireEvent.click(btn);
  expect(bridge.testTone).toHaveBeenCalledTimes(1);
});

it('shows plain message when test tone is refused during playback', async () => {
  const { player, bridge } = nativePlayer();
  bridge.testTone = vi.fn(async () => {
    throw 'audio_test_tone_playback';
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  const btn = screen.getByRole('button', { name: 'Test tone' });
  await act(async () => {
    fireEvent.click(btn);
  });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The test tone is unavailable during playback.');
});

it('shows plain message when device diagnostics fail and leaves output selectable', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => {
    throw 'audio_output_unavailable';
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The audio output is unavailable.');
  expect(screen.getByLabelText('Audio output')).toBeVisible();
});

it('readout follows a device change that completes after selectOutput returns', async () => {
  let current = { deviceName: 'Speakers', sampleRate: 44100, bufferSize: 441 };
  let finish: () => void = () => {};
  const { player, bridge } = nativePlayer();
  bridge.command = vi.fn(command =>
    command.type === 'selectDevice'
      ? new Promise<void>(resolve => {
          finish = () => {
            current = { deviceName: 'Headphones', sampleRate: 48000, bufferSize: 512 };
            resolve();
          };
        })
      : Promise.resolve(),
  );
  bridge.devices = vi.fn(async () => [{ id: 'phones', name: 'Headphones', isDefault: false }]);
  bridge.diagnostics = vi.fn(async () => current);
  render(<AudioOutputSettingsPanel playback={player} />);
  const group = await screen.findByRole('group', { name: 'Audio diagnostics' });
  await screen.findByRole('option', { name: 'Headphones' });
  await vi.waitFor(() => expect(group).toHaveTextContent('Device: Speakers'));
  fireEvent.change(screen.getByLabelText('Audio output'), { target: { value: 'phones' } });
  await act(async () => {
    await new Promise(r => setTimeout(r, 20));
  });
  expect(group).toHaveTextContent('Device: Speakers');
  await act(async () => {
    finish();
    await new Promise(r => setTimeout(r, 50));
  });
  expect(group).toHaveTextContent('Device: Headphones');
  expect(group).toHaveTextContent('Sample rate: 48000 Hz');
});

it('ignores a slow earlier readout that answers after a newer one', async () => {
  const { player, bridge } = nativePlayer();
  const answers: Array<(value: { deviceName: string }) => void> = [];
  bridge.diagnostics = vi.fn(
    () =>
      new Promise<{ deviceName: string }>(resolve => {
        answers.push(resolve);
      }),
  );
  render(<AudioOutputSettingsPanel playback={player} />);
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Test tone' }));
  await vi.waitFor(() => expect(bridge.testTone).toHaveBeenCalled());
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  await act(async () => {
    answers[1]({ deviceName: 'Newer' });
  });
  await act(async () => {
    answers[0]({ deviceName: 'Older' });
  });
  expect(screen.getByRole('group', { name: 'Audio diagnostics' })).toHaveTextContent('Device: Newer');
});

it('clears the playback refusal when playback stops', async () => {
  let receive: (status: NativeAudioStatus) => void = () => {};
  const { player, bridge } = nativePlayer({
    subscribe: vi.fn(async listener => {
      receive = listener;
      return () => {};
    }),
  });
  const emit = (change: Partial<NativeAudioStatus>) =>
    receive({
      generation: player.generation,
      ready: true,
      playing: false,
      tick: 0,
      seconds: 0,
      durationSeconds: 8,
      speed: 1,
      metronome: false,
      error: null,
      deviceId: null,
      range: null,
      loop: null,
      practice: {
        settings: structuredClone(DEFAULT_PRACTICE),
        phase: change.playing ? 'playing' : 'paused',
        countInRemaining: 0,
        completedPasses: 0,
        effectiveRatio: 1,
        currentBpm: 120,
        pulse: null,
      },
      ...change,
    } as NativeAudioStatus);
  bridge.testTone = vi.fn(async () => {
    throw 'audio_test_tone_playback';
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    emit({ playing: true });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Test tone' }));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The test tone is unavailable during playback.',
  );
  await act(async () => {
    emit({ playing: false });
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('words an unknown refusal code generically instead of showing it raw', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => {
    throw 'something_new';
  });
  render(<AudioOutputSettingsPanel playback={player} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('The audio output could not be read.');
});

it('reads the buffer size once more after a device switch, when the first callback has run', async () => {
  let current: { deviceName: string; sampleRate: number; bufferSize?: number } = {
    deviceName: 'Speakers',
    sampleRate: 44100,
    bufferSize: 441,
  };
  const { player, bridge } = nativePlayer();
  bridge.command = vi.fn(async command => {
    if (command.type === 'selectDevice') current = { deviceName: 'Headphones', sampleRate: 48000 };
  });
  bridge.devices = vi.fn(async () => [{ id: 'phones', name: 'Headphones', isDefault: false }]);
  bridge.diagnostics = vi.fn(async () => current);
  render(<AudioOutputSettingsPanel playback={player} />);
  const group = await screen.findByRole('group', { name: 'Audio diagnostics' });
  await screen.findByRole('option', { name: 'Headphones' });
  await vi.waitFor(() => expect(group).toHaveTextContent('Buffer size: 441 frames'));
  fireEvent.change(screen.getByLabelText('Audio output'), { target: { value: 'phones' } });
  await vi.waitFor(() => expect(group).toHaveTextContent('Device: Headphones'));
  expect(group).toHaveTextContent('Buffer size: Unknown');
  current = { ...current, bufferSize: 512 };
  await vi.waitFor(() => expect(group).toHaveTextContent('Buffer size: 512 frames'), { timeout: 2000 });
});

it('clears a tone failure when the output recovers', async () => {
  let receive: (status: NativeAudioStatus) => void = () => {};
  const { player, bridge } = nativePlayer({
    subscribe: vi.fn(async listener => {
      receive = listener;
      return () => {};
    }),
  });
  bridge.testTone = vi.fn(async () => {
    throw 'audio_output_unavailable';
  });
  const emit = (ready: boolean) =>
    receive({
      generation: player.generation,
      ready,
      playing: false,
      tick: 0,
      seconds: 0,
      durationSeconds: 8,
      speed: 1,
      metronome: false,
      error: null,
      deviceId: null,
      range: null,
      loop: null,
      practice: {
        settings: structuredClone(DEFAULT_PRACTICE),
        phase: 'paused',
        countInRemaining: 0,
        completedPasses: 0,
        effectiveRatio: 1,
        currentBpm: 120,
        pulse: null,
      },
    } as NativeAudioStatus);
  render(<AudioOutputSettingsPanel playback={player} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Test tone' }));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('The audio output is unavailable.');
  await act(async () => {
    emit(true);
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reads the diagnostics again when the window regains focus, and stops listening on unmount', async () => {
  const { player, bridge } = nativePlayer();
  const { unmount } = render(<AudioOutputSettingsPanel playback={player} />);
  await vi.waitFor(() => expect(bridge.diagnostics).toHaveBeenCalledTimes(1));
  await act(async () => {
    fireEvent.focus(window);
  });
  expect(bridge.diagnostics).toHaveBeenCalledTimes(2);
  unmount();
  fireEvent.focus(window);
  expect(bridge.diagnostics).toHaveBeenCalledTimes(2);
});

it('words a device the backend cannot name with the translated label', async () => {
  const { player, bridge } = nativePlayer();
  bridge.devices = vi.fn(async () => [{ id: 'x', isDefault: false }]);
  render(<AudioOutputSettingsPanel playback={player} />);
  expect(await screen.findByRole('option', { name: 'Unknown device' })).toBeInTheDocument();
});
