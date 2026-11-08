// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { EditCommand, PluginSlot, TrackSound } from '../edit-types';
import { PluginSlotPanel } from './PluginSlotPanel';
import { PluginNotices } from './PluginNotices';
import { usePluginStatus } from './usePluginStatus';
import { renderHook, act } from '@testing-library/react';
import {
  handlePluginEditorClosed,
  makePluginStateCandidate,
  setOpenedEditor,
  localizePluginError,
  movedPlugins,
  replacedByAdd,
  type PluginLibraryEntry,
  type TrackPluginStatus,
} from './plugin-host';
import { soundPreset } from './sound-model';
import { useSoundEditing } from './useSoundEditing';
import { copySound, soundClipboard, forgetSoundClipboard } from './sound-library';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import { setLanguagePreference, getMessage } from '../i18n';

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

  it('renders fallback option for slot.classId when not present in library entries', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [];
      return null;
    };

    render(<PluginSlotPanel trackId="track-1" slot={mockSlot} onChange={vi.fn()} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/plug-in/i);
      expect(select).toHaveValue(mockSlot.classId);
      expect(screen.getByRole('option', { name: /Super Amp/i })).toBeInTheDocument();
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
    it('with a token, it writes one edit using makePluginStateCandidate', () => {
      const controller = {
        getState: () => ({
          settings: {
            sounds: {
              'track-1': { ...soundPreset('lead'), plugin: mockSlot },
            } as Record<string, any>,
          },
        }),
        edit: vi.fn(),
        cancelAsset: vi.fn(),
      };

      handlePluginEditorClosed(
        {
          documentId: 'doc-1',
          trackId: 'track-1',
          assetToken: 'token-abc',
          state: 'new-state-xyz',
        },
        'doc-1',
        controller
      );

      expect(controller.edit).toHaveBeenCalledWith(
        {
          type: 'setTrackSound',
          trackId: 'track-1',
          sound: expect.objectContaining({
            plugin: expect.objectContaining({ state: 'new-state-xyz' }),
          }),
        },
        expect.objectContaining({
          token: 'token-abc',
          assetId: 'new-state-xyz',
          info: expect.objectContaining({ byteLength: 20 }),
        })
      );
      expect(controller.cancelAsset).not.toHaveBeenCalled();
    });

    it('with null, it writes nothing', () => {
      const controller = {
        getState: () => ({
          settings: { sounds: { 'track-1': { ...soundPreset('lead'), plugin: mockSlot } } as Record<string, any> },
        }),
        edit: vi.fn(),
        cancelAsset: vi.fn(),
      };

      handlePluginEditorClosed(
        {
          documentId: 'doc-1',
          trackId: 'track-1',
          assetToken: null,
          state: null,
        },
        'doc-1',
        controller
      );

      expect(controller.edit).not.toHaveBeenCalled();
      expect(controller.cancelAsset).not.toHaveBeenCalled();
    });

    it('if the track plug-in was removed meanwhile, it cancels the token and writes nothing', () => {
      const controller = {
        getState: () => ({
          settings: {
            sounds: {
              'track-1': { ...soundPreset('lead'), plugin: undefined },
            } as Record<string, any>,
          },
        }),
        edit: vi.fn(),
        cancelAsset: vi.fn(),
      };

      handlePluginEditorClosed(
        {
          documentId: 'doc-1',
          trackId: 'track-1',
          assetToken: 'token-abc',
          state: 'new-state-xyz',
        },
        'doc-1',
        controller
      );

      expect(controller.edit).not.toHaveBeenCalled();
      expect(controller.cancelAsset).toHaveBeenCalledWith('token-abc');
    });

    it('if the track plug-in classId changed while the editor was open, it cancels the token and writes nothing', () => {
      setOpenedEditor({
        documentId: 'doc-1',
        trackId: 'track-1',
        classId: 'A'.repeat(32),
      });

      const differentSlot: PluginSlot = {
        ...mockSlot,
        classId: 'B'.repeat(32),
        name: 'Different Amp',
      };

      const controller = {
        getState: () => ({
          settings: {
            sounds: {
              'track-1': { ...soundPreset('lead'), plugin: differentSlot },
            } as Record<string, any>,
          },
        }),
        edit: vi.fn(),
        cancelAsset: vi.fn(),
      };

      handlePluginEditorClosed(
        {
          documentId: 'doc-1',
          trackId: 'track-1',
          assetToken: 'token-diff',
          state: 'new-state-xyz',
        },
        'doc-1',
        controller
      );

      expect(controller.edit).not.toHaveBeenCalled();
      expect(controller.cancelAsset).toHaveBeenCalledWith('token-diff');
    });

    it('previewEdit accepts setTrackSound with makePluginStateCandidate and valid 64-hex state without throwing', () => {
      const project = blankProject();
      const stateId = 'a'.repeat(64);
      const candidate = makePluginStateCandidate(stateId, 'token-123');
      const projectWithAsset = {
        ...project,
        assets: {
          ...project.assets,
          [candidate.assetId]: candidate.info,
        },
      };
      const edit: EditCommand = {
        type: 'setTrackSound',
        trackId: 'base/0',
        sound: {
          ...soundPreset('lead'),
          plugin: {
            format: 'vst3',
            classId: 'A'.repeat(32),
            name: 'Super Amp',
            vendor: 'Audio Corp',
            active: true,
            inputDb: 0,
            outputDb: 0,
            state: stateId,
          },
        },
      };
      expect(() => previewEdit(projectWithAsset, edit)).not.toThrow();
      const built = previewEdit(projectWithAsset, edit);
      expect(built.settings.sounds['base/0']?.plugin?.state).toBe(stateId);
    });
  });
});

