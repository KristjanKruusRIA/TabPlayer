import { describe, expect, it, vi } from 'vitest';
import { FRETLIGHT_LEDS, emptyFrame, type FretlightFrame } from './frame';
import { createFretlightSession, parseFretlightStatus, type FretlightBridge, type FretlightStatusEvent } from './fretlight-session';

const lit = (...indexes: number[]): FretlightFrame => { const frame = emptyFrame(); for (const index of indexes) frame.leds[index] = true; return frame; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fake() {
  let notify: (event: FretlightStatusEvent) => void = () => {};
  const sends: Array<{ session: number; leds: boolean[] }> = [];
  const bridge = {
    connect: vi.fn(async () => 7),
    sendFrame: vi.fn(async (session: number, leds: boolean[]) => { sends.push({ session, leds }); }),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => ({ session: 0, state: 'disconnected' as const, device: '', message: '', sent: 0, coalesced: 0 })),
    subscribe: vi.fn(async (onStatus: (event: FretlightStatusEvent) => void) => { notify = onStatus; return () => {}; }),
  } satisfies FretlightBridge;
  return { bridge, sends, emit: (event: Partial<FretlightStatusEvent> & { seq: number }) => notify({ session: 7, state: 'connected', device: 'Fretlight', message: '', sent: 0, coalesced: 0, ...event }) };
}

