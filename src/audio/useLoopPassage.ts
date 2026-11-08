import {useMemo} from 'react';
import type {NativePlaybackController} from './NativePlaybackController';
import type {PlaybackState} from './types';
import {loopPassage,type LoopPassage} from './loop-passage';

/** The bars the running loop covers, rebuilt only when the loop or the plan changes, so playback ticks (which hand over a new loop object each time) leave it, and everything drawn from it, alone. */
export function useLoopPassage(player:Pick<NativePlaybackController,'playbackOccurrences'|'generation'>|null,state:Pick<PlaybackState,'loop'|'ready'>|null):LoopPassage|null {
  const loop=state?.loop??null,ready=!!state?.ready;
  const key=loop?`${loop.startTick}:${loop.endTick}:${ready}:${player?.generation}`:'';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(()=>player&&loop&&ready?loopPassage(loop,player.playbackOccurrences()):null,[key,player]);
}