describe('review fixes: errors are shown, never filtered', () => {
  afterEach(() => setLanguagePreference('en'));

  it.each([
    "Cannot read properties of undefined (reading 'invoke')",
    'window.__TAURI_INTERNALS__ is missing',
    'unexpected plugin_library_list call',
  ])('shows a library failure whose text is %s', async message => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') throw new Error(message);
      return null;
    };
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
  });

  it('maps both strings the backend sends for a full undo history, in every language', () => {
    for (const lang of ['en', 'et', 'de'] as const) {
      const t = (key: any, params?: any) => getMessage(lang, key, params);
      const expected = t('plugin.history_full');
      expect(expected).not.toMatch(/^plugin\./);
      expect(localizePluginError('plugin.history_full', t)).toBe(expected);
      expect(localizePluginError(new Error('plugin.history_full'), t)).toBe(expected);
      expect(localizePluginError('The undo history holds as much plug-in state as it can.', t)).toBe(expected);
    }
    expect(getMessage('en', 'plugin.history_full')).not.toMatch(/Close the window/);
  });

  it('translates the remaining backend errors under et and de', () => {
    const raw = [
      'Plug-in class not found in library.',
      'Plug-in session is not ready.',
      'Invalid plug-in class ID.',
      'the plug-in helper reported Crashed: boom',
      'the plug-in helper broke the protocol: bad frame',
      'request refused: no room',
    ];
    for (const lang of ['et', 'de'] as const) {
      const t = (key: any, params?: any) => getMessage(lang, key, params);
      for (const message of raw) {
        const out = localizePluginError(message, t);
        expect(out, `${lang}: ${message}`).not.toBe(message);
        expect(out).not.toMatch(/^plugin\./);
      }
    }
  });

  it('shows the translated library error under et, not the English text', async () => {
    setLanguagePreference('et');
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') throw new Error('This plug-in library was made by a newer TabPlayer.');
      return null;
    };
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).not.toHaveTextContent(/newer TabPlayer/);
  });
});

