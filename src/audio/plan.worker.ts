import type { model } from '@coderline/alphatab';
import type { TrackInterpretation } from '../edit-types';
import { buildPlaybackPlanFromJson } from './plan';

const worker = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (data: unknown) => void };
worker.onmessage = event => {
  const { cmd, json, identities, generation, interpretations, locked } = event.data as { cmd?: string; json: ReturnType<typeof model.JsonConverter.scoreToJson>; identities: string[]; generation: number; interpretations?: Record<string, TrackInterpretation>; locked?: string[] };
  if (cmd !== 'tabplayer.plan.prepare') return;
  try {
    worker.postMessage({ cmd: 'tabplayer.plan.result', plan: buildPlaybackPlanFromJson(json, identities, generation, interpretations, locked) });
  } catch (error) { worker.postMessage({ cmd: 'tabplayer.plan.result', error: error instanceof Error ? error.message : String(error) }); }
};
