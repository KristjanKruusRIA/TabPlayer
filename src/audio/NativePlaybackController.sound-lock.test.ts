import { afterEach, expect, it, vi } from 'vitest';
import * as engine from '../engine';
import { blankProject } from '../project';
import type { EditCommand } from '../edit-types';
import type { NativeAudioBridge } from './bridge';
import { NativePlaybackController } from './NativePlaybackController';
import { buildPlaybackPlan, buildPlaybackPlanFromJson } from './plan';
import { soundPreset } from './sound-model';

function bridge(): NativeAudioBridge { return { prepare: vi.fn(async () => {}), command: vi.fn(async () => {}), setMix: vi.fn(async () => {}), devices: vi.fn(async () => []), status: vi.fn(async () => null), subscribe: vi.fn(async () => () => {}), stageBacking: vi.fn(async () => null), stageEmbeddedBacking: vi.fn(async () => null) }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// A settings edit keeps the score, as the app's replay does, so only the settings decide what is prepared again.
const apply = (project: ReturnType<typeof blankProject>, built: ReturnType<typeof engine.buildDocument>, edit: EditCommand) => { const next = engine.previewEdit(project, edit, built).project; return { project: next, built: engine.replayDocumentSettings(next, built) }; };

it('prepares the plan again when a track is locked or unlocked, naming the locked tracks, and not for a mix change', async () => {
  const prepare = vi.fn(async (_project: unknown, generation: number, _interpretations?: unknown, _locked?: readonly string[]) => buildPlaybackPlan(engine.buildDocument(blankProject()).score, generation));
  const native = bridge(), player = new NativePlaybackController({ bridge: native, onEdit: vi.fn(), preparePlan: prepare as never });
  try {
    let project = blankProject(), built = engine.buildDocument(project);
    await player.loadDocument(project, built);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]).toHaveLength(2);
    const sound = soundPreset('lead', 'green-guitar');
    let step = apply(project, built, { type: 'setTrackSound', trackId: 'base/0', sound });
    await player.loadDocument(step.project, step.built);
    // An unlocked sound change is a mix change: the plan stays.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(native.setMix).toHaveBeenCalledTimes(1);
    project = step.project; built = step.built;
    step = apply(project, built, { type: 'setTrackSound', trackId: 'base/0', sound: { ...sound, locked: true } });
    await player.loadDocument(step.project, step.built);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][2]).toBeUndefined();
    expect(prepare.mock.calls[1][3]).toEqual(['base/0']);
    expect(native.prepare).toHaveBeenCalledTimes(2);
    project = step.project; built = step.built;
    // While locked, a mix change leaves the plan alone.
    step = apply(project, built, { type: 'setTrackMix', trackId: 'base/0', mix: { gain: 0.5, pan: 0, mute: false, solo: false } });
    await player.loadDocument(step.project, step.built);
    expect(prepare).toHaveBeenCalledTimes(2);
    project = step.project; built = step.built;
    // Unlocking (what undo does) prepares it again, without a lock.
    step = apply(project, built, { type: 'setTrackSound', trackId: 'base/0', sound });
    await player.loadDocument(step.project, step.built);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls[2]).toHaveLength(2);
  } finally { player.destroy(); }
});

it('sends the locked tracks to the plan worker', async () => {
  const requests: { locked?: string[] }[] = [];
  class WorkerFixture { onmessage: ((event: MessageEvent) => void) | null = null; onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(data: { json: never; identities: string[]; generation: number; locked?: string[] }) { requests.push(data); queueMicrotask(() => this.onmessage?.({ data: { cmd: 'tabplayer.plan.result', plan: buildPlaybackPlanFromJson(data.json, data.identities, data.generation, undefined, data.locked) } } as MessageEvent)); }
    terminate() {} }
  vi.stubGlobal('Worker', WorkerFixture);
  const player = new NativePlaybackController({ bridge: bridge(), onEdit: vi.fn() });
  try {
    const first = blankProject(), step = apply(first, engine.buildDocument(first), { type: 'setTrackSound', trackId: 'base/0', sound: { ...soundPreset('lead', 'green-guitar'), locked: true } });
    await player.loadDocument(step.project, step.built);
    expect(requests).toHaveLength(1);
    expect(requests[0].locked).toEqual(['base/0']);
  } finally { player.destroy(); }
});
