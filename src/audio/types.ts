import type { DrumKitElement, NoteTarget } from '../edit-types';
import type { PracticeLoop,PracticeStatus } from './practice-types';
import type { PerformedBeat,PlaybackSpan } from './selection-playback-types';
export type { PracticeSettings } from './practice-types';

export type PracticeNotice = 'fixed_tempo_disabled_backing'|'key_shift_refused'|'practice_unconfirmed';
export interface PlaybackState {ready:boolean;playing:boolean;time:number;endTime:number;measure:number;speed:number;metronome:boolean;practice:PracticeStatus;practicePending:boolean;/** The key the player has asked for: the last step taken while a change was pending, else the pending key, else the acknowledged one. */keyTarget?:number;/** Counts changes of document. */documentSerial?:number;practiceNotice:PracticeNotice|null;loop:PracticeLoop|null;/** Why an edit ended the loop that was running, until the next edit or loop. */loopNotice:'cleared'|null;range:PlaybackSpan|null;error:string|null}
export type Articulation = 'picked' | 'fingered' | 'muted' | 'dead' | 'ghost' | 'staccato' | 'legato' | 'tapped' | 'harmonic' | 'feedback' | 'slap' | 'pop';
export interface PlanTrack { id: string; program: number; percussion: boolean }
export interface PlanTempo { tick: number; bpm: number }
export interface MeasureOccurrence { bar: number; occurrence: number; meterNumerator: number; meterDenominator: number; startTick: number; endTick: number; startMs: number; endMs: number; clickTicks?: number[] }
export interface PitchPoint { tick: number; semitones: number }
export interface PlanNote { id: string; trackId: string; source: NoteTarget; playedBar?: number; channel?: number; program?: number; occurrence: number; startTick: number; endTick: number; key: number; velocity: number; articulation: Articulation; lockedArticulation?: Articulation; legatoFrom: string | null; pitch: PitchPoint[]; /** A drum note's sound in the recorded kit, where the kit has one. */ kitSound?: number; /** A choked cymbal, stopped when the note ends. */ choke?: true }
type MidiLocation = { trackId: string; tick: number; channel: number };
export type PlanMidiEvent =
  | (MidiLocation & { type: 'noteOn' | 'noteOff'; key: number; velocity: number; /** The kit element of the articulation, named only where its pitch would give another. */ kitElement?: DrumKitElement })
  | (MidiLocation & { type: 'program'; program: number })
  | (MidiLocation & { type: 'controller'; controller: number; value: number })
  | (MidiLocation & { type: 'bend'; value: number })
  | (MidiLocation & { type: 'noteBend'; key: number; value: number });
export interface PlaybackPlan { generation: number; ppq: 960; durationTick: number; durationMs: number; playbackEndTick?: number; tracks: PlanTrack[]; tempos: PlanTempo[]; occurrences: MeasureOccurrence[]; performedBeats?:PerformedBeat[]; notes: PlanNote[]; midi: PlanMidiEvent[] }
