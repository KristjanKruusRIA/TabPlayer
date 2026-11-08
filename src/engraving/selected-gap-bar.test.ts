import { expect,it } from 'vitest';
import { selectedGapBar } from './selected-gap-bar';
import type { MusicSelection } from '../editor/range-types';

const lane={track:0,staff:0,voice:0};
it('uses the caret bar without a selection',()=>{expect(selectedGapBar(null,7)).toBe(7);});
it('uses the start of a range',()=>{expect(selectedGapBar({kind:'range',range:{start:{bar:3,tick:0},end:{bar:9,tick:0},lanes:[lane]}},7)).toBe(3);});
it('uses the first bar of a bar selection',()=>{expect(selectedGapBar({kind:'bars',tracks:[0],firstBar:4,lastBar:8},7)).toBe(4);});
it('uses the lowest bar among selected notes',()=>{
  const note=(bar:number)=>({target:{track:0,staff:0,bar,voice:0,beat:0},noteIndex:0});
  expect(selectedGapBar({kind:'notes',notes:[note(6),note(2),note(5)]} as MusicSelection,7)).toBe(2);
});
it('falls back to the caret bar when no note is selected',()=>{expect(selectedGapBar({kind:'notes',notes:[]},7)).toBe(7);});
