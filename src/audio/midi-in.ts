import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MidiOutPort } from './midi-out';

/** What a chord needs to be to count: at most this many notes, so a hostile event cannot make a long list. */
export const MIDI_CHORD_MAX_NOTES=8;
const PORT_NAME_MAX=256;
const MESSAGE_MAX=500;

/** The sensitivity native applies. Window 10 to 500 ms, velocity floor 1 to 127. */
export interface CaptureSettings {chordWindowMs:number;minVelocity:number}
export interface MidiChordNote {key:number;velocity:number;channel:number}
/** Notes played together, from the `midi-in-chord` event. */
export interface MidiChord {
  /** The input session the chord belongs to. A chord of any other session is stale. */
  session:number;
  /** Rises with every chord of a session; a gap means chords were lost. */
  seq:number;
  /** Milliseconds since the session started. */
  atMs:number;
  /** Notes lost so far this session. */
  dropped:number;
  notes:MidiChordNote[];
}
export type MidiInState='running'|'stopped'|'lost'|'error';
/** The `midi-in-status` event. */
/** `seq` rises with every notice; a notice older than one already seen is stale. */
export interface MidiInStatusEvent {seq:number;session:number;state:MidiInState;port:string;message:string}
/** What `midi_in_status` returns. */
export interface MidiInStatus extends Omit<MidiInStatusEvent,'seq'> {chords:number;dropped:number;belowFloor:number}

export interface MidiInBridge {
  /** Lists the inputs. Opens none. */
  ports():Promise<MidiOutPort[]>;
  /** Opens the input and starts the session. The only call that opens a port. Resolves with the session number. */
  start(port:string,settings:CaptureSettings):Promise<number>;
  configure(session:number,settings:CaptureSettings):Promise<void>;
  /** Stops the named session, or whatever runs when none is named. A session that is not the latest changes nothing. */
  stop(session?:number):Promise<void>;
  status():Promise<MidiInStatus>;
  /** Attaches both listeners; resolves once they are attached, with the function that detaches them. */
  subscribe(onChord:(chord:MidiChord)=>void,onStatus:(status:MidiInStatusEvent)=>void):Promise<()=>void>;
}

const isObject=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const STATES:readonly string[]=['running','stopped','lost','error'];

/** An event payload is untrusted: anything that is not exactly a chord is null, and only the known fields are kept. */
export function parseChordEvent(payload:unknown):MidiChord|null {
  if(!isObject(payload))return null;
  const {session,seq,atMs,dropped,notes}=payload;
  if(!integer(session,1,Number.MAX_SAFE_INTEGER)||!integer(seq,0,Number.MAX_SAFE_INTEGER)||!integer(atMs,0,Number.MAX_SAFE_INTEGER)||!integer(dropped,0,Number.MAX_SAFE_INTEGER))return null;
  if(!Array.isArray(notes)||notes.length<1||notes.length>MIDI_CHORD_MAX_NOTES)return null;
  const kept:MidiChordNote[]=[];
  for(const note of notes){
    if(!isObject(note)||!integer(note.key,0,127)||!integer(note.velocity,1,127)||!integer(note.channel,0,15))return null;
    kept.push({key:note.key,velocity:note.velocity,channel:note.channel});
  }
  return {session,seq,atMs,dropped,notes:kept};
}
export function parseStatusEvent(payload:unknown):MidiInStatusEvent|null {
  if(!isObject(payload))return null;
  const {seq,session,state,port,message}=payload;
  if(!integer(seq,1,Number.MAX_SAFE_INTEGER)||!integer(session,0,Number.MAX_SAFE_INTEGER)||typeof state!=='string'||!STATES.includes(state))return null;
  if(typeof port!=='string'||port.length>PORT_NAME_MAX||typeof message!=='string')return null;
  return {seq,session,state:state as MidiInState,port,message:message.slice(0,MESSAGE_MAX)};
}

export const nativeMidiIn:MidiInBridge={
  ports:()=>invoke('midi_in_ports'),
  start:(port,settings)=>invoke('midi_in_start',{port,settings}),
  configure:(session,settings)=>invoke('midi_in_configure',{session,settings}),
  stop:session=>invoke('midi_in_stop',{session:session??null}),
  status:()=>invoke('midi_in_status'),
  subscribe:async(onChord,onStatus)=>{
    const detach:(()=>void)[]=[];
    try{
      detach.push(await listen<unknown>('midi-in-chord',event=>{const chord=parseChordEvent(event.payload);if(chord)onChord(chord);}));
      detach.push(await listen<unknown>('midi-in-status',event=>{const status=parseStatusEvent(event.payload);if(status)onStatus(status);}));
    }catch(error){detach.forEach(off=>off());throw error;}
    return ()=>detach.forEach(off=>off());
  },
};
/** Listens for chords alone. The listener is attached when this resolves, so start the session after awaiting it. */
export async function subscribeChords(onChord:(chord:MidiChord)=>void):Promise<()=>void> {
  return listen<unknown>('midi-in-chord',event=>{const chord=parseChordEvent(event.payload);if(chord)onChord(chord);});
}
