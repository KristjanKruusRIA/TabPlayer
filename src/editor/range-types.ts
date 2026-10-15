import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { IndexedNoteTarget } from '../edit-types';

export interface VoiceAddress {track:number;staff:number;voice:number}
export interface MusicPoint {bar:number;tick:number}
export interface BeatRange {start:MusicPoint;end:MusicPoint;lanes:VoiceAddress[]}
export type MusicSelection =
  | {kind:'range';range:BeatRange}
  | {kind:'notes';notes:IndexedNoteTarget[]}
  | {kind:'bars';tracks:number[];firstBar:number;lastBar:number};
export type RangeCommand =
  | {type:'eraseSelection';selection:MusicSelection}
  | {type:'transposeSelection';selection:MusicSelection;semitones:number}
  | {type:'moveSelectionStrings';selection:MusicSelection;direction:'higher'|'lower'}
  | {type:'refingerSelection';selection:MusicSelection;maxFret:number}
  | {type:'setSelectionSustain';selection:MusicSelection;strings:number[];kind:'letRing'|'palmMute';enabled:boolean};
export interface FingeringRequest {note:model.Note;pitch:number;preferredString:number|null;fixedString:number|null}
export interface FingeringPlacement {note:model.Note;string:number;fret:number}
export interface RangePanelProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;busy:boolean;
  onSelection:(selection:MusicSelection|null)=>void;
  onEdit:(command:RangeCommand)=>void;
}
