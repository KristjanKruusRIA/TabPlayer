import { model } from '@coderline/alphatab';
import { detachedCopy,splitRangeEdges } from './clipboard-subdivide';
import { rhythmTicks } from './common';
import { trimStart,type ScoreError } from './score-errors';

/**
 * Index of the plain beat that crosses the barline, when Trim to fit may try to shorten it; otherwise -1.
 * The rule is deliberately narrow. Shortening is declined, and the edit falls back to the old removal of the crossing beat,
 * when ANY beat up to the crossing one is a grace note, a tuplet beat, an empty beat, a full-bar rest or has a display length
 * override, and when the crossing beat is not the one `trimStart` would remove. It is also declined, in `shortenCrossingBeat`,
 * when the cut itself refuses the beat (bend, trill, dead note, whammy bar, override, more than four written pieces).
 */
export function crossingBeat(voice:model.Voice,expected:number):number {
  let start=0,crossing=-1;
  for(const [index,beat] of voice.beats.entries()){
    if(beat.isEmpty||beat.graceType!==model.GraceType.None||beat.isFullBarRest||beat.overrideDisplayDuration!==undefined||(beat.tupletNumerator>0&&beat.tupletDenominator>0)){if(start>=expected)break;return -1;}
    const length=rhythmTicks(beat,expected);
    if(start<expected&&start+length>expected){crossing=index;break;}
    start+=length;
  }
  return crossing>=0&&crossing===trimStart(voice,expected)?crossing:-1;
}

/**
 * Cuts the crossing beat at the barline into tied pieces of exact written length, in place, and returns whether it did.
 * The pieces before the barline stay; the ones after it go with the later beats when the caller removes from `trimStart`.
 * Returns false and leaves the voice untouched when shortening is declined (see `crossingBeat`).
 * This is the one decision both the edit and the Trim hint use. A recorded edit with `shorten:true` replays through the
 * clipboard Cut rules (`splitRangeEdges`), so a later change to what Cut can split also changes how such an edit replays.
 */
export function shortenCrossingBeat(master:model.MasterBar,voice:model.Voice,expected:number):boolean {
  if(crossingBeat(voice,expected)<0)return false;
  const track=voice.bar.staff.track;
  try {
    splitRangeEdges(track.score,{start:{bar:master.index,tick:expected},end:{bar:master.index,tick:expected},lanes:[{track:track.index,staff:voice.bar.staff.index,voice:voice.index}]},false);
    return true;
  } catch { return false; /* The beat cannot be cut exactly, so it is removed as before. */ }
}

/**
 * Adds what Trim to fit will really do to the overfull errors: the notes it shortens, and the removal counted after them.
 * The decision is tried on one detached copy of the score, made only when some voice qualifies, with the function the edit uses.
 */
export function withShortening(score:model.Score,errors:readonly ScoreError[]):ScoreError[] {
  let work:model.Score|undefined;
  return errors.map(error=>{
    if(error.kind!=='overfull')return error;
    const master=score.masterBars[error.bar],voice=score.tracks[error.track]?.staves[error.staff]?.bars[error.bar]?.voices[error.voice];
    if(!master||!voice)return error;
    const expected=master.calculateDuration(false),crossing=crossingBeat(voice,expected);
    if(crossing<0)return error;
    work??=detachedCopy(score);
    const copy=work.tracks[error.track].staves[error.staff].bars[error.bar].voices[error.voice];
    if(!shortenCrossingBeat(work.masterBars[error.bar],copy,expected))return error;
    const notes=voice.beats[crossing].notes.length,after=voice.beats.slice(crossing+1),removedNotes=after.reduce((count,value)=>count+value.notes.length,0);
    const {trim:_old,...rest}=error;
    return {...rest,...(notes?{shortened:notes}:{}),...(after.length?{trim:{beats:after.length,notes:removedNotes}}:{})};
  });
}
