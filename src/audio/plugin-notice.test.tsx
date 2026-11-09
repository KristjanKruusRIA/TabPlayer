// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PluginNotices } from './PluginNotices';
import { usePluginNotices } from './usePluginStatus';
import { pluginEditorClose, pluginNotices } from './plugin-host';
import { getMessage, setLanguagePreference } from '../i18n';

let invokeHandler: (command: string, args?: any) => Promise<any> = async () => null;
const eventListeners: Record<string, Array<(event: { payload: any }) => void>> = {};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => invokeHandler(command, args)),
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

const emit = (event: string, payload: unknown) => {
  act(() => {
    for (const handler of eventListeners[event] ?? []) handler({ payload });
  });
};

beforeEach(() => {
  for (const key of Object.keys(eventListeners)) delete eventListeners[key];
  invokeHandler = async () => null;
  pluginNotices.clear();
  setLanguagePreference('en');
});

afterEach(() => {
  cleanup();
  setLanguagePreference('en');
});

describe('plug-in notices from the native side', () => {
  it('collects the notices of its own document, once each, and ignores keys it does not know', async () => {
    const { result } = renderHook(() => usePluginNotices('doc-1'));
    await waitFor(() => expect(eventListeners['plugin-notice']?.length).toBeGreaterThan(0));
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't1', key: 'plugin.busy' });
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't1', key: 'plugin.busy' });
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't2', key: 'plugin.history_full' });
    emit('plugin-notice', { documentId: 'doc-2', trackId: 't1', key: 'plugin.save_failed' });
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't3', key: 'plugin.not_a_notice' });
    expect(result.current).toEqual([
      { documentId: 'doc-1', trackId: 't1', key: 'plugin.busy' },
      { documentId: 'doc-1', trackId: 't2', key: 'plugin.history_full' },
    ]);
  });

  it('shows each notice with its track name in the live region, and dismisses it from a button outside it', () => {
    const onDismiss = vi.fn();
    const notices = [
      { documentId: 'doc-1', trackId: 't1', key: 'plugin.busy' as const },
      { documentId: 'doc-1', trackId: 't2', key: 'plugin.save_failed' as const },
    ];
    const { container } = render(<PluginNotices notices={notices} trackNames={{ t1: 'Lead', t2: 'Bass' }} onDismiss={onDismiss} />);
    const region = container.querySelector('[role="status"]')!;
    expect(region).toHaveTextContent(`Lead: ${getMessage('en', 'plugin.busy')}`);
    expect(region).toHaveTextContent(`Bass: ${getMessage('en', 'plugin.save_failed')}`);
    expect(region.querySelector('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${getMessage('en', 'plugin.dismiss')}: Bass` }));
    expect(onDismiss).toHaveBeenCalledWith(notices[1]);
  });

  it('a dismissed notice leaves the list', async () => {
    const { result } = renderHook(() => usePluginNotices('doc-1'));
    await waitFor(() => expect(eventListeners['plugin-notice']?.length).toBeGreaterThan(0));
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't1', key: 'plugin.busy' });
    act(() => pluginNotices.dismiss(result.current[0]));
    expect(result.current).toEqual([]);
  });

  it.each(['en', 'et', 'de'] as const)('words the busy, save-failed and history-full notices in %s', language => {
    setLanguagePreference(language);
    const notices = [
      { documentId: 'd', trackId: 't1', key: 'plugin.busy' as const },
      { documentId: 'd', trackId: 't2', key: 'plugin.save_failed' as const },
      { documentId: 'd', trackId: 't3', key: 'plugin.history_full' as const },
    ];
    render(<PluginNotices notices={notices} />);
    for (const key of ['plugin.busy', 'plugin.save_failed', 'plugin.history_full'] as const) {
      expect(screen.getByText(getMessage(language, key))).toBeInTheDocument();
    }
    if (language !== 'en') {
      expect(getMessage(language, 'plugin.busy')).not.toBe(getMessage('en', 'plugin.busy'));
      expect(getMessage(language, 'plugin.save_failed')).not.toBe(getMessage('en', 'plugin.save_failed'));
      expect(getMessage(language, 'plugin.dismiss')).not.toBe(getMessage('en', 'plugin.dismiss'));
    }
  });

  it('an editor close whose changes were not kept shows its error once, even when the notice event also comes', async () => {
    invokeHandler = async command => {
      if (command === 'plugin_editor_close') {
        return { documentId: 'doc-1', trackId: 't1', state: null, assetToken: null, error: 'plugin.history_full' };
      }
      return null;
    };
    const { result } = renderHook(() => usePluginNotices('doc-1'));
    await waitFor(() => expect(eventListeners['plugin-notice']?.length).toBeGreaterThan(0));
    const payload = await act(() => pluginEditorClose('doc-1', 't1'));
    expect(payload.error).toBe('plugin.history_full');
    expect(result.current).toEqual([{ documentId: 'doc-1', trackId: 't1', key: 'plugin.history_full' }]);
    emit('plugin-notice', { documentId: 'doc-1', trackId: 't1', key: 'plugin.history_full' });
    expect(result.current).toHaveLength(1);
  });

  it('an editor close that kept the changes adds no notice', async () => {
    invokeHandler = async () => ({ documentId: 'doc-1', trackId: 't1', state: 'abc', assetToken: 'tok' });
    const { result } = renderHook(() => usePluginNotices('doc-1'));
    await act(() => pluginEditorClose('doc-1', 't1'));
    expect(result.current).toEqual([]);
  });
});
