import type { BeatTarget } from './project';
import type { LyricsCommand } from './editor/lyrics-types';
import type { GestureCommand, BarGestureCommand } from './editor/gestures-types';
import type { RangeCommand } from './editor/range-types';
import type { MeasureCommand } from './editor/measures-types';
import type { ClipboardCommand } from './editor/clipboard-types';
import type { EngravingCommand,EngravingOverrides,PageLayout } from './engraving/types';
import type { HarmonyCommand } from './editor/harmony-types';
import type { ScaleDiagramCommand } from './harmony/scale-diagram';
import type { ReplaceTempoAutomations } from './editor/tempo-types';
import type { PartialCapo } from './editor/partial-capo';
import type { NoteAudio } from './editor/note-audio';

export interface NoteTarget { target: BeatTarget; string: number }
export interface IndexedNoteTarget { target: BeatTarget; noteIndex: number }
export interface ScoreMetadata {
  subTitle:string; album:string; words:string; music:string; copyright:string; tab:string; notices:string; instructions:string;
}
/** Which existing strings stay in place when a track gains or loses strings. */
export type StringCountKeep = 'high' | 'low';
export type LinkKind = 'tie' | 'hammerPull' | 'slur';
export interface PitchCurve { type: number; style: number; points: Array<{offset: number; value: number}> }
export interface NoteTechniques {
  letRing?: boolean; palmMute?: boolean; dead?: boolean; ghost?: boolean; staccato?: boolean; leftHandTapped?: boolean;
  accent?: number; dynamics?: number; leftFinger?: number; rightFinger?: number; slideIn?: number; slideOut?: number;
  vibrato?: number; ornament?: number; bend?: PitchCurve|null; harmonic?: {type:number;value:number}|null;
  trill?: {pitch:number;speed:number}|null;
  /** How the note sounds, not how it is written; null or the plain values (100 percent, 0, 0) clear it. */
  audio?: NoteAudio|null;
}
export interface BeatTechniques {
  pickStroke?: number; brushType?: number; brushDuration?: number; whammy?: PitchCurve|null;
  tremolo?: {speed:number;style:number}|null;
}
export interface TempoPoint { beat: number; bpm: number; linear: boolean }
export interface StaffSettings {
  tuning: number[]; capo: number; transposition: number; displayTransposition: number; clef: number;
  showTab: boolean; showNotation: boolean;
  /** Optional document tuning name; omitted keeps the staff's name, '' clears it. */
  tuningName?: string;
  /** Optional capo over some strings; omitted keeps the staff's, `{fret:0,strings:[]}` clears it. */
  partialCapo?: PartialCapo;
  /** Optional banjo drone on a 5-string staff: the neck fret its short string starts at (1-12); omitted keeps the staff's, 0 clears it. */
  droneFret?: number;
}
export interface ChordDefinition { name: string; firstFret: number; frets: number[] }
/** How a track's stringed notes are performed; each field is absent at its default (automatic style, normal palm mutes, no accent, no automatic let ring or brush). */
export interface TrackInterpretation { style?: 'pick'|'fingers'; palmMute?: 'light'|'heavy'; accent?: 'light'|'strong'; letRing?: true; brush?: 'down'|'up' }
export interface ChannelMix { gain: number; pan: number; mute: boolean; solo: boolean; interpretation?: TrackInterpretation }
/** A cabinet impulse response by the identity it has in a user's library (32 hex digits of the file's hash), with the name it was picked under and a level trim. Documents never hold the audio. */
export interface CabinetIrRef { id:string;name:string;levelDb:number }
export interface FxSettings {
  gate: {enabled:boolean;thresholdDb:number;releaseMs:number};
  compressor: {enabled:boolean;thresholdDb:number;ratio:number;attackMs:number;releaseMs:number;makeupDb:number};
  /** The tone stack fields are absent while flat (0 dB). */
  amp: {enabled:boolean;model:'clean'|'crunch'|'lead'|'metal'|'bass'|'bassDrive';drive:number;gainDb:number;bassDb?:number;midDb?:number;trebleDb?:number;presenceDb?:number};
  /** `ir` names a cabinet impulse response in the user's own library, which plays in place of `model` where the library has it. */
  cabinet: {enabled:boolean;model:'open'|'closed'|'combo'|'bass'|'bassStack';ir?:CabinetIrRef};
  eq: {enabled:boolean;lowDb:number;midDb:number;highDb:number;midHz:number};
  /** `syncQuarterNotes` on a modulation block: quarter notes per cycle when its rate follows the tempo; absent for the free rate. */
  chorus: {enabled:boolean;rateHz:number;depthMs:number;mix:number;syncQuarterNotes?:number};
  delay: {enabled:boolean;model:'digital'|'tape'|'analog';quarterNotes:number;feedback:number;mix:number};
  reverb: {enabled:boolean;model:'room'|'hall'|'plate'|'spring';room:number;damping:number;mix:number};
  vibrato: {enabled:boolean;rateHz:number;depthCents:number;syncQuarterNotes?:number};
  phaser: {enabled:boolean;rateHz:number;depth:number;feedback:number;stages:2|4|6|8;mix:number;syncQuarterNotes?:number};
  flanger: {enabled:boolean;rateHz:number;depthMs:number;feedback:number;mix:number;syncQuarterNotes?:number};
  tremolo: {enabled:boolean;rateHz:number;depth:number;shape:'sine'|'square';syncQuarterNotes?:number};
  wah: {enabled:boolean;model:'classic'|'vintage'|'wide'|'bass';mode:'manual'|'auto';position:number;resonance:number;sensitivity:number;mix:number};
  octaver: {enabled:boolean;octaveDown:number;twoOctavesDown:number;direct:number};
  pitch: {enabled:boolean;semitones:number;mix:number};
  drive: {enabled:boolean;model:'overdrive'|'distortion'|'fuzz';drive:number;tone:number;levelDb:number};
  microphone: {enabled:boolean;placement:'standard'|'close'|'edge'|'room';output:'stereo'|'mono'};
  graphicEq: {enabled:boolean;gainsDb:number[];levelDb:number};
  /** Every block once, in the order the signal passes through them; absent for the default order. */
  order?: EffectBlock[];
  /** A second pedalboard after this one, so any pedal can play twice with its own settings; it holds no board of its own. */
  second?: FxSettings;
}
export type EffectBlock = Exclude<keyof FxSettings, 'order'|'second'>;
export interface TrackSound { voiceId: string|null; presetId: 'clean'|'crunch'|'lead'|'bass'|'gm'; effects: FxSettings; locked?: boolean }
export interface SyncAnchor { bar: number; occurrence: number; ratio: number; audioMs: number }
export interface ReferenceSyncBounds { entryAudioMs: number; exitAudioMs: number }
export type BackingFilter = 'none'|'bassEnhance'|'bassAttenuation'|'mediumEnhance'|'mediumAttenuation'|'highEnhance'|'highAttenuation';
export interface BackingProcessing { semitones:number; cents:number; filter:BackingFilter }
export interface BackingSettings { assetId: string; offsetMs: number; anchors: SyncAnchor[]; mix: ChannelMix; referenceSync?: ReferenceSyncBounds|null; processing?: BackingProcessing|null }
export interface PrintLayout {
  paper: 'A4'|'Letter'; orientation: 'portrait'|'landscape'; marginMm: number; scale: number; profile: 'ScoreTab'|'Score'|'Tab';
}
/** The master limiter: nothing it passes is above `ceilingDb`, and it has an instant attack. */
export interface MasterLimiter { enabled:boolean; ceilingDb:number; releaseMs:number }
/** The song-level chain after the mix: the compressor, EQ and reverb on the tracks and backing, the overall level and
 * balance, and the limiter on everything that sounds. */
