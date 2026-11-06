import { invoke } from '@tauri-apps/api/core';
import { pitchClassName } from '../harmony/scale-diagram';

export interface TunerInput {id:string;name:string;default:boolean}
export interface TunerPitch {frequency:number;clarity:number}
/** The latest native analysis. `strings` holds the measured frequency for each requested target, or null. */
export interface TunerReading {running:boolean;error:string|null;level:number;pitch:TunerPitch|null;strings:(number|null)[]}
export interface TunerBridge {
  inputs():Promise<TunerInput[]>;
  /** Starts capture and returns its session, so a stale stop cannot end a newer capture. */
  start(inputId:string|null):Promise<number>;
  /** Stops capture `session`, or any capture when null. */
  stop(session:number|null):Promise<void>;
  read(strings:number[]):Promise<TunerReading>;
}
export const nativeTuner:TunerBridge={
  inputs:()=>invoke('tuner_inputs'),
  start:inputId=>invoke('tuner_start',{inputId}),
  stop:session=>invoke('tuner_stop',{session}),
  read:strings=>invoke('tuner_read',{strings}),
};

/** The lowest and highest accepted concert pitch for A4, in Hz. */
export const REFERENCE_RANGE=[415,466] as const;
/** Cents within which a note counts as in tune. */
export const IN_TUNE_CENTS=3;
/** The frequency of MIDI note `midi` with A4 at `reference` Hz. */
export const frequencyOf=(midi:number,reference=440)=>reference*2**((midi-69)/12);
/** The fractional MIDI note of `frequency`. */
export const midiOf=(frequency:number,reference=440)=>69+12*Math.log2(frequency/reference);
/** Cents from `target` Hz to `frequency` Hz. */
export const centsBetween=(frequency:number,target:number)=>1200*Math.log2(frequency/target);
/** Note name with octave, such as `E2` or `F#4`. */
export const noteName=(midi:number)=>`${pitchClassName(midi)}${Math.floor(midi/12)-1}`;
/** The nearest note to `frequency` and how many cents it is off, rounded to tenths. */
export function nearestNote(frequency:number,reference=440):{midi:number;name:string;cents:number} {
  const exact=midiOf(frequency,reference),midi=Math.round(exact);
  return {midi,name:noteName(midi),cents:Math.round((exact-midi)*1000)/10};
}
