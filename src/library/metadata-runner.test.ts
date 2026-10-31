import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetadataRunner, type MetadataRunner } from './metadata-runner';
import type { MetadataInput, MetadataResult } from './types';

const input: MetadataInput = { sha256: 'score-a', base: { kind: 'blank', title: 'First', artist: 'Artist' }, edits: [] };
const result: MetadataResult = {
  sha256: 'score-a',
  metadata: { title: 'First', artist: 'Artist', album: '', trackNames: ['Guitar'], metadataTruncated: false },
  error: null
};

class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructionError: Error | null = null;
  static post: ((worker: FakeWorker) => void) | null = null;
  readonly requests: { cmd: 'tabplayer.metadata.extract'; id: number; sha256: string; input: MetadataInput }[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    if (FakeWorker.constructionError) throw FakeWorker.constructionError;
    FakeWorker.instances.push(this);
  }

  postMessage(request: { cmd: 'tabplayer.metadata.extract'; id: number; sha256: string; input: MetadataInput }) {
    this.requests.push(request);
    FakeWorker.post?.(this);
  }

  terminate() { this.terminated = true; }

  reply(value: unknown = result) {
    const request = this.requests[0];
    this.onmessage?.({ data: { id: request.id, sha256: request.sha256, result: value } } as MessageEvent);
  }
}

