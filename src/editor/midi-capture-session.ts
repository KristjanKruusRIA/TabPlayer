import { useSyncExternalStore } from 'react';
import { nativeMidiIn,type CaptureSettings,type MidiChord,type MidiInBridge,type MidiInStatusEvent } from '../audio/midi-in';
import type { MidiOutPort } from '../audio/midi-out';

export type MidiCapturePhase='stopped'|'starting'|'running'|'lost'|'error';
export interface MidiCaptureState {
  /** The last port list, or null until it has been read. */
  ports:MidiOutPort[]|null;
  listError:string;
  /** Whether the player asked for the listing that failed (Refresh), so the failure is an alert rather than a quiet note. */
  listAlert:boolean;
  /** Why the listeners could not be attached, such as no native side to talk to. A background failure, not a failed action. */
  unavailable:string;
  phase:MidiCapturePhase;
  /** The latest session, 0 before the first. Events of any other session are stale. */
  session:number;
  port:string;
  /** The native side's own words for an error. */
  message:string;
  /** The last chord played, kept to show that the path from the device works. Not stored anywhere. */
  last:MidiChord|null;
  chords:number;
  /** Notes native reports lost. */
  dropped:number;
  /** What went wrong with a command, not with the device. */
  problem:string;
  /** Chords that arrived while edits could not take them, or that were turned away because the queue was full. */
  notWritten:number;
  /** Chords are being turned away because a header menu is open, so the panel can say why. */
  blocked:boolean;
  /** Notes of the MIDI guitar mapping written on another string than their channel's, because that channel has no string on the track. */
  relocated:number;
  /** Notes of the MIDI guitar mapping left out because their pitch was already on the beat. */
  skipped:number;
  /** The string count of the track the cursor is on, or null (no fretted track), so the panel can say where channels land. */
  trackStrings:number|null;
}
export interface MidiCaptureSession {
  subscribe(listener:()=>void):()=>void;
  get():MidiCaptureState;
  /** Attaches the event listeners and picks up a session the native side is already running. Opens nothing. */
  attach():Promise<void>;
  /** Reads the ports. `asked` is true for the player's own Refresh. */
  refresh(asked?:boolean):Promise<void>;
  start(port:string,settings:CaptureSettings):Promise<void>;
  stop():Promise<void>;
  /** Passes new sensitivity to a running session. */
  configure(settings:CaptureSettings):void;
  /** Counts a chord the score could not take, so the panel can say so. */
  countNotWritten(by?:number):void;
  /** Count notes of a written chord that took another string, or were not written again. */
  countRelocated(by?:number):void;
  countSkipped(by?:number):void;
  /** Tells the panel how many strings the selected track has. */
  setTrackStrings(count:number|null):void;
  /** Records whether chords are being turned away because a menu is open. */
  setBlocked(blocked:boolean):void;
  /** Hears every chord of the running session, in order, once each; stale and repeated ones never arrive. */
  onChord(listener:(chord:MidiChord)=>void):()=>void;
  dispose():void;
}
const text=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * One MIDI input session as the page sees it. It outlives the panel, so input carries on with the View menu closed. Every
 * event is checked against the session: while a start is opening it adopts a newer session once, and after that only
 * the running session's events count, with a chord counting only if its sequence number is new.
 */