describe('review fixes: Save plug-in settings', () => {
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Edit plug-in/i }));
    await waitFor(() => expect(mockCalls.some(([c]) => c === 'plugin_editor_open')).toBe(true));
  };

  it('is offered only while the editor is open, and commits the returned state with its token', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_editor_open') return 7;
      if (command === 'plugin_editor_save') return { state: 'n'.repeat(64), assetToken: 'tok-1' };
      return null;
    };
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" documentId="doc-1" slot={mockSlot} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Save plug-in settings' })).toBeNull();
    await open();
    const save = await screen.findByRole('button', { name: 'Save plug-in settings' });
    fireEvent.click(save);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ ...mockSlot, state: 'n'.repeat(64) }, 'tok-1');
    expect(mockCalls).toContainEqual(['plugin_editor_save', { documentId: 'doc-1', trackId: 'track-1' }]);
  });

  it('records nothing when the state is unchanged', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_editor_open') return 7;
      if (command === 'plugin_editor_save') return null;
      return null;
    };
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="track-1" documentId="doc-1" slot={mockSlot} onChange={onChange} />);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Save plug-in settings' }));
    await waitFor(() => expect(mockCalls.some(([c]) => c === 'plugin_editor_save')).toBe(true));
    invokeHandler = async command => (command === 'plugin_editor_save' ? { state: mockSlot.state, assetToken: 't' } : null);
    fireEvent.click(screen.getByRole('button', { name: 'Save plug-in settings' }));
    await waitFor(() => expect(mockCalls.filter(([c]) => c === 'plugin_editor_save').length).toBe(2));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('goes away when the editor closes, and shows a save failure (full history) translated', async () => {
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [mockEntry];
      if (command === 'plugin_editor_open') return 7;
      if (command === 'plugin_editor_save') throw 'plugin.history_full';
      return null;
    };
    render(<PluginSlotPanel trackId="track-1" documentId="doc-1" slot={mockSlot} onChange={vi.fn()} />);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Save plug-in settings' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(getMessage('en', 'plugin.history_full')));
    await waitFor(() => expect(eventListeners['plugin-editor-closed']?.length).toBeGreaterThan(0));
    act(() => {
      for (const h of eventListeners['plugin-editor-closed']) h({ payload: { documentId: 'doc-1', trackId: 'track-1', state: null, assetToken: null } });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save plug-in settings' })).toBeNull());
  });
});

