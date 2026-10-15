import type { BeatTarget } from './project';
import type { LyricsCommand } from './editor/lyrics-types';
import type { GestureCommand, BarGestureCommand } from './editor/gestures-types';
import type { RangeCommand } from './editor/range-types';
import type { MeasureCommand } from './editor/measures-types';
import type { ClipboardCommand } from './editor/clipboard-types';
import type { EngravingCommand,EngravingOverrides,PageLayout } from './engraving/types';
import type { HarmonyCommand } from './editor/harmony-types';
import type { ReplaceTempoAutomations } from './editor/tempo-types';

export interface NoteTarget { target: BeatTarget; string: number }
export interface IndexedNoteTarget { target: BeatTarget; noteIndex: number }
export interface ScoreMetadata {
  subTitle:string; album:string; words:string; music:string; copyright:string; tab:string; notices:string; instructions:string;
}
export type LinkKind = 'tie' | 'hammerPull' | 'slur';
export interface PitchCurve { type: number; style: number; points: Array<{offset: number; value: number}> }
export interface NoteTechniques {
  letRing?: boolean; palmMute?: boolean; dead?: boolean; ghost?: boolean; staccato?: boolean; leftHandTapped?: boolean;
  accent?: number; dynamics?: number; leftFinger?: number; rightFinger?: number; slideIn?: number; slideOut?: number;
  vibrato?: number; ornament?: number; bend?: PitchCurve|null; harmonic?: {type:number;value:number}|null;
  trill?: {pitch:number;speed:number}|null;
}
export interface BeatTechniques {
  pickStroke?: number; brushType?: number; brushDuration?: number; whammy?: PitchCurve|null;
  tremolo?: {speed:number;style:number}|null;
}
export interface TempoPoint { beat: number; bpm: number; linear: boolean }
export interface StaffSettings {
  tuning: number[]; capo: number; transposition: number; displayTransposition: number; clef: number;
  showTab: boolean; showNotation: boolean;
}
export interface ChordDefinition { name: string; firstFret: number; frets: number[] }
export interface ChannelMix { gain: number; pan: number; mute: boolean; solo: boolean }
export interface FxSettings {
  gate: {enabled:boolean;thresholdDb:number;releaseMs:number};
  compressor: {enabled:boolean;thresholdDb:number;ratio:number;attackMs:number;releaseMs:number;makeupDb:number};
  amp: {enabled:boolean;model:'clean'|'crunch'|'lead'|'bass';drive:number;gainDb:number};
  cabinet: {enabled:boolean;model:'open'|'closed'|'bass'};
  eq: {enabled:boolean;lowDb:number;midDb:number;highDb:number;midHz:number};
  chorus: {enabled:boolean;rateHz:number;depthMs:number;mix:number};
  delay: {enabled:boolean;quarterNotes:number;feedback:number;mix:number};
  reverb: {enabled:boolean;room:number;damping:number;mix:number};
}
export interface TrackSound { voiceId: string|null; presetId: 'clean'|'crunch'|'lead'|'bass'|'gm'; effects: FxSettings }
export interface SyncAnchor { bar: number; occurrence: number; ratio: number; audioMs: number }
export interface ReferenceSyncBounds { entryAudioMs: number; exitAudioMs: number }
export type BackingFilter = 'none'|'bassEnhance'|'bassAttenuation'|'mediumEnhance'|'mediumAttenuation'|'highEnhance'|'highAttenuation';
export interface BackingProcessing { semitones:number; cents:number; filter:BackingFilter }
export interface BackingSettings { assetId: string; offsetMs: number; anchors: SyncAnchor[]; mix: ChannelMix; referenceSync?: ReferenceSyncBounds|null; processing?: BackingProcessing|null }
export interface PrintLayout {
  paper: 'A4'|'Letter'; orientation: 'portrait'|'landscape'; marginMm: number; scale: number; profile: 'ScoreTab'|'Score'|'Tab';
}
export interface DocumentSettings {
  sounds: Record<string,TrackSound>; mixes: Record<string,ChannelMix>; backing: BackingSettings|null; print: PrintLayout;
  engraving:EngravingOverrides;page:PageLayout|null;
}

