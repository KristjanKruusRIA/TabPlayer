import { describe,expect,it } from 'vitest';
import { DEFAULT_MIDI_CAPTURE,MIDI_CAPTURE_KEY,readMidiCapturePreferences,saveMidiCapturePreferences } from './midi-capture-preferences';

const memory=(initial?:string)=>{let value=initial;const writes:string[]=[];return {getItem:()=>value??null,setItem:(_key:string,next:string)=>{value=next;writes.push(next);},value:()=>value,writes};};

describe('MIDI capture preferences',()=>{
  it('default to a 60 ms window, a floor of 1, no mapping and no port',()=>{
    expect(DEFAULT_MIDI_CAPTURE).toEqual({port:'',chordWindowMs:60,minVelocity:1,stringMapping:'off'});
    const storage=memory();
    expect(readMidiCapturePreferences(storage)).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(storage.writes).toEqual([]);
  });
  it('round-trip what was saved',()=>{
    const storage=memory(),saved={port:'USB MIDI',chordWindowMs:120,minVelocity:30,stringMapping:'lowestFirst' as const};
    saveMidiCapturePreferences(saved,storage);
    expect(readMidiCapturePreferences(storage)).toEqual(saved);
  });
  it('repair each field on its own, clamp the numbers, and write the repaired value back',()=>{
    const storage=memory(JSON.stringify({port:'Keys',chordWindowMs:9000,minVelocity:-4,stringMapping:'sideways'}));
    expect(readMidiCapturePreferences(storage)).toEqual({port:'Keys',chordWindowMs:500,minVelocity:1,stringMapping:'off'});
    expect(JSON.parse(storage.value()!)).toEqual({port:'Keys',chordWindowMs:500,minVelocity:1,stringMapping:'off'});
    expect(readMidiCapturePreferences(memory(JSON.stringify({chordWindowMs:3,minVelocity:300})))).toMatchObject({chordWindowMs:10,minVelocity:127});
    expect(readMidiCapturePreferences(memory(JSON.stringify({chordWindowMs:'80',minVelocity:null,port:7})))).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(readMidiCapturePreferences(memory(JSON.stringify({chordWindowMs:62.6}))).chordWindowMs).toBe(63);
  });
  it('do not rewrite a value that needed no repair',()=>{
    const storage=memory();saveMidiCapturePreferences({...DEFAULT_MIDI_CAPTURE,port:'Keys'},storage);storage.writes.length=0;
    readMidiCapturePreferences(storage);expect(storage.writes).toEqual([]);
  });
  it('fall back to the defaults for unreadable, hostile or unavailable storage',()=>{
    expect(readMidiCapturePreferences(memory('{not json'))).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(readMidiCapturePreferences(memory('[1,2]'))).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(readMidiCapturePreferences(memory('null'))).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(readMidiCapturePreferences(memory(JSON.stringify({port:'p'.repeat(1000)}))).port).toBe('');
    expect(readMidiCapturePreferences(undefined)).toEqual(DEFAULT_MIDI_CAPTURE);
    const throwing={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('full');}};
    expect(readMidiCapturePreferences(throwing)).toEqual(DEFAULT_MIDI_CAPTURE);
    expect(()=>saveMidiCapturePreferences(DEFAULT_MIDI_CAPTURE,throwing)).not.toThrow();
  });
  it('keep nothing but the port name and the three settings',()=>{
    const storage=memory();saveMidiCapturePreferences({...DEFAULT_MIDI_CAPTURE,port:'Keys'},storage);
    expect(Object.keys(JSON.parse(storage.value()!)).sort()).toEqual(['chordWindowMs','minVelocity','port','stringMapping']);
    expect(MIDI_CAPTURE_KEY).toBe('tabplayer.midiCapture');
  });
});
