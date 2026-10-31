import { expect, it } from 'vitest';
import { exporter, importer, midi, model, Settings } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { applyDirectionEdit } from './directions';
import { music, reopened } from './fixtures';

function gpReopened(score:model.Score) {return importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,new Settings()),new Settings());}
function itinerary(score:model.Score) {
  score.finish(new Settings());const generator=new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(new midi.MidiFile()));
  generator.generate();return generator.tickLookup.masterBars.map(bar=>bar.masterBar.index);
}

it.each(Array.from({length:19},(_,value)=>value))('direction %i survives native and public GP roundtrip',direction=>{
  const score=music();expect(applyDirectionEdit(score,{type:'setDirections',bar:2,directions:[direction]})).toBe(true);
  for(const copy of [score,reopened(score),gpReopened(score)])expect([...copy.masterBars[2].directions!]).toEqual([direction]);
});

it('replaces direction sets, normalizes duplicates and clears the set',()=>{
  const score=music();applyDirectionEdit(score,{type:'setDirections',bar:1,directions:[1,0,1]});expect([...score.masterBars[1].directions!]).toEqual([1,0]);
  applyDirectionEdit(score,{type:'setDirections',bar:1,directions:[3]});expect([...score.masterBars[1].directions!]).toEqual([3]);
  applyDirectionEdit(score,{type:'setDirections',bar:1,directions:[]});expect(score.masterBars[1].directions).toBeNull();
});

it.each([{bar:-1,directions:[0]},{bar:4,directions:[0]},{bar:0.5,directions:[0]},{bar:0,directions:[1,19]},{bar:0,directions:[-1]},{bar:0,directions:[1.5]},{bar:0,directions:['0']},{bar:0,directions:null}])('invalid directions reject atomically: %j',invalid=>{
  const score=music();score.masterBars[0].directions=new Set([model.Direction.TargetFine]);
  expect(()=>applyDirectionEdit(score,{type:'setDirections',...invalid} as unknown as EditCommand)).toThrow(/direction|measure/i);
  expect([...score.masterBars[0].directions!]).toEqual([0]);
});

it.each([
  ['D.C.',[[3,5]],[0,1,2,3,0,1,2,3]],
  ['D.S.',[[1,1],[3,9]],[0,1,2,3,1,2,3]],
  ['D.C. al Fine',[[1,0],[3,8]],[0,1,2,3,0,1]],
  ['D.S. al Fine',[[1,1],[2,0],[3,12]],[0,1,2,3,1,2]],
  ['D.C. al Coda',[[1,17],[2,6],[3,3]],[0,1,2,0,1,3]],
  ['D.S. al Coda',[[0,1],[1,17],[2,10],[3,3]],[0,1,2,0,1,3]],
  ['D.S.S. al Double Coda',[[0,2],[1,18],[2,15],[3,4]],[0,1,2,0,1,3]],
] as const)('%s directions control performed bars before and after GP roundtrip',(_name,placements,expected)=>{
  const score=music();for(const [bar,direction] of placements)applyDirectionEdit(score,{type:'setDirections',bar,directions:[direction]});
  expect(itinerary(score)).toEqual(expected);expect(itinerary(gpReopened(score))).toEqual(expected);
});

it('documents the upstream pickup/D.C. gap without claiming the GP8 itinerary',()=>{
  const score=music();score.masterBars[0].isAnacrusis=true;applyDirectionEdit(score,{type:'setDirections',bar:3,directions:[5]});
  expect(itinerary(score)).toEqual([0,1,2,3,0,1,2,3]);
});

it('leaves commands owned by another router untouched',()=>{expect(applyDirectionEdit(music(),{type:'appendMeasure'})).toBe(false);});
