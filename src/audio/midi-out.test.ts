import {beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultMix,validateMix,validMidiPortName} from '../document-settings';
import {nativeMidiOut} from './midi-out';

const nativeInvoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:nativeInvoke}));

describe('MIDI output bridge',()=>{
  beforeEach(()=>nativeInvoke.mockReset());
  it('calls the native commands with their arguments',async()=>{
    nativeInvoke.mockResolvedValue([]);
    await nativeMidiOut.ports();
    await nativeMidiOut.ports({documentId:'d',activationId:'a'});
    await nativeMidiOut.setDelay(120);
    await nativeMidiOut.status();
    await nativeMidiOut.testLog();
    expect(nativeInvoke.mock.calls).toEqual([['midi_out_ports',{owner:null}],['midi_out_ports',{owner:{documentId:'d',activationId:'a'}}],['midi_out_set_delay',{ms:120}],['midi_out_status'],['midi_out_test_log']]);
  });
});

describe('a track mix that names a MIDI port',()=>{
  it('accepts a name and an absent port, and refuses what the native side refuses',()=>{
    expect(()=>validateMix({...defaultMix(),midiPort:'Microsoft GS Wavetable Synth'})).not.toThrow();
    expect(()=>validateMix(defaultMix())).not.toThrow();
    for(const bad of ['','x'.repeat(257),'line\nbreak','tab\there','nul\0','del\u007f','c1\u0085','rlo‮name','zero​width','bom﻿','isolate⁦x','soft­hyphen','tag\u{e0041}',null,3])
      expect(()=>validateMix({...defaultMix(),midiPort:bad as never}),JSON.stringify(bad)).toThrow();
    expect(validMidiPortName('x'.repeat(256))).toBe(true);
    expect(validMidiPortName('Port 1 äö')).toBe(true);
  });
});