describe('metadata runner', () => {
  let runner: MetadataRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.instances = [];
    FakeWorker.constructionError = null;
    FakeWorker.post = null;
    runner = createMetadataRunner();
  });

  afterEach(() => {
    runner.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends the namespaced extraction command and returns metadata only for the matching receipt', async () => {
    const pending = runner.run(input, new AbortController().signal);
    const worker = FakeWorker.instances[0];
    expect(worker.url.pathname).toMatch(/\/metadata\.worker\.ts$/);
    expect(worker.options).toEqual({ type: 'module' });
    worker.reply();
    await expect(pending).resolves.toEqual(result);
    expect(worker.requests).toEqual([{ cmd: 'tabplayer.metadata.extract', id: 1, sha256: 'score-a', input }]);
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows one parse in flight and creates a new worker with a later request ID after completion', async () => {
    const pending = runner.run(input, new AbortController().signal);
    await expect(runner.run(input, new AbortController().signal)).rejects.toThrow(/already running/i);
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0].reply();
    await pending;
    const next = runner.run(input, new AbortController().signal);
    expect(FakeWorker.instances[1].requests[0].id).toBe(2);
    FakeWorker.instances[1].reply();
    await next;
  });

  it('ignores old request IDs and mismatched envelope or result SHA receipts', async () => {
    const pending = runner.run(input, new AbortController().signal);
    const worker = FakeWorker.instances[0];
    let settled = false;
    void pending.then(() => { settled = true; });
    worker.onmessage?.({ data: { id: 0, sha256: 'score-a', result } } as MessageEvent);
    worker.onmessage?.({ data: { id: 1, sha256: 'score-b', result } } as MessageEvent);
    worker.reply({ ...result, sha256: 'score-b' });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(worker.terminated).toBe(false);
    worker.reply();
    await expect(pending).resolves.toEqual(result);
  });

  it('rejects an already aborted input without constructing a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates during parsing on abort and ignores the retired worker callback', async () => {
    const controller = new AbortController();
    const pending = runner.run(input, controller.signal);
    const retired = FakeWorker.instances[0];
    const lateMessage = retired.onmessage!;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(retired.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const nextInput = { ...input, sha256: 'score-b' };
    const next = runner.run(nextInput, new AbortController().signal);
    let settled = false;
    void next.then(() => { settled = true; });
    lateMessage({ data: { id: 1, sha256: 'score-a', result } } as MessageEvent);
    await Promise.resolve();
    expect(settled).toBe(false);
    FakeWorker.instances[1].reply({ ...result, sha256: 'score-b' });
    await expect(next).resolves.toEqual({ ...result, sha256: 'score-b' });
  });

  it('disposes the active worker and prevents further runs', async () => {
    const pending = runner.run(input, new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    runner.dispose();
    await rejected;
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(runner.run(input, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('enforces an 8,000ms deadline while admission or a non-abortable import has not replied', async () => {
    const pending = runner.run(input, new AbortController().signal);
    const worker = FakeWorker.instances[0];
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ sha256: 'score-a', metadata: null, error: expect.stringMatching(/8,000|8000|8 seconds/) });
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes worker startup and posting in the same deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    FakeWorker.post = worker => {
      now = 8000;
      worker.reply();
    };
    await expect(runner.run(input, new AbortController().signal)).resolves.toEqual({
      sha256: 'score-a', metadata: null, error: expect.stringMatching(/8,000|8000|8 seconds/)
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a factual importer failure without claiming metadata', async () => {
    const pending = runner.run(input, new AbortController().signal);
    FakeWorker.instances[0].reply({ sha256: 'score-a', metadata: null, error: 'Unsupported score format.' });
    await expect(pending).resolves.toEqual({ sha256: 'score-a', metadata: null, error: 'Unsupported score format.' });
  });

  it('accepts metadata at the 4096 UTF-8 byte and 256 track boundaries', async () => {
    const pending = runner.run(input, new AbortController().signal);
    const boundary = { ...result, metadata: {
      ...result.metadata!, title: '🎸'.repeat(1024), trackNames: Array(256).fill('Guitar'), metadataTruncated: true
    } };
    FakeWorker.instances[0].reply(boundary);
    await expect(pending).resolves.toEqual(boundary);
  });

  it.each([
    ['metadata and error', { ...result, error: 'Failed' }],
    ['neither metadata nor error', { sha256: 'score-a', metadata: null, error: null }],
    ['empty error', { sha256: 'score-a', metadata: null, error: '' }],
    ['invalid metadata fields', { ...result, metadata: { ...result.metadata, trackNames: [1] } }],
    ['oversized UTF-8 metadata', { ...result, metadata: { ...result.metadata, title: '🎸'.repeat(1025) } }],
    ['too many track names', { ...result, metadata: { ...result.metadata, trackNames: Array(257).fill('Guitar') } }],
    ['oversized track name', { ...result, metadata: { ...result.metadata, trackNames: ['x'.repeat(4097)] } }],
    ['oversized error', { sha256: 'score-a', metadata: null, error: 'x'.repeat(4097) }],
    ['missing result', undefined]
  ])('reports an invalid worker response for %s', async (_name, invalid) => {
    const pending = runner.run(input, new AbortController().signal);
    const worker = FakeWorker.instances[0];
    const request = worker.requests[0];
    worker.onmessage?.({ data: { id: request.id, sha256: request.sha256, result: invalid } } as MessageEvent);
    await expect(pending).resolves.toEqual({ sha256: 'score-a', metadata: null, error: expect.stringMatching(/invalid.*response/i) });
    expect(worker.terminated).toBe(true);
  });

  it('reports worker execution errors with the available diagnostic', async () => {
    const pending = runner.run(input, new AbortController().signal);
    FakeWorker.instances[0].onerror?.({ message: 'Importer crashed', preventDefault: vi.fn() } as unknown as ErrorEvent);
    await expect(pending).resolves.toEqual({ sha256: 'score-a', metadata: null, error: expect.stringContaining('Importer crashed') });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('reports unreadable worker messages and releases the active slot', async () => {
    const pending = runner.run(input, new AbortController().signal);
    FakeWorker.instances[0].onmessageerror?.({} as MessageEvent);
    await expect(pending).resolves.toMatchObject({ metadata: null, error: expect.stringMatching(/message/i) });
    const next = runner.run(input, new AbortController().signal);
    FakeWorker.instances[1].reply();
    await expect(next).resolves.toEqual(result);
  });

  it('reports worker construction failure without leaving an active job', async () => {
    FakeWorker.constructionError = new Error('Worker unavailable');
    await expect(runner.run(input, new AbortController().signal)).resolves.toEqual({
      sha256: 'score-a', metadata: null, error: expect.stringContaining('Worker unavailable')
    });
    expect(vi.getTimerCount()).toBe(0);
    FakeWorker.constructionError = null;
    const next = runner.run(input, new AbortController().signal);
    FakeWorker.instances[0].reply();
    await expect(next).resolves.toEqual(result);
  });

  it('reports posting failure and terminates the constructed worker', async () => {
    FakeWorker.post = () => { throw new Error('Cannot clone input'); };
    await expect(runner.run(input, new AbortController().signal)).resolves.toEqual({
      sha256: 'score-a', metadata: null, error: expect.stringContaining('Cannot clone input')
    });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps unexpected worker diagnostics within the protocol error bound', async () => {
    const pending = runner.run(input, new AbortController().signal);
    FakeWorker.instances[0].onerror?.({ message: '🎸'.repeat(1025), preventDefault: vi.fn() } as unknown as ErrorEvent);
    const failure = await pending;
    expect(failure.metadata).toBeNull();
    expect(new TextEncoder().encode(failure.error!).byteLength).toBeLessThanOrEqual(4096);
    expect(failure.error).toMatch(/diagnostic.*4096/i);
  });
});

describe('metadata worker entrypoint', () => {
  let scope: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    scope = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('./metadata.worker');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('extracts real projected metadata and preserves the request ID and SHA receipt', () => {
    scope.onmessage?.({ data: { cmd: 'tabplayer.metadata.extract', id: 17, sha256: 'score-a', input: {
      ...input, edits: [{ type: 'setScoreInfo', title: 'Renamed', artist: 'Composer' }, { type: 'addTrack', name: 'Bass' }]
    } } } as MessageEvent);
    expect(scope.postMessage).toHaveBeenCalledWith({ id: 17, sha256: 'score-a', result: {
      sha256: 'score-a',
      metadata: { title: 'Renamed', artist: 'Composer', album: '', trackNames: ['Guitar', 'Bass'], metadataTruncated: false },
      error: null
    } });
  });

  it('returns an explicit metadata-unavailable result for rejected score input', () => {
    scope.onmessage?.({ data: { cmd: 'tabplayer.metadata.extract', id: 18, sha256: 'score-a', input: {
      ...input, base: { kind: 'file', bytesBase64: 'aW52YWxpZA==' }
    } } } as MessageEvent);
    expect(scope.postMessage).toHaveBeenCalledWith({ id: 18, sha256: 'score-a', result: {
      sha256: 'score-a', metadata: null, error: expect.any(String)
    } });
  });

  it('rejects a request whose input SHA differs from the worker receipt', () => {
    scope.onmessage?.({ data: { cmd: 'tabplayer.metadata.extract', id: 19, sha256: 'score-b', input } } as MessageEvent);
    expect(scope.postMessage).toHaveBeenCalledWith({ id: 19, sha256: 'score-b', result: {
      sha256: 'score-b', metadata: null, error: expect.stringMatching(/invalid.*request/i)
    } });
  });

  it('ignores malformed requests without a safe request ID and SHA receipt', () => {
    expect(() => scope.onmessage?.({ data: null } as MessageEvent)).not.toThrow();
    scope.onmessage?.({ data: { cmd: 'tabplayer.metadata.extract', id: Number.NaN, sha256: 'score-a', input } } as MessageEvent);
    expect(scope.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { id: 20, sha256: 'score-a', input }],
    ['unrelated', { cmd: 'alphaSynth.exporter.export', id: 20, sha256: 'score-a', input }],
    ['non-string', { cmd: 17, id: 20, sha256: 'score-a', input }]
  ])('ignores %s commands even when the extraction receipt is otherwise valid', (_name, request) => {
    expect(() => scope.onmessage?.({ data: request } as MessageEvent)).not.toThrow();
    expect(scope.postMessage).not.toHaveBeenCalled();
  });
});
