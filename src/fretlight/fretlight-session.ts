import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import { frameKey, type FrameProblem, type FretlightFrame } from './frame';

const DEVICE_MAX = 256;
const MESSAGE_MAX = 500;

export type FretlightPhase = 'disconnected' | 'connecting' | 'connected' | 'lost' | 'error';
const PHASES: readonly string[] = ['disconnected', 'connecting', 'connected', 'lost', 'error'];
/** The `fretlight-status` event. `seq` rises with every notice; a notice older than one already seen is stale. */
export interface FretlightStatusEvent { seq: number; session: number; state: FretlightPhase; device: string; message: string; sent: number; coalesced: number }
/** What `fretlight_status` returns. */
export type FretlightStatus = Omit<FretlightStatusEvent, 'seq'>;

export interface FretlightBridge {
  /** Looks for a wired Fretlight and opens it. The only call that lists or opens anything. Resolves with the session number. */
  connect(): Promise<number>;
  /** Sets which LEDs are lit: 132 booleans, `(string - 1) * 22 + fret`, string 1 the high E. */
  sendFrame(session: number, leds: boolean[]): Promise<void>;
  /** Turns the LEDs off and ends the named session, or whatever runs when none is named. */
  disconnect(session?: number): Promise<void>;
  status(): Promise<FretlightStatus>;
  subscribe(onStatus: (status: FretlightStatusEvent) => void): Promise<() => void>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

/** An event payload is untrusted: anything that is not exactly a notice is null, and only the known fields are kept. */
export function parseFretlightStatus(payload: unknown): FretlightStatusEvent | null {
  if (!isObject(payload)) return null;
  const { seq, session, state, device, message, sent, coalesced } = payload;
  if (!integer(seq, 1) || !integer(session, 0) || typeof state !== 'string' || !PHASES.includes(state)) return null;
  if (typeof device !== 'string' || device.length > DEVICE_MAX || typeof message !== 'string' || !integer(sent, 0) || !integer(coalesced, 0)) return null;
  return { seq, session, state: state as FretlightPhase, device, message: message.slice(0, MESSAGE_MAX), sent, coalesced };
}

export const nativeFretlight: FretlightBridge = {
  connect: () => invoke('fretlight_connect'),
  sendFrame: (session, leds) => invoke('fretlight_frame', { session, leds }),
  disconnect: session => invoke('fretlight_disconnect', { session: session ?? null }),
  status: () => invoke('fretlight_status'),
  subscribe: async onStatus => listen<unknown>('fretlight-status', event => { const status = parseFretlightStatus(event.payload); if (status) onStatus(status); }),
};

export interface FretlightSessionState {
  phase: FretlightPhase;
  session: number;
  device: string;
  /** The native side's last words, a code before the English text for a refusal. */
  message: string;
  /** A send that failed while connected. */
  problem: string;
  /** The events could not be attached, so the device cannot be used. */
  unavailable: string;
  /** Why the selected track lights nothing, from the latest frame. */
  frameProblem: FrameProblem | null;
  /** Positions of the latest frame left out for being past fret 21. */
  droppedPositions: number;
  sent: number;
}
export interface FretlightSession {
  subscribe(listener: () => void): () => void;
  get(): FretlightSessionState;
  attach(): Promise<void>;
  /** Looks for the guitar and opens it. Pressed by the player, never called by anything else. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Says which LEDs should be lit. Nothing reaches the device while it is not connected; the newest frame is sent on connecting. */
  sendFrame(frame: FretlightFrame): void;
  dispose(): void;
}
const text = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The Fretlight as the page sees it. It outlives the panel, so the lights follow the score with the View menu closed.
 * One send is in flight at a time and the newest frame wins, so a burst of changes costs one write; the native side
 * limits the rate again and coalesces, so a page that misbehaved could not flood the device either.
 */
export function createFretlightSession(bridge: FretlightBridge): FretlightSession {
  let state: FretlightSessionState = { phase: 'disconnected', session: 0, device: '', message: '', problem: '', unavailable: '', frameProblem: null, droppedPositions: 0, sent: 0 };
  let wanted: { leds: boolean[]; key: string } | null = null, sentKey: string | null = null, inFlight = false;
  let lastNotice = 0, adopted: number | null = null, endedSession = 0, detach: (() => void) | null = null, attaching: Promise<void> | null = null, cancelled = false, disposed = false;
  const listeners = new Set<() => void>();
  const phase = (): FretlightPhase => state.phase;
  const set = (change: Partial<FretlightSessionState>) => {
    const before = state.phase;
    state = { ...state, ...change };
    // A device that has just become connected knows nothing: whatever is wanted is sent again, even a dark frame.
    if (before !== 'connected' && state.phase === 'connected') sentKey = null;
    listeners.forEach(listener => listener());
    if (state.phase === 'connected') flush();
  };
  const flush = () => {
    if (state.phase !== 'connected' || inFlight || !wanted || wanted.key === sentKey) return;
    const { leds, key } = wanted, session = state.session;
    inFlight = true; sentKey = key;
    bridge.sendFrame(session, leds).then(() => true, error => {
      sentKey = null;
      if (phase() === 'connected' && state.session === session) set({ problem: text(error) });
      return false;
    }).then(sent => { inFlight = false; if (sent) flush(); });
  };
  const accept = (session: number) => {
    if (state.phase === 'connecting') {
      // The first notice of a session newer than the one that ended adopts it (that one may still be announcing itself); after that only its own count.
      if (adopted === null) {
        if (session <= endedSession) return false;
        adopted = session; state = { ...state, session };
        return true;
      }
      return session === adopted;
    }
    return session === state.session && state.session > 0;
  };
  const onStatus = (status: FretlightStatusEvent) => {
    if (status.seq <= lastNotice) return;
    lastNotice = status.seq;
    if (!accept(status.session)) return;
    set({ phase: status.state, device: status.device || state.device, message: status.message, sent: status.sent });
  };
  const attach = () => attaching ??= (async () => {
    try {
      detach = await bridge.subscribe(onStatus);
      if (disposed) { detach(); detach = null; return; }
      const native = await bridge.status();
      // After a reload the native side may still hold the guitar; show it so it can be disconnected.
      if (native.state === 'connected' && state.phase === 'disconnected') set({ phase: 'connected', session: native.session, device: native.device });
    } catch (error) { attaching = null; set({ unavailable: text(error) }); }
  })();
  const connect = async () => {
    if (state.phase === 'connecting') return;
    // The listener is attached before anything is opened, so no notice is missed.
    await attach();
    if (!detach) return;
    cancelled = false; adopted = null; endedSession = state.session;
    set({ phase: 'connecting', device: '', message: '', problem: '' });
    try {
      const session = await bridge.connect();
      if (cancelled) { set({ phase: 'disconnected' }); return; }
      // A notice may already have said the device was lost; that stands.
      if (phase() === 'connecting') set({ session, phase: 'connected' });
    } catch (error) {
      if (cancelled) set({ phase: 'disconnected' });
      else if (phase() === 'connecting') set({ phase: 'error', message: text(error) });
    }
  };
  const disconnect = async () => {
    const connecting = state.phase === 'connecting';
    if (connecting) cancelled = true;
    try {
      await bridge.disconnect(connecting ? undefined : state.session);
      sentKey = null;
      set({ problem: '', message: '', phase: 'disconnected' });
    } catch (error) { set({ problem: text(error) }); }
  };
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => state,
    attach,
    connect,
    disconnect,
    sendFrame: frame => {
      wanted = { leds: frame.leds, key: frameKey(frame) };
      if (state.frameProblem !== frame.problem || state.droppedPositions !== frame.dropped) set({ frameProblem: frame.problem, droppedPositions: frame.dropped });
      else flush();
    },
    dispose: () => { disposed = true; detach?.(); detach = null; listeners.clear(); },
  };
}

const sessions = new WeakMap<FretlightBridge, FretlightSession>();
/** The app's one session for a bridge. */
export function fretlightSession(bridge: FretlightBridge = nativeFretlight): FretlightSession {
  let session = sessions.get(bridge);
  if (!session) { session = createFretlightSession(bridge); sessions.set(bridge, session); }
  return session;
}
export const useFretlightState = (session: FretlightSession): FretlightSessionState => useSyncExternalStore(session.subscribe, session.get, session.get);
/** What the toolbar-free parts of the page need to know: whether the lights follow the score. */
export const useFretlightConnected = (session: FretlightSession): boolean => {
  const read = () => session.get().phase === 'connected';
  return useSyncExternalStore(session.subscribe, read, read);
};
