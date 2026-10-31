import type { model } from '@coderline/alphatab';

export interface LyricLine {startBar:number;text:string}
export type TrackLyrics={visible:boolean;lines:LyricLine[]};
export type LyricsCommand={type:'setTrackLyrics';track:number;visible:boolean;lines:LyricLine[]};
export type LyricsDraft=TrackLyrics&{source:'raw'|'distributed'};
export interface LyricsPanelProps {score:model.Score;track:number;busy:boolean;onEdit:(command:LyricsCommand)=>void}
