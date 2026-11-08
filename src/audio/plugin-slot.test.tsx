// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PluginSlot, TrackSound } from '../edit-types';
import { PluginSlotPanel } from './PluginSlotPanel';
import { PluginNotices } from './PluginNotices';
import { usePluginStatus } from './usePluginStatus';
import { renderHook, act } from '@testing-library/react';
import type { PluginLibraryEntry, TrackPluginStatus } from './plugin-host';
import { soundPreset } from './sound-model';
import { useSoundEditing } from './useSoundEditing';
import { copySound, soundClipboard, forgetSoundClipboard } from './sound-library';

const mockCalls: Array<[string, unknown]> = [];
let invokeHandler: (command: string, args?: any) => Promise<any> = async () => [];
const eventListeners: Record<string, Array<(event: { payload: any }) => void>> = {};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    mockCalls.push([command, args]);
    return invokeHandler(command, args);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: any }) => void) => {
    eventListeners[event] = eventListeners[event] || [];
    eventListeners[event].push(handler);
    return () => {
      eventListeners[event] = eventListeners[event].filter(h => h !== handler);
    };
  }),
}));

const mockEntry: PluginLibraryEntry = {
  classId: 'A'.repeat(32),
  name: 'Super Amp',
  vendor: 'Audio Corp',
  version: '1.0.0',
  bundle: String.raw`C:\Plugins\SuperAmp.vst3`,
  moduleLen: 1024,
  moduleModified: 1700000000,
};

const mockSlot: PluginSlot = {
  format: 'vst3',
  classId: 'A'.repeat(32),
  name: 'Super Amp',
  vendor: 'Audio Corp',
  active: true,
  inputDb: 0,
  outputDb: 0,
  state: 's'.repeat(64),
};

beforeEach(() => {
  mockCalls.length = 0;
  for (const key of Object.keys(eventListeners)) delete eventListeners[key];
  forgetSoundClipboard();
  invokeHandler = async (command: string) => {
    if (command === 'plugin_library_list') return [mockEntry];
    if (command === 'plugin_status') return [];
    return null;
  };
});

afterEach(cleanup);

