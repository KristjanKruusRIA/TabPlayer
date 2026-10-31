import type { model } from '@coderline/alphatab';
import type { TrackLyrics } from './lyrics-types';

export interface LyricsSource {value:TrackLyrics;managed:boolean}
const sources=new WeakMap<model.Track,LyricsSource>();
const cloneTrackLyrics=(value:TrackLyrics):TrackLyrics=>({visible:value.visible,lines:value.lines.map(line=>({...line}))});

/** Raw source is separate from the renderer's distributed syllables. */
export function getLyricsSource(track:model.Track):LyricsSource|undefined {
  const source=sources.get(track);return source?{value:cloneTrackLyrics(source.value),managed:source.managed}:undefined;
}
export function setLyricsSource(track:model.Track,value:TrackLyrics,managed:boolean):void {
  sources.set(track,{value:cloneTrackLyrics(value),managed});
}
/** Call immediately after a full clone, before deleting or reordering tracks. */
export function copyLyricsSources(source:model.Score,destination:model.Score):void {
  destination.tracks.forEach((track,index)=>{
    const original=source.tracks[index],entry=original?sources.get(original):undefined;
    if(entry)setLyricsSource(track,entry.value,entry.managed);else sources.delete(track);
  });
}
