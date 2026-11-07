import { invoke } from '@tauri-apps/api/core';
import type { TrackSound } from '../edit-types';

/** An audio input the system offers. The same list the tuner shows. */
export interface LineInInput {id:string;name:string;default:boolean}
/**
 * What the Line-In sounds like: its own sound chain (a track's `TrackSound`, whose preset and
 * effects apply), a level from 0 to 1 and whether it is heard. Independent of every score.
 */
export interface LineInSettings {sound:TrackSound;level:number;monitor:boolean}
/**
 * The native Line-In status. Levels are dBFS peaks since the previous status call (-120 when
 * silent). `latencyMs` is the delay from input to output, null until the buffer has filled; it
 * leaves out the input device's own buffer, which the audio system does not report.
 * `outputLevel` and the four counters are always sent by the native side; they are optional
 * here only so a bridge that does not know them still type-checks.
 */
export interface LineInStatus {
  running:boolean;
  error:string|null;
  inputLevel:number;
  outputLevel?:number;
  latencyMs:number|null;
  inputRate:number|null;
  outputRate:number|null;
  /** Times the buffer ran dry and the sound faded out to refill. */
  underruns?:number;
  /** Times the buffer overran and the monitor skipped ahead. */
  skips?:number;
  /** Input samples dropped because the buffer was full. */
  dropped?:number;
  /** Times the sound chain went bad (a non-finite value in its state) and was replaced. */
  resets?:number;
}
export interface LineInBridge {
  inputs():Promise<LineInInput[]>;
  /** Starts capturing and returns its session, so a stale stop cannot end a newer capture. Opens the audio output if no score has. */
  start(inputId:string|null):Promise<number>;
  /** Stops capture `session`, or any capture when null. */
  stop(session:number|null):Promise<void>;
  /** Sets the sound, level and monitor switch. Valid whether or not a capture is running; choosing what is set changes nothing. */
  set(settings:LineInSettings):Promise<void>;
  status():Promise<LineInStatus>;
}
export const nativeLineIn:LineInBridge={
  inputs:()=>invoke('line_in_inputs'),
  start:inputId=>invoke('line_in_start',{inputId}),
  stop:session=>invoke('line_in_stop',{session}),
  set:settings=>invoke('line_in_set',{settings}),
  status:()=>invoke('line_in_status'),
};
