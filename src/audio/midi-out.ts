import { invoke } from '@tauri-apps/api/core';

/** A system MIDI output port. `id` is stable for the session; the `name` is what a track's mix stores as `midiPort`. */
export interface MidiOutPort {id:string;name:string}
export interface MidiOutPortStatus {
  /** The port's name, as stored in the mix. */
  name:string;
  /** Whether the port is open and working. */
  open:boolean;
  /** Why the port is not working (not found, failed to open, a send failed); null while it is. */
  error:string|null;
  /** Identities of the tracks sent to this port that play there (they play on the internal sound while it is not working). */
  tracks:string[];
  /** Identities of tracks that asked for this port but found no free channels and play on the internal sound. Each plan channel a track uses (the secondary one carries bent and vibrato notes) takes one of the 15 melodic channels, and a track whose channels do not all fit falls back whole. */
  overflowTracks:string[];
  /** Percussion tracks on this port when there are several. They all play on channel 10, so one drum kit serves them. Empty otherwise. Always sent by the native side; optional here only so a bridge that does not know it still type-checks. */
  sharedPercussion?:string[];
}
export interface MidiOutStatus {
  ports:MidiOutPortStatus[];
  /** Messages written to a port. */
  sent:number;
  /** Messages not delivered: the queue was full or the port had failed. */
  dropped:number;
  /** Messages written more than 5 ms after they were due. */
  late:number;
  /** The worst lateness in milliseconds. */
  maxLateMs:number;
}
/** What the desktop test build's "Test MIDI output" port received. */
export interface MidiOutTestMessage {
  /** Milliseconds since the first message since the log was last taken. */
  ms:number;
  /** The same moment on the wall clock, milliseconds since 1970, to line up with `Date.now()`. */
  unixMs:number;
  bytes:number[];
}
/** The score whose routing a port refresh may repair, as the other audio commands name it. */
export interface MidiOutOwner {documentId:string;activationId:string}
export interface MidiOutBridge {
  /**
   * The system's MIDI output ports. Given the owner of the open score, asking also tries again any port the score sends
   * tracks to that was not working (at most once every two seconds per port) and moves its tracks over once it is.
   */
  ports(owner?:MidiOutOwner):Promise<MidiOutPort[]>;
  /** Sets the delay in milliseconds (0 to 500) added to every message, so a port can line up with the internal output. The native side remembers it for the session only. */
  setDelay(ms:number):Promise<void>;
  status():Promise<MidiOutStatus>;
  /** Desktop test builds only: returns and clears what the "Test MIDI output" port (listed when `TABPLAYER_MIDI_OUT_TEST=1`) received. */
  testLog():Promise<MidiOutTestMessage[]>;
}
export const nativeMidiOut:MidiOutBridge={
  ports:owner=>invoke('midi_out_ports',{owner:owner??null}),
  setDelay:ms=>invoke('midi_out_set_delay',{ms}),
  status:()=>invoke('midi_out_status'),
  testLog:()=>invoke('midi_out_test_log'),
};
