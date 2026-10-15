import type { MetadataInput, MetadataResult } from './types';

export interface MetadataRunner {
  run(input: MetadataInput, signal: AbortSignal): Promise<MetadataResult>;
  dispose(): void;
}

export interface MetadataWorkerRequest { id: number; sha256: string; input: MetadataInput }
export interface MetadataWorkerResponse { id: number; sha256: string; result: MetadataResult }

const encoder = new TextEncoder();
const boundedText = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 4096 && encoder.encode(value).byteLength <= 4096;

function validResult(value: unknown): value is MetadataResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (typeof result.sha256 !== 'string') return false;
  if (result.metadata === null) return boundedText(result.error) && result.error.trim().length > 0;
  if (result.error !== null || !result.metadata || typeof result.metadata !== 'object') return false;
  const metadata = result.metadata as Record<string, unknown>;
  return boundedText(metadata.title) && boundedText(metadata.artist)
    && boundedText(metadata.album) && typeof metadata.metadataTruncated === 'boolean'
    && Array.isArray(metadata.trackNames) && metadata.trackNames.length <= 256 && metadata.trackNames.every(boundedText);
}

export function createMetadataRunner(): MetadataRunner {
  let nextId = 0;
  let disposed = false;
  let active: { cancel(): void } | null = null;
  const abortError = () => new DOMException('Metadata extraction was cancelled.', 'AbortError');

  return {
    run(input, signal) {
      const deadline = performance.now() + 8000;
      if (disposed || signal.aborted) return Promise.reject(abortError());
      if (active) return Promise.reject(new Error('Metadata extraction is already running.'));
      const id = ++nextId;
      const sha256 = input.sha256;

      return new Promise<MetadataResult>((resolve, reject) => {
        let worker: Worker | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;

        const cleanup = () => {
          if (finished) return false;
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
          }
          active = null;
          return true;
        };
        const complete = (result: MetadataResult) => { if (cleanup()) resolve(result); };
        const unavailable = (error: string) => complete({ sha256, metadata: null,
          error: boundedText(error) ? error : 'Metadata worker failed; its diagnostic exceeded 4096 UTF-8 bytes.' });
        const timedOut = () => unavailable('Metadata extraction exceeded the 8,000 ms deadline.');
        const cancel = () => { if (cleanup()) reject(abortError()); };
        active = { cancel };
        timer = setTimeout(timedOut, 8000);
        signal.addEventListener('abort', cancel, { once: true });

        try {
          worker = new Worker(new URL('./metadata.worker.ts', import.meta.url), { type: 'module' });
          if (performance.now() >= deadline) { timedOut(); return; }
          worker.onmessage = event => {
            if (finished) return;
            const response = event.data as Partial<MetadataWorkerResponse> | null;
            if (!response || response.id !== id || response.sha256 !== sha256) return;
            if (response.result && typeof response.result.sha256 === 'string' && response.result.sha256 !== sha256) return;
            if (performance.now() >= deadline) { timedOut(); return; }
            if (!validResult(response.result)) { unavailable('Metadata worker returned an invalid response.'); return; }
            complete(response.result);
          };
          worker.onerror = event => {
            event.preventDefault();
            unavailable(event.message ? `Metadata worker failed: ${event.message}` : 'Metadata worker failed.');
          };
          worker.onmessageerror = () => unavailable('Metadata worker message could not be read.');
          worker.postMessage({ id, sha256, input } satisfies MetadataWorkerRequest);
          if (!finished && performance.now() >= deadline) timedOut();
        } catch (error) {
          unavailable(error instanceof Error ? `Metadata worker failed: ${error.message}` : 'Metadata worker could not be started.');
        }
      });
    },
    dispose() {
      disposed = true;
      active?.cancel();
    }
  };
}
