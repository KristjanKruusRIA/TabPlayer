import { expect, it } from 'vitest';
import { formatPitch, formatTuning, parseTuning } from './tuning';

it('roundtrips every MIDI pitch through canonical sharp note names and octaves',()=>{
  for(let pitch=0;pitch<128;pitch++)expect(parseTuning(formatPitch(pitch))).toEqual([pitch]);
  expect(formatPitch(0)).toBe('C-1');expect(formatPitch(127)).toBe('G9');expect(formatPitch(61)).toBe('C#4');
  expect(formatTuning([64,59,55,50,45,40])).toBe('E4 B3 G3 D3 A2 E2');
});
it('accepts sharp flat and natural names with octaves and preserves high-to-low order',()=>{
  expect(parseTuning('E4 B3 G3 D3 A2 E2')).toEqual([64,59,55,50,45,40]);
  expect(parseTuning('C#4, Db4, c♯4 d♭4 B#3 Cb4')).toEqual([61,61,61,61,60,59]);
  expect(parseTuning(' G2, D2 A1, E1 ')).toEqual([43,38,33,28]);
});
it.each(['','E','H4','64,59','E4 nope','C-2','G#9','A10','E4 1.5','C##4'])('rejects invalid tuning %j with an actionable note-name error',text=>{
  expect(()=>parseTuning(text)).toThrow(/note|octave|C-1|G9/i);
});
