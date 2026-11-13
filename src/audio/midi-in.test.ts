import { afterEach,describe,expect,it,vi } from 'vitest';

const native=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
import { nativeMidiIn,parseChordEvent,parseStatusEvent,subscribeChords,type MidiChord } from './midi-in';

afterEach(()=>{vi.clearAllMocks();});
const chord={session:2,seq:5,atMs:1200,dropped:0,notes:[{key:60,velocity:100,channel:0},{key:64,velocity:90,channel:15}]};

describe('parseChordEvent',()=>{
  it('accepts a well-formed chord and copies only the fields it knows',()=>{
    expect(parseChordEvent(chord)).toEqual(chord);
    const parsed=parseChordEvent({...chord,extra:'x',notes:[{...chord.notes[0],extra:1}]}) as MidiChord;
    expect(parsed).toEqual({...chord,notes:[chord.notes[0]]});
    expect('extra' in parsed).toBe(false);
  });
  it('accepts one note and exactly eight, and refuses none and nine',()=>{
    const note={key:1,velocity:1,channel:0};
    expect(parseChordEvent({...chord,notes:[note]})).not.toBeNull();
    expect(parseChordEvent({...chord,notes:Array.from({length:8},()=>note)})).not.toBeNull();
    expect(parseChordEvent({...chord,notes:[]})).toBeNull();
    expect(parseChordEvent({...chord,notes:Array.from({length:9},()=>note)})).toBeNull();
  });
  it.each([
    ['null',null],['a string','chord'],['a number',3],['an array',[chord]],['undefined',undefined],
    ['no session',{...chord,session:undefined}],['session zero',{...chord,session:0}],['a fractional session',{...chord,session:1.5}],
    ['a string session',{...chord,session:'2'}],['a negative seq',{...chord,seq:-1}],['NaN seq',{...chord,seq:Number.NaN}],
    ['an unsafe seq',{...chord,seq:2**60}],['an infinite time',{...chord,atMs:Infinity}],['a negative time',{...chord,atMs:-1}],
    ['a negative drop count',{...chord,dropped:-1}],['no notes',{...chord,notes:undefined}],['notes as an object',{...chord,notes:{length:1,0:chord.notes[0]}}],
    ['a null note',{...chord,notes:[null]}],['a note as an array',{...chord,notes:[[60,100,0]]}],
    ['key 128',{...chord,notes:[{key:128,velocity:90,channel:0}]}],['key -1',{...chord,notes:[{key:-1,velocity:90,channel:0}]}],
    ['key 60.5',{...chord,notes:[{key:60.5,velocity:90,channel:0}]}],['a string key',{...chord,notes:[{key:'60',velocity:90,channel:0}]}],
    ['velocity 0',{...chord,notes:[{key:60,velocity:0,channel:0}]}],['velocity 128',{...chord,notes:[{key:60,velocity:128,channel:0}]}],
    ['channel 16',{...chord,notes:[{key:60,velocity:90,channel:16}]}],['channel -1',{...chord,notes:[{key:60,velocity:90,channel:-1}]}],
  ])('refuses %s',(_name,payload)=>{expect(parseChordEvent(payload)).toBeNull();});
});

describe('parseStatusEvent',()=>{
  const status={seq:3,session:2,state:'running',port:'USB MIDI',message:''};
  it('accepts every state and refuses an unknown one',()=>{
    for(const state of ['running','stopped','lost','error'])expect(parseStatusEvent({...status,state})).toEqual({...status,state});
    expect(parseStatusEvent({...status,state:'weird'})).toBeNull();
  });
  it.each([
    ['null',null],['an array',[status]],['a negative session',{...status,session:-1}],['a fractional session',{...status,session:0.5}],
    ['no sequence number',{...status,seq:undefined}],['a zero sequence number',{...status,seq:0}],['a fractional sequence number',{...status,seq:1.5}],
    ['a numeric port',{...status,port:3}],['a missing message',{...status,message:undefined}],
  ])('refuses %s',(_name,payload)=>{expect(parseStatusEvent(payload)).toBeNull();});
  it('shortens an oversized message and refuses an oversized port',()=>{
    expect(parseStatusEvent({...status,message:'x'.repeat(5000)})?.message.length).toBeLessThanOrEqual(500);
    expect(parseStatusEvent({...status,port:'p'.repeat(300)})).toBeNull();
  });
});

describe('the native bridge',()=>{
  it('calls the commands by name with the arguments they take',async()=>{
    native.invoke.mockResolvedValue(undefined);
    const settings={chordWindowMs:60,minVelocity:1};
    await nativeMidiIn.ports();await nativeMidiIn.start('USB MIDI',settings);await nativeMidiIn.configure(2,settings);
    await nativeMidiIn.stop(2);await nativeMidiIn.stop();await nativeMidiIn.status();
    expect(native.invoke.mock.calls).toEqual([
      ['midi_in_ports'],['midi_in_start',{port:'USB MIDI',settings}],['midi_in_configure',{session:2,settings}],
      ['midi_in_stop',{session:2}],['midi_in_stop',{session:null}],['midi_in_status'],
    ]);
  });
  it('listens to both events, hands on only well-formed payloads, and unlistens both',async()=>{
    const handlers=new Map<string,(event:{payload:unknown})=>void>();const unlisten=vi.fn();
    native.listen.mockImplementation(async(name:string,handler:(event:{payload:unknown})=>void)=>{handlers.set(name,handler);return unlisten;});
    const chords:MidiChord[]=[],statuses:unknown[]=[];
    const stop=await nativeMidiIn.subscribe(c=>chords.push(c),s=>statuses.push(s));
    expect([...handlers.keys()].sort()).toEqual(['midi-in-chord','midi-in-status']);
    handlers.get('midi-in-chord')!({payload:chord});handlers.get('midi-in-chord')!({payload:{...chord,notes:[]}});handlers.get('midi-in-chord')!({payload:'junk'});
    handlers.get('midi-in-status')!({payload:{seq:5,session:2,state:'lost',port:'p',message:'m'}});handlers.get('midi-in-status')!({payload:{state:'lost'}});
    expect(chords).toEqual([chord]);expect(statuses).toEqual([{seq:5,session:2,state:'lost',port:'p',message:'m'}]);
    stop();expect(unlisten).toHaveBeenCalledTimes(2);
  });
  it('subscribeChords attaches the chord listener on its own',async()=>{
    const handlers=new Map<string,(event:{payload:unknown})=>void>();
    native.listen.mockImplementation(async(name:string,handler:(event:{payload:unknown})=>void)=>{handlers.set(name,handler);return vi.fn();});
    const seen:MidiChord[]=[];await subscribeChords(c=>seen.push(c));
    expect([...handlers.keys()]).toEqual(['midi-in-chord']);
    handlers.get('midi-in-chord')!({payload:chord});expect(seen).toEqual([chord]);
  });
});