describe('the Fretlight session', () => {
  it('opens nothing and sends nothing until Connect is pressed', async () => {
    const { bridge, sends } = fake(), session = createFretlightSession(bridge);
    await session.attach();
    session.sendFrame(lit(3)); session.sendFrame(lit(4));
    await flush();
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(bridge.sendFrame).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(session.get().phase).toBe('disconnected');
  });
  it('connects, then sends the frame wanted at that moment once, even when nothing is lit', async () => {
    const { bridge, sends } = fake(), session = createFretlightSession(bridge);
    session.sendFrame(emptyFrame());
    await session.connect();
    await flush();
    expect(session.get()).toMatchObject({ phase: 'connected', session: 7 });
    expect(sends).toHaveLength(1);
    expect(sends[0].session).toBe(7);
    expect(sends[0].leds).toHaveLength(FRETLIGHT_LEDS);
    expect(sends[0].leds.some(Boolean)).toBe(false);
  });
  it('sends when the lit set changes and not when it does not', async () => {
    const { bridge, sends } = fake(), session = createFretlightSession(bridge);
    await session.connect(); await flush();
    sends.length = 0;
    session.sendFrame(lit(5)); await flush();
    session.sendFrame(lit(5)); await flush();
    session.sendFrame(lit(6)); await flush();
    expect(sends.map(send => send.leds.indexOf(true))).toEqual([5, 6]);
  });
  it('keeps one send in flight and sends only the newest frame after it', async () => {
    const { bridge, sends } = fake(); let release: () => void = () => {};
    const session = createFretlightSession(bridge);
    await session.connect(); await flush();
    sends.length = 0;
    bridge.sendFrame.mockImplementationOnce(async (s: number, leds: boolean[]) => { sends.push({ session: s, leds }); await new Promise<void>(done => { release = done; }); });
    session.sendFrame(lit(1)); await flush();
    for (const index of [2, 3, 4, 5, 6]) session.sendFrame(lit(index));
    await flush();
    expect(sends).toHaveLength(1);
    release(); await flush();
    expect(sends.map(send => send.leds.indexOf(true))).toEqual([1, 6]);
  });
  it('says connecting while the native side opens, and an error when it cannot', async () => {
    const { bridge } = fake(); let fail: (error: Error) => void = () => {};
    bridge.connect.mockImplementationOnce(() => new Promise<number>((_, reject) => { fail = reject; }));
    const session = createFretlightSession(bridge);
    const pending = session.connect(); await flush();
    expect(session.get().phase).toBe('connecting');
    fail(new Error('No Fretlight guitar found.')); await pending; await flush();
    expect(session.get()).toMatchObject({ phase: 'error', message: 'No Fretlight guitar found.' });
  });
  it('takes the device name from the notices that arrive while the connection is still opening', async () => {
    const { bridge, emit } = fake(); let finish: (session: number) => void = () => {};
    bridge.connect.mockImplementationOnce(() => new Promise<number>(done => { finish = done; }));
    const session = createFretlightSession(bridge);
    await session.attach();
    const pending = session.connect(); await flush();
    emit({ seq: 1, state: 'connecting', device: '' });
    emit({ seq: 2, state: 'connected', device: 'Fretlight (test)' });
    expect(session.get()).toMatchObject({ phase: 'connected', session: 7, device: 'Fretlight (test)' });
    // A notice of the session that ended before this one began is not taken for it.
    emit({ seq: 3, state: 'disconnected', session: 6 });
    expect(session.get().phase).toBe('connected');
    finish(7); await pending; await flush();
    expect(session.get()).toMatchObject({ phase: 'connected', device: 'Fretlight (test)' });
  });
  it('shows a lost device and sends nothing more until the player connects again', async () => {
    const { bridge, sends, emit } = fake(), session = createFretlightSession(bridge);
    await session.attach(); await session.connect(); await flush();
    emit({ seq: 5, state: 'lost', message: 'The Fretlight was unplugged.' });
    expect(session.get()).toMatchObject({ phase: 'lost', message: 'The Fretlight was unplugged.' });
    sends.length = 0;
    session.sendFrame(lit(9)); await flush();
    expect(sends).toEqual([]);
  });
  it('drops notices that are older than one already seen or belong to another session', async () => {
    const { bridge, emit } = fake(), session = createFretlightSession(bridge);
    await session.attach(); await session.connect(); await flush();
    emit({ seq: 9, state: 'lost' });
    emit({ seq: 8, state: 'connected' });
    expect(session.get().phase).toBe('lost');
    emit({ seq: 10, session: 99, state: 'connected' });
    expect(session.get().phase).toBe('lost');
  });
  it('disconnects by naming its session and then sends nothing', async () => {
    const { bridge, sends } = fake(), session = createFretlightSession(bridge);
    await session.connect(); await flush();
    await session.disconnect();
    expect(bridge.disconnect).toHaveBeenCalledWith(7);
    expect(session.get().phase).toBe('disconnected');
    sends.length = 0;
    session.sendFrame(lit(2)); await flush();
    expect(sends).toEqual([]);
  });
  it('shows a failed send without throwing, and keeps the device connected', async () => {
    const { bridge } = fake(), session = createFretlightSession(bridge);
    await session.connect(); await flush();
    bridge.sendFrame.mockRejectedValueOnce(new Error('The frame was refused.'));
    session.sendFrame(lit(1)); await flush();
    expect(session.get().problem).toBe('The frame was refused.');
    expect(session.get().phase).toBe('connected');
  });
  it('keeps what the track needs, for the panel to say', async () => {
    const { bridge } = fake(), session = createFretlightSession(bridge);
    session.sendFrame(emptyFrame('not_six_string'));
    expect(session.get().frameProblem).toBe('not_six_string');
    const frame = lit(1); frame.dropped = 2;
    session.sendFrame(frame);
    expect(session.get()).toMatchObject({ frameProblem: null, droppedPositions: 2 });
  });
});

describe('parseFretlightStatus', () => {
  const good = { seq: 1, session: 3, state: 'connected', device: 'Fretlight', message: '', sent: 4, coalesced: 1 };
  it('keeps a well-formed notice', () => expect(parseFretlightStatus(good)).toEqual(good));
  it('refuses anything else and trims long text', () => {
    for (const hostile of [null, 'x', [], { ...good, state: 'on' }, { ...good, seq: 0 }, { ...good, session: -1 }, { ...good, sent: 1.5 }, { ...good, device: 4 }, { ...good, message: {} }]) expect(parseFretlightStatus(hostile)).toBeNull();
    expect(parseFretlightStatus({ ...good, message: 'x'.repeat(2000) })!.message).toHaveLength(500);
  });
});
