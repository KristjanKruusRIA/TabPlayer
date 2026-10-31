import { expect, it, vi } from 'vitest';
import { buildDocument, previewEdit, replayDocumentSettings } from '../engine';
import { blankProject } from '../project';
import type { EditCommand } from '../edit-types';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge, NativeAudioStatus } from './bridge';
import { buildPlaybackPlan } from './plan';
import { DEFAULT_PRACTICE, type PracticeStatus } from './practice-types';
import { soundPreset } from './sound-model';

function status(player: NativePlaybackController, change: Partial<NativeAudioStatus>): NativeAudioStatus {
  const settings = structuredClone(DEFAULT_PRACTICE);
  const practice: PracticeStatus = { settings, phase: 'playing', countInRemaining: 0, completedPasses: 0, effectiveRatio: 1, currentBpm: 120, pulse: null };
  return { generation: player.generation, ready: true, playing: true, tick: 480, seconds: 0.25, durationSeconds: 8, speed: 1, metronome: false, error: null, deviceId: null, range: null, loop: { startTick: 0, endTick: 3840 }, practice, ...change };
}

it('keeps playing, the position and the loop through a lock, and through its undo', async () => {
  let receive: (value: NativeAudioStatus) => void = () => {};
  const bridge: NativeAudioBridge = { prepare: vi.fn(async () => {}), command: vi.fn(async () => {}), setMix: vi.fn(async () => {}), devices: vi.fn(async () => []), status: vi.fn(async () => null), subscribe: vi.fn(async listener => { receive = listener; return () => {}; }), stageBacking: vi.fn(async () => null), stageEmbeddedBacking: vi.fn(async () => null) };
  const prepare = vi.fn(async (_project: unknown, generation: number) => buildPlaybackPlan(buildDocument(blankProject()).score, generation));
  const player = new NativePlaybackController({ bridge, onEdit: vi.fn(), preparePlan: prepare as never });
  try {
    let project = blankProject(), built = buildDocument(project);
    await player.loadDocument(project, built);
    const generation = player.generation;
    (bridge.command as ReturnType<typeof vi.fn>).mockClear();
    receive(status(player, {}));
    const before = player.getState();
    expect(before).toMatchObject({ playing: true, loop: { startTick: 0, endTick: 3840 } });
    const apply = (edit: EditCommand) => { project = previewEdit(project, edit, built).project; built = replayDocumentSettings(project, built); return player.loadDocument(project, built); };
    const sound = soundPreset('lead', 'green-guitar');
    for (const [edit, locked] of [[{ type: 'setTrackSound', trackId: 'base/0', sound: { ...sound, locked: true } }, true], [{ type: 'setTrackSound', trackId: 'base/0', sound }, false]] as const) {
      await apply(edit);
      // The same plan, the same generation, no invalidation: the lock reaches the player as a mix change.
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(bridge.prepare).toHaveBeenCalledTimes(1);
      expect(player.generation).toBe(generation);
      expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate' }));
      expect(bridge.setMix).toHaveBeenLastCalledWith(expect.objectContaining({ sounds: { 'base/0': expect.objectContaining(locked ? { locked: true } : {}) } }), generation);
      expect(!!(bridge.setMix as ReturnType<typeof vi.fn>).mock.lastCall![0].sounds['base/0'].locked).toBe(locked);
      expect(player.getState()).toMatchObject({ ready: true, playing: true, time: before.time, loop: { startTick: 0, endTick: 3840 }, error: null });
    }
    expect(bridge.setMix).toHaveBeenCalledTimes(2);
  } finally { player.destroy(); }
});
