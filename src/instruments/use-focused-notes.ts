import { useMemo, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import type { PlanNote } from '../audio/types';
import { trackIdentity } from '../engine';
import type { BeatTarget } from '../project';
import { focusNotes, heldNotes, type HeldNote, type InstrumentFocus } from './focus';

export type FocusPlayer = Pick<NativePlaybackController, 'subscribe' | 'getState' | 'activeNotes'> & Partial<Pick<NativePlaybackController, 'scheduledNotes'>>;
const noSubscribe = () => () => {};
const noState = () => null;
type ScheduledNotes = NonNullable<ReturnType<NonNullable<FocusPlayer['scheduledNotes']>>>;

/**
 * The notes an instrument view shows for the chosen focus, with the held (tied) ones, followed live from the player. The
 * on-screen view and the Fretlight LEDs both read them here, so the LEDs do not depend on the view being visible.
 */
export function useFocusedNotes({ score, track, target, player, focus }: { score: model.Score; track: number; target: BeatTarget | null; player: FocusPlayer | null; focus: InstrumentFocus }): {
  state: ReturnType<FocusPlayer['getState']> | null; notes: readonly PlanNote[]; held: HeldNote[]; scheduled: ScheduledNotes | null;
} {
  const state = useSyncExternalStore(player?.subscribe ?? noSubscribe, player?.getState ?? noState);
  const id = trackIdentity(score.tracks[track]), active = player?.activeNotes(id) ?? [];
  const scheduled = focus === 'playing' ? null : player?.scheduledNotes?.(id) ?? null;
  // Only the next beat moves with playback; the selected beat and bar depend on the plan and the selection alone.
  const tick = focus === 'next' ? scheduled?.tick ?? null : null, { notes: planned, beats, counting, loop, range } = scheduled ?? {};
  const picked = useMemo(() => planned && beats ? focusNotes(focus, { notes: planned, beats, tick, counting: !!counting, loop: loop ?? null, range: range ?? null, active: [], target }) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focus, planned, beats, tick, counting, loop?.startTick, loop?.endTick, range?.endTick, target?.track, target?.staff, target?.bar, target?.voice, target?.beat]);
  // A tie that only continues an earlier note has no planned note, so it is read from the score for the selected beat or bar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const held = useMemo(() => heldNotes(score, focus, target), [score, focus, target?.track, target?.staff, target?.bar, target?.voice, target?.beat]);
  return { state, notes: focus === 'playing' ? active : picked, held, scheduled };
}
