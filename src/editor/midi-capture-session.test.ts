import { describe,expect,it,vi } from 'vitest';
import type { CaptureSettings,MidiChord,MidiInBridge,MidiInStatus,MidiInStatusEvent } from '../audio/midi-in';
import { createMidiCaptureSession } from './midi-capture-session';

const settings:CaptureSettings={chordWindowMs:60,minVelocity:1};
const idle:MidiInStatus={session:0,state:'stopped',port:'',message:'',chords:0,dropped:0,belowFloor:0};
const chordOf=(session:number,seq:number,keys:number[]=[60]):MidiChord=>({session,seq,atMs:seq*10,dropped:0,notes:keys.map(key=>({key,velocity:90,channel:0}))});
let notice=0;
const statusOf=(session:number,state:MidiInStatusEvent['state'],message='',seq=++notice):MidiInStatusEvent=>({seq,session,state,port:'USB MIDI',message});

function fake(overrides:Partial<MidiInBridge>={}){
  const handlers={chord:(_chord:MidiChord)=>{},status:(_status:MidiInStatusEvent)=>{}};
  const order:string[]=[];
  const bridge:MidiInBridge={
    ports:vi.fn(async()=>[{id:'0',name:'USB MIDI'}]),
    start:vi.fn(async()=>{order.push('start');return 7;}),
    configure:vi.fn(async()=>{}),
    stop:vi.fn(async()=>{order.push('stop');}),
    status:vi.fn(async()=>idle),
    subscribe:vi.fn(async(onChord,onStatus)=>{order.push('subscribe');handlers.chord=onChord;handlers.status=onStatus;return ()=>{order.push('unsubscribe');};}),
    ...overrides,
  };
  return {bridge,handlers,order};
}