export interface MasterSettings {
  gainDb:number; balance:number;
  compressor:FxSettings['compressor']; eq:FxSettings['eq']; reverb:FxSettings['reverb']; limiter:MasterLimiter;
}
export interface DocumentSettings {
  sounds: Record<string,TrackSound>; mixes: Record<string,ChannelMix>; backing: BackingSettings|null; print: PrintLayout;
  engraving:EngravingOverrides;page:PageLayout|null;
  /** Absent until the master is first edited; a document without one plays as the defaults do. */
  master?:MasterSettings;
}

export type EditCommand = LyricsCommand | GestureCommand | BarGestureCommand | RangeCommand | MeasureCommand | ClipboardCommand | EngravingCommand | HarmonyCommand | ScaleDiagramCommand | ReplaceTempoAutomations
  | { type: 'setNote'; target: BeatTarget; string: number; fret: number }
  | { type: 'removeNote'; target: BeatTarget; string: number }
  | { type: 'setRest'; target: BeatTarget }
  | { type: 'setDuration'; target: BeatTarget; duration: number; dots: number }
  | { type: 'insertBeat'; target: BeatTarget; duration: number; dots: number }
  | { type: 'deleteBeat'; target: BeatTarget }
  | { type: 'appendMeasure' }
  | { type: 'removeMeasure'; bar: number }
  | { type: 'addTrack'; name: string; tuning: number[]; program: number; tuningName?: string }
  | { type: 'removeTrack'; track: number }
  | { type: 'moveTrack'; track: number; to: number }
  | { type: 'duplicateTrack'; track: number }
  | { type: 'setTrackColor'; track: number; color: string }
  | { type: 'setTuning'; track: number; tuning: number[]; tuningName?: string }
  | { type: 'setStringCount'; track: number; tuning: number[]; keep: StringCountKeep; tuningName?: string }
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
  | { type: 'setPrintLayout'; layout: PrintLayout }
  | { type: 'setMaster'; master: MasterSettings };

export type SettingsEdit = Extract<EditCommand,{type:'setTrackSound'|'setTrackMix'|'setBacking'|'setPrintLayout'|'setEngraving'|'setPageLayout'|'setMaster'}>;
export const isSettingsEdit = (edit: EditCommand): edit is SettingsEdit =>
  ['setTrackSound','setTrackMix','setBacking','setPrintLayout','setEngraving','setPageLayout','setMaster'].includes(edit.type);
