import {expect,it} from 'vitest';
import {automaticVoice} from './sound-model';

/** The same table as `automatic_voice_id` in src-tauri/src/audio/voices.rs; if the native rule changes, change both. */
it('picks the source Automatic plays by the General MIDI program, as the native player does',()=>{
  const expected:[number,string][]=[[0,'gm'],[23,'gm'],[24,'green-guitar'],[25,'green-guitar'],[26,'black-guitar'],[29,'black-guitar'],[31,'black-guitar'],[32,'darkblack-bass'],[33,'babyblue-bass'],[34,'darkblack-bass'],[39,'darkblack-bass'],[40,'gm'],[127,'gm']];
  for(const [program,voice] of expected)expect(automaticVoice(program,false)).toBe(voice);
  for(const program of [0,29,33])expect(automaticVoice(program,true)).toBe('gm');
});