describe('MIDI capture session',()=>{
  it('starts nothing on its own: attaching listens and reads, and opens no port',async()=>{
    const {bridge,order}=fake(),session=createMidiCaptureSession(bridge);
    await session.attach();await session.refresh();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(order).toEqual(['subscribe']);
    expect(session.get()).toMatchObject({phase:'stopped',session:0,last:null,ports:[{id:'0',name:'USB MIDI'}]});
  });

  it('attaches its listeners before it starts, and shows the chords of its own session',async()=>{
    const {bridge,handlers,order}=fake(),session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    expect(order).toEqual(['subscribe','start']);
    expect(bridge.start).toHaveBeenCalledWith('USB MIDI',settings);
    expect(session.get()).toMatchObject({phase:'running',session:7,port:'USB MIDI'});
    handlers.chord(chordOf(7,1,[60,64]));
    expect(session.get().last?.notes.map(n=>n.key)).toEqual([60,64]);
    expect(session.get().chords).toBe(1);
  });

  it('ignores a chord of another session and one that repeats or goes back in sequence',async()=>{
    const {bridge,handlers}=fake(),session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    handlers.chord(chordOf(7,5,[60]));
    handlers.chord(chordOf(6,6,[61]));
    handlers.chord(chordOf(8,6,[62]));
    handlers.chord(chordOf(7,5,[63]));
    handlers.chord(chordOf(7,3,[64]));
    expect(session.get().last?.notes[0].key).toBe(60);
    expect(session.get().chords).toBe(1);
    handlers.chord(chordOf(7,9,[65]));
    expect(session.get().last?.notes[0].key).toBe(65);
  });

  it('adopts events that arrive while the start is still opening, and ignores older sessions then',async()=>{
    let finish:(session:number)=>void=()=>{};
    const {bridge,handlers}=fake({start:vi.fn(()=>new Promise<number>(resolve=>{finish=resolve;}))});
    const session=createMidiCaptureSession(bridge);
    const starting=session.start('USB MIDI',settings);
    await vi.waitFor(()=>expect(session.get().phase).toBe('starting'));
    handlers.status(statusOf(7,'running'));
    handlers.chord(chordOf(7,1));
    expect(session.get()).toMatchObject({phase:'running',session:7,chords:1});
    finish(7);await starting;
    expect(session.get()).toMatchObject({phase:'running',session:7,chords:1});
  });

  it('shows a failed start as an error and offers to try again',async()=>{
    const {bridge}=fake({start:vi.fn(async()=>{throw new Error('The MIDI input "USB MIDI" did not open in time.');})});
    const session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    expect(session.get()).toMatchObject({phase:'error',message:'The MIDI input "USB MIDI" did not open in time.'});
    (bridge.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce(8);
    await session.start('USB MIDI',settings);
    expect(session.get()).toMatchObject({phase:'running',session:8,message:''});
  });

  it('reports a lost device, and ignores the status of a stale session',async()=>{
    const {bridge,handlers}=fake(),session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    handlers.status(statusOf(6,'lost'));
    expect(session.get().phase).toBe('running');
    handlers.status(statusOf(7,'lost'));
    expect(session.get().phase).toBe('lost');
    handlers.chord(chordOf(7,2));
    expect(session.get().chords).toBe(0);
  });

  it('hands every accepted chord, in order, to its chord listeners, and none that are stale',async()=>{
    const {bridge,handlers}=fake(),session=createMidiCaptureSession(bridge),heard:number[]=[],off=session.onChord(chord=>heard.push(chord.seq));
    await session.start('USB MIDI',settings);
    handlers.chord(chordOf(7,1));handlers.chord(chordOf(6,2));handlers.chord(chordOf(7,1));handlers.chord(chordOf(7,3));
    expect(heard).toEqual([1,3]);
    off();handlers.chord(chordOf(7,4));
    expect(heard).toEqual([1,3]);
  });

  it('drops a status notice that arrives after a newer one, so Running never follows Stopped',async()=>{
    const {bridge,handlers}=fake(),session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    handlers.status(statusOf(7,'stopped','',50));
    expect(session.get().phase).toBe('stopped');
    handlers.status(statusOf(7,'running','',49));
    expect(session.get().phase).toBe('stopped');
  });

  it('stops its own session by number and a start still opening without one',async()=>{
    const {bridge}=fake(),session=createMidiCaptureSession(bridge);
    await session.start('USB MIDI',settings);
    await session.stop();
    expect(bridge.stop).toHaveBeenLastCalledWith(7);
    expect(session.get().phase).toBe('stopped');

    let reject:(error:Error)=>void=()=>{};
    const slow=fake({start:vi.fn(()=>new Promise<number>((_resolve,fail)=>{reject=fail;}))});
    const pending=createMidiCaptureSession(slow.bridge);
    const starting=pending.start('USB MIDI',settings);
    await vi.waitFor(()=>expect(pending.get().phase).toBe('starting'));
    await pending.stop();
    expect(slow.bridge.stop).toHaveBeenLastCalledWith(undefined);
    reject(new Error('The start was cancelled before the MIDI input opened.'));await starting;
    expect(pending.get().phase).toBe('stopped');
  });

  it('passes new settings to a running session only',async()=>{
    const {bridge}=fake(),session=createMidiCaptureSession(bridge);
    session.configure({chordWindowMs:90,minVelocity:5});
    expect(bridge.configure).not.toHaveBeenCalled();
    await session.start('USB MIDI',settings);
    session.configure({chordWindowMs:90,minVelocity:5});
    expect(bridge.configure).toHaveBeenCalledWith(7,{chordWindowMs:90,minVelocity:5});
  });

  it('picks up a session the native side is already running, so it can be seen and stopped',async()=>{
    const {bridge}=fake({status:vi.fn(async()=>({...idle,session:4,state:'running' as const,port:'USB MIDI'}))});
    const session=createMidiCaptureSession(bridge);
    await session.attach();
    expect(session.get()).toMatchObject({phase:'running',session:4,port:'USB MIDI'});
    await session.stop();expect(bridge.stop).toHaveBeenCalledWith(4);
  });

  it('says what went wrong when the port list cannot be read, and keeps no old list as current',async()=>{
    const {bridge}=fake({ports:vi.fn(async()=>{throw new Error('No MIDI');})}),session=createMidiCaptureSession(bridge);
    await session.refresh();
    expect(session.get()).toMatchObject({ports:[],listError:'No MIDI',listAlert:false});
    // A listing the player asked for is reported loudly; one made in the background is not.
    await session.refresh(true);
    expect(session.get()).toMatchObject({listError:'No MIDI',listAlert:true});
    await session.refresh();
    expect(session.get().listAlert).toBe(false);
  });

  it('keeps a failure to attach as a background note and opens nothing',async()=>{
    const {bridge}=fake({subscribe:vi.fn(async()=>{throw new Error('no native side');})}),session=createMidiCaptureSession(bridge);
    await session.attach();
    expect(session.get()).toMatchObject({unavailable:'no native side',problem:'',phase:'stopped'});
    await session.start('USB MIDI',settings);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(session.get().problem).toBe('no native side');
  });

  it('notifies listeners of each change and stops after they unsubscribe',async()=>{
    const {bridge}=fake(),session=createMidiCaptureSession(bridge),seen=vi.fn(),off=session.subscribe(seen);
    await session.refresh();expect(seen).toHaveBeenCalled();
    seen.mockClear();off();await session.refresh();expect(seen).not.toHaveBeenCalled();
  });
});
