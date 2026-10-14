import { useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { trackIdentity } from '../engine';
import { InstrumentView } from './InstrumentView';

const noSubscribe=()=>()=>{};
const noState=()=>null;
export function LiveInstrumentView({score,track,staff,player}: {
  score:model.Score;track:number;staff:number;
  player:Pick<NativePlaybackController,'subscribe'|'getState'|'activeNotes'>|null;
}) {
  useSyncExternalStore(player?.subscribe??noSubscribe,player?.getState??noState);
  const notes=player?.activeNotes(trackIdentity(score.tracks[track]))??[];
  return <section className="live-instrument-view" aria-label="Instrument view">
    <InstrumentView score={score} track={track} staff={staff} notes={notes}/>
  </section>;
}
