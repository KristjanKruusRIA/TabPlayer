// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { setLanguagePreference } from '../i18n';
import { currentInstrumentFocus, announceInstrumentFocus } from '../instruments/view-preferences';
import { FretlightPanel } from './FretlightPanel';
import { emptyFrame } from './frame';
import { createFretlightSession, fretlightSession, type FretlightBridge, type FretlightStatusEvent } from './fretlight-session';

function fake() {
  let notify: (event: FretlightStatusEvent) => void = () => {};
  const bridge = {
    connect: vi.fn(async () => 4),
    sendFrame: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => ({ session: 0, state: 'disconnected' as const, device: '', message: '', sent: 0, coalesced: 0 })),
    subscribe: vi.fn(async (onStatus: (event: FretlightStatusEvent) => void) => { notify = onStatus; return () => {}; }),
  } satisfies FretlightBridge;
  return { bridge, emit: (event: Partial<FretlightStatusEvent> & { seq: number }) => notify({ session: 4, state: 'connected', device: 'Fretlight (test)', message: '', sent: 0, coalesced: 0, ...event }) };
}
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const show = (bridge: FretlightBridge, trackStrings: number | null = 6) => render(<><FretlightPanel bridge={bridge} trackStrings={trackStrings} /></>);

beforeEach(() => { localStorage.clear(); setLanguagePreference('en'); announceInstrumentFocus('playing'); });
afterEach(() => { cleanup(); setLanguagePreference('en'); });

describe('the Fretlight panel', () => {
  it('is a View menu section that stays open, says it is untested, and opens nothing by itself', async () => {
    const { bridge } = fake();
    const { container } = show(bridge);
    await flush();
    const section = container.querySelector('details.fretlight-panel')!;
    expect(section).toHaveAttribute('data-menu-keep');
    expect(screen.getByText('Fretlight guitar')).toBeInTheDocument();
    expect(screen.getByText(/not tested with a real Fretlight/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is looked for until you press the button/)).toBeInTheDocument();
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(bridge.sendFrame).not.toHaveBeenCalled();
  });
  it('connects when the button is pressed and then offers to disconnect', async () => {
    const { bridge } = fake();
    show(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Fretlight' }));
    await flush();
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('The lights follow the score');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Fretlight' }));
    await flush();
    expect(bridge.disconnect).toHaveBeenCalledWith(4);
    expect(screen.getByRole('button', { name: 'Connect Fretlight' })).toBeInTheDocument();
  });
  it('keeps the button focusable while connecting, never disabled', async () => {
    const { bridge } = fake(); let finish: (session: number) => void = () => {};
    bridge.connect.mockImplementationOnce(() => new Promise<number>(done => { finish = done; }));
    show(bridge);
    const button = screen.getByRole('button', { name: 'Connect Fretlight' });
    button.focus();
    fireEvent.click(button);
    await flush();
    expect(screen.getByText('Looking for a wired Fretlight…')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    finish(4); await flush();
  });
  it('says in words why a connection failed, from the code the native side sends', async () => {
    for (const [message, text] of [
      ['not_found: No wired Fretlight guitar was found. Plug one in and press Connect again.', /No wired Fretlight guitar was found/],
      ['open_timeout: The system did not answer in time.', /did not answer in time/],
      ['open_pending: busy', /still opening the Fretlight/],
      ['list_failed: The USB devices could not be listed: access denied', /could not be connected: .*access denied/],
      ['name_mismatch: USB Keyboard | ', /Fretlight USB ids was found but is named “USB Keyboard”, “\(no name\)”; it was not opened/],
      ['worker_stuck: busy', /not finished its last write/],
    ] as const) {
      cleanup();
      const { bridge } = fake();
      bridge.connect.mockRejectedValueOnce(new Error(message));
      show(bridge);
      fireEvent.click(screen.getByRole('button', { name: 'Connect Fretlight' }));
      await flush();
      expect(screen.getByRole('alert')).toHaveTextContent(text);
    }
  });
  it('shows a lost guitar and offers to connect again', async () => {
    const { bridge, emit } = fake();
    show(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Fretlight' }));
    await flush();
    act(() => emit({ seq: 3, state: 'lost', message: 'The Fretlight stopped answering (x).' }));
    expect(screen.getByRole('status')).toHaveTextContent('Its lights stay as they were');
    expect(screen.getByRole('button', { name: 'Connect Fretlight' })).toBeInTheDocument();
  });
  it('says when the selected track is not a six-string guitar, and only then', async () => {
    const { bridge } = fake();
    const { rerender } = show(bridge, 4);
    expect(screen.getByText('The selected track is not a six-string guitar track, so no lights are sent.')).toBeInTheDocument();
    rerender(<><FretlightPanel bridge={bridge} trackStrings={6} /></>);
    expect(screen.queryByText(/not a six-string guitar track/)).toBeNull();
    rerender(<><FretlightPanel bridge={bridge} trackStrings={0} /></>);
    expect(screen.getByText(/not a six-string guitar track/)).toBeInTheDocument();
  });
  it('counts notes above fret 21 and states the limits', async () => {
    const { bridge } = fake();
    show(bridge);
    const frame = emptyFrame(); frame.dropped = 3;
    act(() => fretlightSession(bridge).sendFrame(frame));
    expect(screen.getByText('3 notes are above fret 21 and are not lit.')).toBeInTheDocument();
    expect(screen.getByText(/wireless models are not/i)).toBeInTheDocument();
  });
  it('follows the instrument view Show choice and can change it', async () => {
    const { bridge } = fake();
    show(bridge);
    const select = screen.getByRole('combobox', { name: 'Lights show' });
    expect(select).toHaveValue('playing');
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Playing notes', 'Selected beat', 'Selected bar', 'Next beat']);
    act(() => announceInstrumentFocus('bar'));
    expect(select).toHaveValue('bar');
    fireEvent.change(select, { target: { value: 'next' } });
    expect(currentInstrumentFocus()).toBe('next');
    expect(select).toHaveValue('next');
  });
  it('uses one session per bridge', () => {
    const { bridge } = fake();
    expect(fretlightSession(bridge)).toBe(fretlightSession(bridge));
    expect(createFretlightSession(bridge)).not.toBe(fretlightSession(bridge));
  });
});