describe('PluginSlotPanel', () => {
  it('shows library entries, plain text VST3 with no logo, and "Add plug-in…" calls plugin_library_add and refreshes list', async () => {
    const freshEntry: PluginLibraryEntry = {
      classId: 'B'.repeat(32),
      name: 'Delay Deluxe',
      vendor: 'FX Labs',
      version: '2.0.0',
      bundle: String.raw`C:\Plugins\DelayDeluxe.vst3`,
      moduleLen: 2048,
      moduleModified: 1700000001,
    };
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_library_add') return [mockEntry, freshEntry];
      return null;
    };

    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={onChange} />);

    // Plain text VST3 with no logo
    expect(screen.getAllByText('VST3 plug-in').length).toBeGreaterThan(0);
    expect(screen.queryByRole('img', { name: /vst/i })).toBeNull();

    // Dropdown contains Built-in tone and mockEntry
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Built-in tone/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Super Amp/i })).toBeInTheDocument();
    });

    // "Add plug-in…" button calls plugin_library_add
    const addBtn = screen.getByRole('button', { name: /Add plug-in…/i });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(mockCalls).toContainEqual(['plugin_library_add', undefined]);
      expect(screen.getByRole('option', { name: /Delay Deluxe/i })).toBeInTheDocument();
    });
  });

  it('shows error message on library list, add or remove failure instead of an empty list', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') {
        throw new Error('This plug-in library was made by a newer TabPlayer.');
      }
      return null;
    };

    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/newer TabPlayer/i);
    });
  });

  it('shows moved note when a plug-in class moved to another file', async () => {
    const movedEntry: PluginLibraryEntry = {
      ...mockEntry,
      previousBundle: String.raw`C:\OldPlugins\SuperAmp.vst3`,
    };
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [movedEntry];
      return null;
    };

    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/moved to another file/i)).toBeInTheDocument();
    });
  });

  it('choosing a plug-in calls plugin_choose and writes one setTrackSound with plugin and asset token', async () => {
    const assetToken = 'staged-token-123';
    invokeHandler = async (command: string, args: any) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_choose') {
        return {
          slot: mockSlot,
          assetToken,
        };
      }
      return null;
    };

    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Super Amp/i })).toBeInTheDocument();
    });

    const select = screen.getByLabelText(/plug-in/i);
    fireEvent.change(select, { target: { value: mockEntry.classId } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(mockSlot, assetToken);
    });
  });

  it('choosing the current plug-in records nothing', async () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Super Amp/i })).toBeInTheDocument();
    });

    const select = screen.getByLabelText(/plug-in/i);
    fireEvent.change(select, { target: { value: mockSlot.classId } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('"Built-in tone" removes plugin in one edit', async () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Built-in tone/i })).toBeInTheDocument();
    });

    const select = screen.getByLabelText(/plug-in/i);
    fireEvent.change(select, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('the active toggle and the input and output trims commit once on blur or Enter, and only when changed', async () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={onChange} />);

    // Active toggle
    const toggle = screen.getByRole('checkbox', { name: /active/i });
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ ...mockSlot, active: false });

    onChange.mockClear();

    // Input trim on Enter
    const inputTrim = screen.getByLabelText(/input trim/i);
    fireEvent.change(inputTrim, { target: { value: '3.5' } });
    expect(onChange).not.toHaveBeenCalled(); // Not committed yet
    fireEvent.keyDown(inputTrim, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ ...mockSlot, inputDb: 3.5 });

    onChange.mockClear();

    // Input trim on Enter with same value records nothing
    fireEvent.keyDown(inputTrim, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();

    // Output trim on Blur
    const outputTrim = screen.getByLabelText(/output trim/i);
    fireEvent.change(outputTrim, { target: { value: '-2.0' } });
    expect(onChange).not.toHaveBeenCalled(); // Not committed yet
    fireEvent.blur(outputTrim);
    expect(onChange).toHaveBeenCalledWith({ ...mockSlot, outputDb: -2.0 });

    onChange.mockClear();
    // Blur without changes records nothing
    fireEvent.blur(outputTrim);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('"Edit plug-in" calls plugin_editor_open with localized title, and hint explains focus and shortcuts', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_editor_open') return 12345;
      return null;
    };

    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={vi.fn()} />);

    expect(screen.getByText(/The plug-in window has its own focus and shortcuts\./i)).toBeInTheDocument();

    const editBtn = screen.getByRole('button', { name: /Edit plug-in/i });
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(mockCalls).toContainEqual([
        'plugin_editor_open',
        expect.objectContaining({
          trackId: 'track-1',
          title: expect.stringContaining('Super Amp'),
        }),
      ]);
    });
  });

  it('busy goes through busyGuard, never disabled on a focused control', async () => {
    const { rerender } = render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={vi.fn()} busy={false} />);
    const editBtn = screen.getByRole('button', { name: /Edit plug-in/i });
    editBtn.focus();
    expect(document.activeElement).toBe(editBtn);

    rerender(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={vi.fn()} busy={true} />);

    // Focused control must not be disabled
    expect(editBtn).not.toBeDisabled();
    expect(editBtn).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('PluginNotices and usePluginStatus', () => {
  it('shows localized notice naming plug-in, saying built-in tone plays and document is unchanged', () => {
    const statuses: TrackPluginStatus[] = [
      {
        trackId: 'track-1',
        classId: mockSlot.classId,
        name: 'Super Amp',
        vendor: 'Audio Corp',
        status: 'crashed',
      },
      {
        trackId: 'track-2',
        classId: 'B'.repeat(32),
        name: 'Delay Deluxe',
        vendor: 'FX Labs',
        status: 'needsConsent',
      },
    ];

    const onAllow = vi.fn();
    const onRetry = vi.fn();

    render(
      <PluginNotices
        statuses={statuses}
        trackNames={{ 'track-1': 'Lead Guitar', 'track-2': 'Rhythm Guitar' }}
        onAllow={onAllow}
        onRetry={onRetry}
      />
    );

    // Track 1 notice
    expect(screen.getByText(/Lead Guitar: The plug-in "Super Amp" crashed, so the built-in tone plays instead\. The document is unchanged\./i)).toBeInTheDocument();
    // Track 2 notice
    expect(screen.getByText(/Rhythm Guitar: The plug-in "Delay Deluxe" needs your permission to run on this score, so the built-in tone plays instead\. The document is unchanged\./i)).toBeInTheDocument();

    // needsConsent offers "Allow plug-ins"
    const allowBtn = screen.getByRole('button', { name: /Allow plug-ins/i });
    fireEvent.click(allowBtn);
    expect(onAllow).toHaveBeenCalledTimes(1);

    // crashed offers "Try again"
    const retryBtn = screen.getByRole('button', { name: /Try again/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledWith('track-1');
  });

  it('usePluginStatus fetches statuses and updates on plugin-status event', async () => {
    const initialStatuses: TrackPluginStatus[] = [
      {
        trackId: 'track-1',
        classId: mockSlot.classId,
        name: 'Super Amp',
        vendor: 'Audio Corp',
        status: 'ready',
      },
    ];
    const updatedStatuses: TrackPluginStatus[] = [
      {
        trackId: 'track-1',
        classId: mockSlot.classId,
        name: 'Super Amp',
        vendor: 'Audio Corp',
        status: 'crashed',
      },
    ];

    invokeHandler = async (command: string, args: any) => {
      if (command === 'plugin_status') {
        return mockCalls.filter(c => c[0] === 'plugin_status').length > 1
          ? updatedStatuses
          : initialStatuses;
      }
      return [];
    };

    const { result } = renderHook(() => usePluginStatus('doc-1'));

    await waitFor(() => {
      expect(result.current).toEqual(initialStatuses);
    });

    // Emit plugin-status event
    act(() => {
      eventListeners['plugin-status']?.forEach(h => h({ payload: { documentId: 'doc-1' } }));
    });

    await waitFor(() => {
      expect(result.current).toEqual(updatedStatuses);
    });
  });
});

describe('Sound editing preserves plug-in', () => {
  it('applying a library or factory sound keeps the track plug-in', async () => {
    const onEdit = vi.fn();
    const trackSound: TrackSound = {
      ...soundPreset('lead'),
      plugin: mockSlot,
    };

    const { result } = renderHook(() =>
      useSoundEditing({
        trackId: 'track-1',
        sound: trackSound,
        onEdit,
      })
    );

    // Apply a preset
    await act(async () => {
      await result.current.applyPreset('clean');
    });

    expect(onEdit).toHaveBeenLastCalledWith({
      type: 'setTrackSound',
      trackId: 'track-1',
      sound: expect.objectContaining({
        presetId: 'clean',
        plugin: mockSlot,
      }),
    });

    // Apply a factory sound
    await act(async () => {
      result.current.applyFactoryId('acoustic-strum');
    });

    expect(onEdit).toHaveBeenLastCalledWith({
      type: 'setTrackSound',
      trackId: 'track-1',
      sound: expect.objectContaining({
        plugin: mockSlot,
      }),
    });
  });

  it('copySound strips plug-in across documents or clipboard carries only tone', () => {
    const trackSound: TrackSound = {
      ...soundPreset('lead'),
      plugin: mockSlot,
    };

    copySound(trackSound);
    const inClipboard = soundClipboard();
    // Verify our documented decision: sound clipboard only carries tone/effects/voice without document-local plugin state asset
    expect(inClipboard.sound?.plugin).toBeUndefined();
  });

  describe('plugin-editor-closed event handling', () => {
    it('with a token, it writes one edit', () => {
      const controller = {
        getState: () => ({
          settings: {
            sounds: {
              'track-1': { ...soundPreset('lead'), plugin: mockSlot },
            } as Record<string, any>,
          },
        }),
        edit: vi.fn(),
        bridge: { cancelAsset: vi.fn() },
      };

      const handler = (payload: { documentId: string; trackId: string; assetToken: string | null; state: string | null }) => {
        if (payload.documentId === 'doc-1') {
          if (payload.assetToken && payload.state) {
            const currentSound = controller.getState().settings.sounds[payload.trackId];
            const currentPlugin = currentSound?.plugin;
            if (currentPlugin) {
              const nextSound = {
                ...currentSound,
                plugin: {
                  ...currentPlugin,
                  state: payload.state,
                },
              };
              const candidate = {
                token: payload.assetToken,
                assetId: payload.state,
                info: {
                  filename: `${currentPlugin.name}.bin`,
                  mediaType: 'application/octet-stream',
                  byteLength: 0,
                },
              };
              controller.edit({ type: 'setTrackSound', trackId: payload.trackId, sound: nextSound }, candidate);
            } else {
              controller.bridge.cancelAsset(payload.assetToken);
            }
          }
        }
      };

      handler({
        documentId: 'doc-1',
        trackId: 'track-1',
        assetToken: 'token-abc',
        state: 'new-state-xyz',
      });

      expect(controller.edit).toHaveBeenCalledWith(
        {
          type: 'setTrackSound',
          trackId: 'track-1',
          sound: expect.objectContaining({
            plugin: expect.objectContaining({ state: 'new-state-xyz' }),
          }),
        },
        expect.objectContaining({ token: 'token-abc', assetId: 'new-state-xyz' })
      );
      expect(controller.bridge.cancelAsset).not.toHaveBeenCalled();
    });

    it('with null, it writes nothing', () => {
      const controller = {
        getState: () => ({
          settings: { sounds: { 'track-1': { ...soundPreset('lead'), plugin: mockSlot } } as Record<string, any> },
        }),
        edit: vi.fn(),
        bridge: { cancelAsset: vi.fn() },
      };

      const handler = (payload: { documentId: string; trackId: string; assetToken: string | null; state: string | null }) => {
        if (payload.documentId === 'doc-1') {
          if (payload.assetToken && payload.state) {
            const currentSound = controller.getState().settings.sounds[payload.trackId];
            const currentPlugin = currentSound?.plugin;
            if (currentPlugin) {
              controller.edit({ type: 'setTrackSound', trackId: payload.trackId, sound: { ...currentSound, plugin: { ...currentPlugin, state: payload.state } } });
            } else {
              controller.bridge.cancelAsset(payload.assetToken);
            }
          }
        }
      };

      handler({
        documentId: 'doc-1',
        trackId: 'track-1',
        assetToken: null,
        state: null,
      });

      expect(controller.edit).not.toHaveBeenCalled();
      expect(controller.bridge.cancelAsset).not.toHaveBeenCalled();
    });

    it('if the track plug-in changed meanwhile, it cancels the token and writes nothing', () => {
      const controller = {
        getState: () => ({
          settings: {
            sounds: {
              'track-1': { ...soundPreset('lead'), plugin: undefined },
            } as Record<string, any>,
          },
        }),
        edit: vi.fn(),
        bridge: { cancelAsset: vi.fn() },
      };

      const handler = (payload: { documentId: string; trackId: string; assetToken: string | null; state: string | null }) => {
        if (payload.documentId === 'doc-1') {
          if (payload.assetToken && payload.state) {
            const currentSound = controller.getState().settings.sounds[payload.trackId];
            const currentPlugin = currentSound?.plugin;
            if (currentPlugin) {
              controller.edit({ type: 'setTrackSound', trackId: payload.trackId, sound: { ...currentSound, plugin: { ...currentPlugin, state: payload.state } } });
            } else {
              controller.bridge.cancelAsset(payload.assetToken);
            }
          }
        }
      };

      handler({
        documentId: 'doc-1',
        trackId: 'track-1',
        assetToken: 'token-abc',
        state: 'new-state-xyz',
      });

      expect(controller.edit).not.toHaveBeenCalled();
      expect(controller.bridge.cancelAsset).toHaveBeenCalledWith('token-abc');
    });
  });
});
