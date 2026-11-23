import { invoke } from '@tauri-apps/api/core';
import type { MessageKey } from '../i18n';

export interface DiAnalysisSummary {
  analysisId: string;
  fileName: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  estimatedBpm: number;
  estimatedOffsetSec: number;
}

export interface DiDecodeParams {
  onsetThreshold: number;
  frameThreshold: number;
  minNoteMs: number;
  minPitch: number;
  maxPitch: number;
  suppressOvertones: boolean;
  openTuning?: number[];
}

export interface TranscribedDiNote {
  startSec: number;
  endSec: number;
  pitch: number;
  onsetConfidence: number;
  frameConfidence: number;
  velocity: number;
  palmMuteScore: number;
  bendSemitones: number;
}

export interface DiCustomModelInfo {
  fileName: string;
  path: string;
}

export interface DiModelSwitchResult {
  model: DiCustomModelInfo | null;
  analysis: DiAnalysisSummary | null;
}

export interface DiTranscriber {
  pickAndAnalyze: () => Promise<DiAnalysisSummary | null>;
  decode: (analysisId: string, params: DiDecodeParams) => Promise<TranscribedDiNote[]>;
  clear: () => Promise<void>;
  getModel?: () => Promise<DiCustomModelInfo | null>;
  pickModel?: () => Promise<DiModelSwitchResult | null>;
  clearModel?: () => Promise<DiModelSwitchResult>;
}

/** Native Tauri IPC bridge for local offline DI guitar transcription. */
export const diTranscribe: DiTranscriber = {
  pickAndAnalyze: () => invoke<DiAnalysisSummary | null>('di_transcribe_pick_and_analyze'),
  decode: (analysisId, params) => invoke<TranscribedDiNote[]>('di_transcribe_decode', { analysisId, params }),
  clear: () => invoke<void>('di_transcribe_clear'),
  getModel: () => invoke<DiCustomModelInfo | null>('di_transcribe_get_model'),
  pickModel: () => invoke<DiModelSwitchResult | null>('di_transcribe_pick_model'),
  clearModel: () => invoke<DiModelSwitchResult>('di_transcribe_clear_model'),
};

const problemKeys: Record<string, MessageKey> = {
  too_large: 'di_import.error_too_large',
  too_long: 'di_import.error_too_long',
  decode_failed: 'di_import.error_decode_failed',
  model_failed: 'di_import.error_model_failed',
  invalid_model: 'di_import.error_invalid_model',
  model_too_large: 'di_import.error_model_too_large',
  stale_analysis: 'di_import.error_stale',
  unreadable: 'di_import.error_unreadable',
};

/** Maps a native rejection (`code` or `code: detail`) to a localized `di_import.*` message key and detail text. */
export function diProblem(reason: unknown): { key: MessageKey; detail: string } {
  const text = reason instanceof Error ? reason.message : String(reason);
  const colon = text.indexOf(':');
  const code = (colon < 0 ? text : text.slice(0, colon)).trim();
  const detail = colon < 0 ? '' : text.slice(colon + 1).trim();
  const key = problemKeys[code];
  return key ? { key, detail } : { key: 'di_import.error_unknown', detail: text };
}
