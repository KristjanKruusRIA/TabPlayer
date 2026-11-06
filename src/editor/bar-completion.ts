import type { model } from '@coderline/alphatab';

/** Whether a bar's voices fill its time signature, as the song-position display marks it. */
export type BarCompletion = { kind:'complete' } | { kind:'empty' } | { kind:'short'|'long'; voice:number };

/** Checks every voice that holds beats in one staff bar against the bar's length; grace notes take no time. */
export function barCompletion(score:model.Score, track:number, staff:number, bar:number):BarCompletion {
  const master=score.masterBars[bar],staffBar=score.tracks[track]?.staves[staff]?.bars[bar];
  if(!master||!staffBar)return {kind:'empty'};
  const length=master.calculateDuration(false);
  let filled=false;
  for(const [index,voice] of staffBar.voices.entries()){
    const beats=voice.beats.filter(beat=>!beat.isEmpty);
    if(!beats.length)continue;
    filled=true;
    const used=beats.reduce((total,beat)=>total+(beat.graceType!==0?0:beat.playbackDuration),0);
    if(used<length)return {kind:'short',voice:index+1};
    if(used>length)return {kind:'long',voice:index+1};
  }
  return filled?{kind:'complete'}:{kind:'empty'};
}
