import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { MusicSelection } from './range-types';
import type { BarIndexMap } from './measures-types';
import type { HarmonyChord } from './harmony-types';

export type ClipboardMode='singleTrack'|'multiTrack';
export interface ClipboardLink {from:number;to:number;kind:'tie'|'slur'|'slide'|'hammerPull';slideOutType:number|null}
export interface ClipboardHarmony {track:number;staff:number;chordId:string;chord:HarmonyChord}
interface MusicClipBase {
  format:'TabPlayerClip';engineVersion:'1.8.4';mode:ClipboardMode;kind:'phrase'|'bars';scoreJson:string;links:ClipboardLink[];
}
export type MusicClip=MusicClipBase&({version:1}|{version:2;harmony:ClipboardHarmony[]});
export interface PasteFilters {diagrams:boolean;texts:boolean;timers:boolean;trackAutomations:boolean;masterAutomations:boolean;sections:boolean}
export interface PasteDestination {sourceTrack:number;track:number;staffMap:number[]}
export interface PasteOptions {target:BeatTarget;destinations:PasteDestination[];count:number;placement:'currentBar'|'beforeBar';filters:PasteFilters}
export type ClipboardCommand={type:'pasteMusic';clip:MusicClip;options:PasteOptions};
export interface PreparedMusicPaste {score:model.Score;barMap:BarIndexMap}
export interface ClipboardPanelProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;clip:MusicClip|null;busy:boolean;
  /** The document is finalized: copying still works, cutting and pasting do not. */
  locked?:boolean;
  /** Whether a paste starts with chord and scale diagrams included (the input preference). */
  diagramsDefault?:boolean;
  onCopy:(mode:ClipboardMode)=>void;onCut:(mode:ClipboardMode)=>void;onPaste:(options:PasteOptions)=>void;
}
