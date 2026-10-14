import { useEffect, useRef } from 'react';
import { AlphaTabApi, type model, StaveProfile } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import { PlaybackController } from './playback';

export function ScoreView({score,track,zoom,profile,onSelect,onPlayback}: {
  score:model.Score;track:number;zoom:number;profile:string;onSelect:(target:BeatTarget,string?:number)=>void;
  onPlayback:(player:PlaybackController|null)=>void;
}) {
  const container=useRef<HTMLDivElement>(null);const api=useRef<AlphaTabApi|null>(null);
  const selection=useRef(onSelect);selection.current=onSelect;
  const ready=useRef(onPlayback);ready.current=onPlayback;const player=useRef<PlaybackController|null>(null);
  useEffect(()=>{
    const view=new AlphaTabApi(container.current!,{core:{fontDirectory:'/font/',scriptFile:'/alphatab/alphaTab.mjs',includeNoteBounds:true,useWorkers:false},player:{playerMode:'EnabledSynthesizer',soundFont:'/soundfont/sonivox.sf2',enableCursor:true,scrollElement:'.paper-scroll'}});api.current=view;
    player.current=new PlaybackController(view);ready.current(player.current);
    const beat=(b:model.Beat,s?:number)=>selection.current({track:b.voice.bar.staff.track.index,staff:b.voice.bar.staff.index,bar:b.voice.bar.index,voice:b.voice.index,beat:b.index},s);
    view.beatMouseDown.on(b=>beat(b));view.noteMouseDown.on(n=>beat(n.beat,n.string));
    return ()=>{player.current?.destroy();view.destroy();api.current=null;ready.current(null);};
  },[]);
  useEffect(()=>{const view=api.current!;view.settings.display.scale=zoom/100;
    view.settings.display.staveProfile=StaveProfile[profile as keyof typeof StaveProfile] as StaveProfile;
    view.updateSettings();player.current!.replaceScore(score,track);
  },[score,track,zoom,profile]);
  return <div ref={container} aria-label="Music notation"/>;
}
