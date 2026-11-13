import { useEffect,useRef } from 'react';
import type { MidiChord } from '../audio/midi-in';
import type { MidiCaptureSession } from './midi-capture-session';

/** Hears the chords of the running MIDI session for as long as the component is mounted, each handed once to the latest `onChord`. */
export function useMidiCapture(session:MidiCaptureSession,onChord:(chord:MidiChord)=>void):void {
  const latest=useRef(onChord);latest.current=onChord;
  useEffect(()=>session.onChord(chord=>latest.current(chord)),[session]);
}
