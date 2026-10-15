import { extractMetadata } from './metadata';
import type { MetadataWorkerRequest, MetadataWorkerResponse } from './metadata-runner';
import type { MetadataResult } from './types';

self.onmessage = (event: MessageEvent<MetadataWorkerRequest>) => {
  const request = event.data;
  if (!request || request.cmd !== 'tabplayer.metadata.extract') return;
  if (!Number.isSafeInteger(request.id) || request.id < 1 || typeof request.sha256 !== 'string') return;
  const { id, sha256, input } = request;
  let result: MetadataResult;
  try {
    if (!input || input.sha256 !== sha256) throw new Error('Invalid metadata worker request.');
    result = extractMetadata(input);
  } catch (error) {
    result = { sha256, metadata: null, error: error instanceof Error ? error.message : 'Metadata extraction failed.' };
  }
  self.postMessage({ id, sha256, result } satisfies MetadataWorkerResponse);
};