export type EditCommand = LyricsCommand | GestureCommand | BarGestureCommand | RangeCommand | MeasureCommand | ClipboardCommand | EngravingCommand | HarmonyCommand | ReplaceTempoAutomations
  | { type: 'setNote'; target: BeatTarget; string: number; fret: number }
  | { type: 'removeNote'; target: BeatTarget; string: number }
  | { type: 'setRest'; target: BeatTarget }
  | { type: 'setDuration'; target: BeatTarget; duration: number; dots: number }
  | { type: 'insertBeat'; target: BeatTarget; duration: number; dots: number }
  | { type: 'deleteBeat'; target: BeatTarget }
  | { type: 'appendMeasure' }
  | { type: 'removeMeasure'; bar: number }
  | { type: 'addTrack'; name: string; tuning: number[]; program: number }
  | { type: 'removeTrack'; track: number }
  | { type: 'setTuning'; track: number; tuning: number[] }
  | { type: 'setScoreInfo'; title: string; artist: string; tempo: number }
  | { type: 'setScoreMetadata'; fields: ScoreMetadata }
  | { type: 'setDirections'; bar: number; directions: number[] }
  | { type: 'setNoteSpelling'; target: BeatTarget; noteIndex: number; accidentalMode: number }
  | { type: 'addPitchedTrack'; name: string; program: number }
  | { type: 'addPercussionTrack'; name: string; program: number }
  | { type: 'addPitchedNote'; target: BeatTarget; pitch: number }
  | { type: 'setPitchedNote'; target: BeatTarget; noteIndex: number; pitch: number }
  | { type: 'addPercussionNote'; target: BeatTarget; articulation: number }
  | { type: 'setPercussionNote'; target: BeatTarget; noteIndex: number; articulation: number }
  | { type: 'removeNoteByIndex'; target: BeatTarget; noteIndex: number }
  | { type: 'setNoteTechniquesByIndex'; target: BeatTarget; noteIndex: number; patch: NoteTechniques }
  | { type: 'setNoteLinkByIndex'; from: IndexedNoteTarget; to: IndexedNoteTarget|null; kind: LinkKind }
  | { type: 'setNoteTechniques'; target: BeatTarget; string: number; patch: NoteTechniques }
  | { type: 'setBeatTechniques'; target: BeatTarget; patch: BeatTechniques }
  | { type: 'setNoteLink'; from: NoteTarget; to: NoteTarget|null; kind: LinkKind }
  | { type: 'setBeatRhythm'; target: BeatTarget; duration: number; dots: number; tupletNumerator: number; tupletDenominator: number; graceType: number }
  | { type: 'setTrackInfo'; track: number; name: string; shortName: string; program: number }
  | { type: 'setStaffSettings'; track: number; staff: number; settings: StaffSettings }
  | { type: 'addStaff'; track: number; settings: StaffSettings }
  | { type: 'removeStaff'; track: number; staff: number }
  | { type: 'addVoice'; track: number; staff: number }
  | { type: 'removeVoice'; track: number; staff: number; voice: number }
  | { type: 'copyVoice'; track: number; staff: number; sourceVoice: number; destinationVoice: number; startBar: number; endBar: number }
  | { type: 'setTrackLayout'; track: number; barsPerSystem: number; lineBreaks: number[] }
  | { type: 'setMeasureSettings'; bar: number; numerator: number; denominator: number; pickup: boolean; freeTime: boolean; repeatStart: boolean; repeatCount: number; endings: number[]; section: string; tempos: TempoPoint[] }
  | { type: 'setBarNotation'; track: number; staff: number; bar: number; keySignature: number; keyMode: number; clef: number }
  | { type: 'setBeatAnnotation'; target: BeatTarget; text: string; chord: ChordDefinition|null }
  | { type: 'setTrackSound'; trackId: string; sound: TrackSound }
  | { type: 'setTrackMix'; trackId: string; mix: ChannelMix }
  | { type: 'setBacking'; backing: BackingSettings|null }
  | { type: 'setPrintLayout'; layout: PrintLayout };

export type SettingsEdit = Extract<EditCommand,{type:'setTrackSound'|'setTrackMix'|'setBacking'|'setPrintLayout'|'setEngraving'|'setPageLayout'}>;
export const isSettingsEdit = (edit: EditCommand): edit is SettingsEdit =>
  ['setTrackSound','setTrackMix','setBacking','setPrintLayout','setEngraving','setPageLayout'].includes(edit.type);
