import { useEffect, useRef } from 'react';
import { AlphaTabApi, type model, StaveProfile } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';

export function ScoreView({score,track,zoom,profile,onSelect,playback}: {
  score:model.Score;track:number;zoom:number;profile:string;onSelect:(target:BeatTarget,string?:number)=>void;
  playback:NativePlaybackController|null;
}) {
  const container=useRef<HTMLDivElement>(null);const api=useRef<AlphaTabApi|null>(null);
  const selection=useRef(onSelect);selection.current=onSelect;
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs',includeNoteBounds:true,useWorkers:false},player:{playerMode:'EnabledExternalMedia',enableCursor:true,scrollElement:'.paper-scroll'}});api.current=view;
    const beat=(b:model.Beat,s?:number)=>selection.current({track:b.voice.bar.staff.track.index,staff:b.voice.bar.staff.index,bar:b.voice.bar.index,voice:b.voice.index,beat:b.index},s);
    view.beatMouseDown.on(b=>beat(b));view.noteMouseDown.on(n=>beat(n.beat,n.string));
    return ()=>{view.destroy();api.current=null;};
  },[]);
  useEffect(()=>{if(playback&&api.current)playback.attachView(api.current);},[playback]);
  useEffect(()=>{const view=api.current!;view.settings.display.scale=zoom/100;
    view.settings.display.staveProfile=StaveProfile[profile as keyof typeof StaveProfile] as StaveProfile;
    view.updateSettings();playback?.replaceScore(score,track);
  },[track,zoom,profile,playback]);
  return <div ref={container} aria-label="Music notation"/>;
}
