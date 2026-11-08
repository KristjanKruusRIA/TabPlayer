import {useMemo} from 'react';
import type {NativePlaybackController} from './NativePlaybackController';
import type {PlaybackState} from './types';
import {loopPassage,type LoopPassage} from './loop-passage';

/**
 * The bars the running loop covers, rebuilt only when the loop's ticks or the plan's occurrences change, so playback ticks (which hand over a new loop object each time) leave it, and everything drawn from it, alone.
 * The occurrences are part of the key because the controller reports none while it prepares a rebuilt plan, and the same loop on the same generation must be placed again once they arrive. While it is ready the array is the plan's own, so it is a stable key; while not, it is a fresh empty array and the memo only repeats a cheap null.
 */
export function useLoopPassage(player:Pick<NativePlaybackController,'playbackOccurrences'>|null,state:Pick<PlaybackState,'loop'>|null):LoopPassage|null {
  const loop=state?.loop??null,occurrences=player?.playbackOccurrences();
  return useMemo(()=>loop&&occurrences?loopPassage(loop,occurrences):null,
    // The loop object is new on every native status; its ticks are what count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loop?.startTick,loop?.endTick,occurrences]);
}