export function createMidiCaptureSession(bridge:MidiInBridge):MidiCaptureSession {
  let state:MidiCaptureState={ports:null,listError:'',listAlert:false,unavailable:'',phase:'stopped',session:0,port:'',message:'',last:null,chords:0,dropped:0,problem:'',notWritten:0,blocked:false,relocated:0,skipped:0,trackStrings:null};
  let lastSeq=0,lastNotice=0,detach:(()=>void)|null=null,attaching:Promise<void>|null=null,cancelled=false,disposed=false;
  const listeners=new Set<()=>void>(),chordListeners=new Set<(chord:MidiChord)=>void>();
  // Read through a function: events change `state` while an await is pending, which narrowing cannot see.
  const phase=():MidiCapturePhase=>state.phase;
  const set=(change:Partial<MidiCaptureState>)=>{state={...state,...change};listeners.forEach(listener=>listener());};
  /** Whether an event of `session` belongs to this page's session; a start still opening takes the first newer one. */
  const accept=(session:number)=>{
    if(state.phase==='starting'){
      // Only a newer session: the one that just ended may still be announcing itself.
      if(session<=state.session)return false;
      state={...state,session};lastSeq=0;return true;
    }
    return session===state.session&&state.session>0;
  };
  const onChord=(chord:MidiChord)=>{
    if(!accept(chord.session)||chord.seq<=lastSeq||state.phase==='lost'||state.phase==='error'||state.phase==='stopped')return;
    lastSeq=chord.seq;
    set({last:chord,chords:state.chords+1,dropped:chord.dropped,phase:state.phase==='starting'?'running':state.phase});
    for(const listener of [...chordListeners])try{listener(chord);}catch(error){console.error('A MIDI chord listener failed.',error);}
  };
  const onStatus=(status:MidiInStatusEvent)=>{
    // Notices are numbered as they are decided; one that arrives after a newer one (Running after Stopped) is stale.
    if(status.seq<=lastNotice)return;
    lastNotice=status.seq;
    if(!accept(status.session))return;
    set({phase:status.state,port:status.port||state.port,message:status.message});
  };
  const attach=()=>attaching??=(async()=>{
    try{
      detach=await bridge.subscribe(onChord,onStatus);
      if(disposed){detach();detach=null;return;}
      const native=await bridge.status();
      // After a reload the native side may still be listening; show it so it can be stopped.
      if(native.state==='running'&&state.phase==='stopped')set({phase:'running',session:native.session,port:native.port,chords:native.chords,dropped:native.dropped});
    }catch(error){attaching=null;set({unavailable:text(error)});}
  })();
  const refresh=async(asked=false)=>{
    try{set({ports:await bridge.ports(),listError:'',listAlert:false});}
    catch(error){set({ports:state.ports??[],listError:text(error),listAlert:asked});}
  };
  const start=async(port:string,settings:CaptureSettings)=>{
    if(state.phase==='starting')return;
    // The listeners are attached before the port is opened, so the first chord cannot be missed.
    await attach();
    if(!detach){set({problem:state.unavailable});return;}
    cancelled=false;lastSeq=0;
    set({phase:'starting',port,message:'',problem:'',last:null,chords:0,dropped:0,notWritten:0,blocked:false,relocated:0,skipped:0});
    try{
      const session=await bridge.start(port,settings);
      if(cancelled){set({phase:'stopped'});return;}
      // A status event may already have said the input was lost; that stands.
      if(phase()==='starting')set({session,phase:'running'});
    }catch(error){
      if(cancelled)set({phase:'stopped'});
      else if(phase()==='starting')set({phase:'error',message:text(error)});
    }
  };
  const stop=async()=>{
    const starting=state.phase==='starting';
    if(starting)cancelled=true;
    try{await bridge.stop(starting?undefined:state.session);set({problem:'',...(starting?{}:{phase:'stopped' as const,message:''})});}
    catch(error){set({problem:text(error)});}
  };
  return {
    subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    get:()=>state,
    attach,refresh,start,stop,
    countNotWritten:(by=1)=>{if(by>0)set({notWritten:state.notWritten+by});},
    countRelocated:(by=1)=>{if(by>0)set({relocated:state.relocated+by});},
    countSkipped:(by=1)=>{if(by>0)set({skipped:state.skipped+by});},
    setTrackStrings:count=>{if(state.trackStrings!==count)set({trackStrings:count});},
    setBlocked:blocked=>{if(state.blocked!==blocked)set({blocked});},
    onChord:listener=>{chordListeners.add(listener);return ()=>{chordListeners.delete(listener);};},
    configure:settings=>{
      if(state.phase!=='running')return;
      bridge.configure(state.session,settings).catch(error=>set({problem:text(error)}));
    },
    dispose:()=>{disposed=true;detach?.();detach=null;listeners.clear();},
  };
}

const sessions=new WeakMap<MidiInBridge,MidiCaptureSession>();
/** The app's one session for a bridge. */
export function midiCaptureSession(bridge:MidiInBridge=nativeMidiIn):MidiCaptureSession {
  let session=sessions.get(bridge);
  if(!session){session=createMidiCaptureSession(bridge);sessions.set(bridge,session);}
  return session;
}
export type MidiCaptureBadge='off'|'on'|'lost';
/** What the toolbar shows. A string snapshot, so a consumer re-renders when it changes and not for each chord. */
export function useMidiCaptureBadge(session:MidiCaptureSession):MidiCaptureBadge {
  const read=()=>{const {phase}=session.get();return phase==='running'?'on':phase==='lost'?'lost':'off';};
  return useSyncExternalStore(session.subscribe,read,read);
}
export function useMidiCaptureState(session:MidiCaptureSession):MidiCaptureState {
  return useSyncExternalStore(session.subscribe,session.get,session.get);
}
