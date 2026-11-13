import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { EditCommand, IndexedNoteTarget } from '../edit-types';
import type { EntryFollow } from '../instruments/entry';
import type { MusicSelection } from './range-types';
import type { ScaleDiagramCommand } from '../harmony/scale-diagram';

export interface SpelledPitchClass {step:number;alteration:number}
export type ChordDegree=1|2|3|4|5|6|7|9|11|13;
export type ChordFormulaId='major'|'minor'|'dim'|'aug'|'sus2'|'sus4'|'power'|'6'|'m6'|'7'|'maj7'|'m7'|'mMaj7'|'m7b5'|'dim7'|'9'|'maj9'|'m9'|'11'|'m11'|'13'|'7sus4';
export interface ChordRecipe {
  root:SpelledPitchClass;formula:ChordFormulaId;
  alterations:Array<{degree:5|9|11|13;shift:-1|1}>;
  omissions:ChordDegree[];bass:SpelledPitchClass|null;
}
export interface HarmonyChord {
  name:string;nameMode:'manual'|'theory';recipe:ChordRecipe|null;
  firstFret:number;frets:number[];fingers:number[];barreFrets:number[];
  showName:boolean;showDiagram:boolean;showFingering:boolean;
}
export type HarmonyInterval=
  |{kind:'semitones';semitones:number}
  |{kind:'chromatic';number:number;quality:'perfect'|'major'|'minor'|'augmented'|'diminished';direction:'up'|'down';octaves:number}
  |{kind:'diatonic';steps:number};
export type HarmonyCommand=
  |{type:'setBeatText';target:BeatTarget;text:string}
  |{type:'setHarmonyChord';target:BeatTarget;chord:HarmonyChord|null;fillEmptyBeat:boolean}
  |{type:'transposeHarmony';selection:MusicSelection;interval:HarmonyInterval;includeKeySignatures:boolean;includeChords:boolean};
export interface PitchTarget {address:IndexedNoteTarget;pitch:number}
export interface ChordShapeSearch {maxFret:number;maxSpan:number;limit:number}
export interface ChordMatch {recipe:ChordRecipe;name:string;bass:number;pitchClasses:number[]}
export interface ScalePattern {id:string;name:string;intervals:number[];tags:string[]}
export interface ScaleMatch {patternId:string;root:number;matched:number;total:number;extra:number}
export interface HarmonyLibraryEntry {id:string;label:string;chord:HarmonyChord;tuning:number[];capo:number;transposition:number}
export interface HarmonyLibrary {format:'TabPlayerHarmonyLibrary';version:1;entries:HarmonyLibraryEntry[]}
export interface HarmonyChordDialogProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;value:HarmonyChord|null;
  busy:boolean;library:HarmonyLibrary;onEdit:(command:HarmonyCommand)=>void;onClose:()=>void;
  onLibraryPut:(entry:HarmonyLibraryEntry)=>Promise<void>;
  onLibraryRemove:(id:string)=>Promise<void>;
}
export interface ScaleToolPanelProps {
  score:model.Score;staff?:model.Staff;selection:MusicSelection|null;busy:boolean;onClose:()=>void;
  /** With these, the browser also authors the scale diagram of the selected beat. */
  target?:BeatTarget;beat?:model.Beat;onEdit?:(command:ScaleDiagramCommand)=>void;
  /** With these too, a position of the scale preview can be clicked to put that note on the selected beat. The follow says what the editor should select afterwards. */
  onNote?:(command:EditCommand,follow:EntryFollow)=>void;
}
export interface HarmonyTransposePanelProps {score:model.Score;selection:MusicSelection|null;busy:boolean;onEdit:(command:Extract<HarmonyCommand,{type:'transposeHarmony'}>)=>void}
export interface ChordDiagramPreviewProps {
  chord:HarmonyChord;staff:model.Staff;highlightRoot:boolean;
  onToggle:((stringIndex:number,fret:number)=>void)|null;
}
