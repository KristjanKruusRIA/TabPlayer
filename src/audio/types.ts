import type { NoteTarget } from '../edit-types';
import type { PracticeLoop,PracticeStatus } from './practice-types';
import type { PerformedBeat,PlaybackSpan } from './selection-playback-types';
export type { PracticeSettings } from './practice-types';

export interface PlaybackState {ready:boolean;playing:boolean;time:number;endTime:number;measure:number;speed:number;metronome:boolean;practice:PracticeStatus;practicePending:boolean;practiceNotice:string|null;loop:PracticeLoop|null;range:PlaybackSpan|null;error:string|null}
export type Articulation = 'picked' | 'fingered' | 'muted' | 'dead' | 'ghost' | 'staccato' | 'legato' | 'tapped' | 'harmonic' | 'feedback';
export interface PlanTrack { id: string; program: number; percussion: boolean }
export interface PlanTempo { tick: number; bpm: number }
export interface MeasureOccurrence { bar: number; occurrence: number; meterNumerator: number; meterDenominator: number; startTick: number; endTick: number; startMs: number; endMs: number; clickTicks?: number[] }
export interface PitchPoint { tick: number; semitones: number }
export interface PlanNote { id: string; trackId: string; source: NoteTarget; playedBar?: number; channel?: number; program?: number; occurrence: number; startTick: number; endTick: number; key: number; velocity: number; articulation: Articulation; legatoFrom: string | null; pitch: PitchPoint[] }
type MidiLocation = { trackId: string; tick: number; channel: number };
export type PlanMidiEvent =
  | (MidiLocation & { type: 'noteOn' | 'noteOff'; key: number; velocity: number })
  | (MidiLocation & { type: 'program'; program: number })
  | (MidiLocation & { type: 'controller'; controller: number; value: number })
  | (MidiLocation & { type: 'bend'; value: number })
  | (MidiLocation & { type: 'noteBend'; key: number; value: number });
export interface PlaybackPlan { generation: number; ppq: 960; durationTick: number; durationMs: number; tracks: PlanTrack[]; tempos: PlanTempo[]; occurrences: MeasureOccurrence[]; performedBeats?:PerformedBeat[]; notes: PlanNote[]; midi: PlanMidiEvent[] }