describe('review fixes: moved classes and replaced plug-ins', () => {
  const moved = (classId: string, name: string): PluginLibraryEntry => ({
    ...mockEntry, classId, name, bundle: String.raw`C:\New\${name}.vst3`, previousBundle: String.raw`C:\Old\${name}.vst3`,
  });

  it('movedPlugins lists every track that uses a moved class, not only the current one', () => {
    const entries = [moved('A'.repeat(32), 'Amp'), moved('B'.repeat(32), 'Delay'), { ...mockEntry, classId: 'C'.repeat(32), name: 'Calm' }];
    const statuses: TrackPluginStatus[] = [
      { trackId: 't1', classId: 'A'.repeat(32), name: 'Amp', vendor: '', status: 'ready' },
      { trackId: 't2', classId: 'B'.repeat(32), name: 'Delay', vendor: '', status: 'ready' },
      { trackId: 't3', classId: 'C'.repeat(32), name: 'Calm', vendor: '', status: 'ready' },
      { trackId: 't4', classId: 'A'.repeat(32), name: 'Amp', vendor: '', status: 'ready' },
    ];
    expect(movedPlugins(statuses, entries).map(m => m.trackId)).toEqual(['t1', 't2', 't4']);
  });

  it('PluginNotices shows a moved warning per affected track', () => {
    render(
      <PluginNotices
        statuses={[]}
        moved={[
          { trackId: 't1', name: 'Amp', bundle: String.raw`C:\New\Amp.vst3`, previousBundle: String.raw`C:\Old\Amp.vst3` },
          { trackId: 't2', name: 'Delay', bundle: String.raw`C:\New\Delay.vst3`, previousBundle: String.raw`C:\Old\Delay.vst3` },
        ]}
        trackNames={{ t1: 'Lead', t2: 'Bass' }}
      />,
    );
    expect(screen.getByText(/Lead: .*Amp.*C:\\New\\Amp\.vst3.*C:\\Old\\Amp\.vst3/)).toBeInTheDocument();
    expect(screen.getByText(/Bass: .*Delay/)).toBeInTheDocument();
  });

  it('replacedByAdd names the plug-ins whose file changed in this add only', () => {
    const before = [
      { ...mockEntry, classId: 'A'.repeat(32), bundle: String.raw`C:\Old\Amp.vst3` },
      { ...mockEntry, classId: 'B'.repeat(32), name: 'Old news', previousBundle: 'x' },
    ];
    const after = [
      { ...moved('A'.repeat(32), 'Super Amp'), bundle: String.raw`C:\New\Amp.vst3`, previousBundle: String.raw`C:\Old\Amp.vst3` },
      { ...before[1] },
      { ...mockEntry, classId: 'D'.repeat(32), name: 'Fresh' },
    ];
    const out = replacedByAdd(before, after);
    expect(out.map(e => e.classId)).toEqual(['A'.repeat(32)]);
  });

  it('adding a bundle that takes over another plug-in shows an alert naming it and its old file', async () => {
    const oldEntry = { ...mockEntry, bundle: String.raw`C:\Old\SuperAmp.vst3` };
    const taken = { ...mockEntry, bundle: String.raw`C:\Hostile\Thing.vst3`, previousBundle: String.raw`C:\Old\SuperAmp.vst3` };
    invokeHandler = async (command: string) => {
      if (command === 'plugin_library_list') return [oldEntry];
      if (command === 'plugin_library_add') return [taken];
      return null;
    };
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);
    await screen.findByRole('option', { name: /Super Amp/ });
    fireEvent.click(screen.getByRole('button', { name: /Add plug-in…/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Super Amp');
    expect(alert).toHaveTextContent(String.raw`C:\Old\SuperAmp.vst3`);
    expect(alert).toHaveTextContent(String.raw`C:\Hostile\Thing.vst3`);
  });

  it('a full library says so before the dialog opens', async () => {
    const many = Array.from({ length: 256 }, (_, i) => ({ ...mockEntry, classId: i.toString(16).toUpperCase().padStart(32, '0'), name: `P${i}` }));
    invokeHandler = async (command: string) => (command === 'plugin_library_list' ? many : null);
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);
    await screen.findByRole('option', { name: /^P0 / });
    fireEvent.click(screen.getByRole('button', { name: /Add plug-in…/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/library is full/i);
    expect(mockCalls.some(([c]) => c === 'plugin_library_add')).toBe(false);
  });

  it('removes any library entry, not only the one on the current track', async () => {
    const other = { ...mockEntry, classId: 'B'.repeat(32), name: 'Other FX' };
    invokeHandler = async (command: string) => (command === 'plugin_library_list' ? [mockEntry, other] : null);
    render(<PluginSlotPanel trackId="track-1" slot={undefined} onChange={vi.fn()} />);
    await screen.findByRole('option', { name: /Other FX/ });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Other FX from library' }));
    await waitFor(() => expect(mockCalls).toContainEqual(['plugin_library_remove', { classId: 'B'.repeat(32) }]));
    await waitFor(() => expect(screen.queryByRole('option', { name: /Other FX/ })).toBeNull());
  });
});

describe('review fixes: consent, retry, notices', () => {
  it('PluginNotices shows a failed consent or retry instead of dropping it', async () => {
    const statuses: TrackPluginStatus[] = [
      { trackId: 't1', classId: 'A'.repeat(32), name: 'Amp', vendor: '', status: 'crashed' },
      { trackId: 't2', classId: 'B'.repeat(32), name: 'Delay', vendor: '', status: 'needsConsent' },
    ];
    const onAllow = vi.fn(async () => { throw new Error('Could not use the plug-in library file: disk gone'); });
    const onRetry = vi.fn(async () => { throw new Error('Plug-in session is not ready.'); });
    render(<PluginNotices statuses={statuses} onAllow={onAllow} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Allow plug-ins/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/disk gone/);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not ready/i));
  });

  it('PluginSlotPanel shows a failed onAllow or onRetry', async () => {
    const onRetry = vi.fn(async () => { throw new Error('Plug-in session is not ready.'); });
    render(<PluginSlotPanel trackId="t" slot={mockSlot} status="crashed" onChange={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not ready/i);
    cleanup();
    const onAllow = vi.fn(async () => { throw new Error('Could not use the plug-in library file: denied'); });
    render(<PluginSlotPanel trackId="t" slot={mockSlot} status="needsConsent" onChange={vi.fn()} onAllow={onAllow} />);
    fireEvent.click(screen.getByRole('button', { name: /Allow plug-ins/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/denied/);
  });

  it.each(['crashed', 'hung', 'underrun', 'nonFinite'] as const)('offers Try again on %s', status => {
    const onRetry = vi.fn();
    render(<PluginSlotPanel trackId="t" slot={mockSlot} status={status} onChange={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps a single live region for all notices, with the buttons outside it', () => {
    const statuses: TrackPluginStatus[] = [
      { trackId: 't1', classId: 'A'.repeat(32), name: 'Amp', vendor: '', status: 'crashed' },
      { trackId: 't2', classId: 'B'.repeat(32), name: 'Delay', vendor: '', status: 'hung' },
    ];
    const { container } = render(<PluginNotices statuses={statuses} onRetry={vi.fn()} />);
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].querySelector('button')).toBeNull();
    expect(regions[0]).toHaveTextContent('Amp');
    expect(regions[0]).toHaveTextContent('Delay');
    expect(screen.getAllByRole('button', { name: /Try again/i })).toHaveLength(2);
  });

  it('keeps the panel buttons outside its status live region', () => {
    const { container } = render(<PluginSlotPanel trackId="t" slot={mockSlot} status="crashed" onChange={vi.fn()} onRetry={vi.fn()} />);
    for (const region of container.querySelectorAll('[role="status"]')) expect(region.querySelector('button')).toBeNull();
  });
});

describe('review fixes: trims and busy', () => {
  it('an emptied trim field reverts and records nothing', () => {
    const onChange = vi.fn();
    render(<PluginSlotPanel trackId="t" slot={{ ...mockSlot, inputDb: 3 }} onChange={onChange} />);
    const input = screen.getByLabelText('Input trim') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('3');
    const output = screen.getByLabelText('Output trim') as HTMLInputElement;
    fireEvent.change(output, { target: { value: '' } });
    fireEvent.keyDown(output, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(output.value).toBe('0');
  });

  it('busy refuses the trims without disabling a focused control', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PluginSlotPanel trackId="t" slot={mockSlot} onChange={onChange} busy={false} />);
    const check = screen.getByRole('checkbox', { name: 'Active' });
    check.focus();
    rerender(<PluginSlotPanel trackId="t" slot={mockSlot} onChange={onChange} busy={true} />);
    expect(check).not.toBeDisabled();
    expect(check.closest('fieldset')).not.toBeDisabled();
    const input = screen.getByLabelText('Input trim') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a trim typed just before busy began, whose blur was refused, is committed once busy ends', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PluginSlotPanel trackId="t" slot={mockSlot} onChange={onChange} busy={false} />);
    const input = screen.getByLabelText('Input trim') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    rerender(<PluginSlotPanel trackId="t" slot={mockSlot} onChange={onChange} busy={true} />);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    rerender(<PluginSlotPanel trackId="t" slot={mockSlot} onChange={onChange} busy={false} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...mockSlot, inputDb: 5 });
  });
});

describe('review fixes: one opened editor per track', () => {
  it('closing track A after changing its plug-in does not apply old-class state, even with B open', () => {
    setOpenedEditor({ documentId: 'doc-1', trackId: 'A', classId: 'A'.repeat(32) });
    setOpenedEditor({ documentId: 'doc-1', trackId: 'B', classId: 'B'.repeat(32) });
    const controller = {
      getState: () => ({ settings: { sounds: { A: { ...soundPreset('lead'), plugin: { ...mockSlot, classId: 'C'.repeat(32) } } } as Record<string, any> } }),
      edit: vi.fn(),
      cancelAsset: vi.fn(),
    };
    handlePluginEditorClosed({ documentId: 'doc-1', trackId: 'A', assetToken: 'tok', state: 'new' }, 'doc-1', controller);
    expect(controller.edit).not.toHaveBeenCalled();
    expect(controller.cancelAsset).toHaveBeenCalledWith('tok');
    setOpenedEditor(null);
  });
});
