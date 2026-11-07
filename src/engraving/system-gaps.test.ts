// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { buildDocument,previewEdit,replayDocumentSettings } from '../engine';
import { blankProject } from '../project';
import { mapEngravingBars,withBarWidths } from './bar-widths';
import { defaultEngraving,validateEngraving } from './projection';
import { defaultStyle,styleApplied,styleOf } from './style-library';
import { mapSystemGaps,resetAllSystemGaps,resetSystemGap,resolveSystemGaps,setSystemGap,validateSystemGaps,withSystemGaps } from './system-gaps';
import type { EngravingOverrides } from './types';

const gaps=(...entries:Array<[number,number]>):EngravingOverrides=>withSystemGaps(defaultEngraving(),entries.map(([bar,scale])=>({bar,scale})));
const systems=[{first:0,last:3},{first:4,last:7},{first:8,last:9}];

it('accepts only ordered, bounded gaps and keeps old shapes valid',()=>{
  validateEngraving(defaultEngraving());validateEngraving(gaps([0,1.5],[1,1],[3,.25],[99_999,4]));validateEngraving({...defaultEngraving(),systemGaps:[]});
  for(const bad of [[{bar:1,scale:.24}],[{bar:1,scale:4.01}],[{bar:1,scale:0}],[{bar:1,scale:Number.NaN}],[{bar:1,scale:'2'}],[{bar:-1,scale:2}],[{bar:1.5,scale:2}],[{bar:100_000,scale:2}],[{bar:2,scale:2},{bar:1,scale:2}],[{bar:2,scale:2},{bar:2,scale:3}],[{bar:1}],[{bar:1,scale:2,extra:true}],[null],{bar:1,scale:2},null])
    expect(()=>validateEngraving({...defaultEngraving(),systemGaps:bad}),JSON.stringify(bad)).toThrow();
  expect(()=>validateSystemGaps(Array.from({length:10_001},(_,bar)=>({bar,scale:2})))).toThrow();
  expect(()=>validateSystemGaps(Array.from({length:10_000},(_,bar)=>({bar,scale:2})))).not.toThrow();
  expect(Object.hasOwn(defaultEngraving(),'systemGaps')).toBe(false);
  expect(Object.hasOwn(withSystemGaps(gaps([1,2]),[]),'systemGaps')).toBe(false);
});

it('resolves an entry to the system containing it, lowest anchor first, ignoring strays',()=>{
  const map=resolveSystemGaps([{bar:2,scale:2},{bar:3,scale:3},{bar:5,scale:.5},{bar:50,scale:4}],systems);
  expect([...map]).toEqual([[0,2],[4,.5]]);
  expect(resolveSystemGaps(undefined,systems).size).toBe(0);
});

it('sets, resets and resets all, returning the same object when nothing changes',()=>{
  const base=defaultEngraving();
  expect(setSystemGap(base,systems[1],1)).toBe(base);
  expect(setSystemGap(base,systems[1],1+1e-10)).toBe(base);
  const one=setSystemGap(base,systems[1],1.5);
  expect(one.systemGaps).toEqual([{bar:4,scale:1.5}]);
  expect(setSystemGap(one,systems[1],1.5)).toBe(one);
  // A new value replaces the system's other entries and leaves other systems alone.
  const crowded=gaps([0,2],[5,2],[6,3],[9,.5]);
  expect(setSystemGap(crowded,systems[1],1.25).systemGaps).toEqual([{bar:0,scale:2},{bar:4,scale:1.25},{bar:9,scale:.5}]);
  expect(setSystemGap(crowded,systems[1],1).systemGaps).toEqual([{bar:0,scale:2},{bar:9,scale:.5}]);
  expect(resetSystemGap(base,systems[1])).toBe(base);
  expect(resetSystemGap(crowded,systems[2]).systemGaps).toEqual([{bar:0,scale:2},{bar:5,scale:2},{bar:6,scale:3}]);
  expect(resetSystemGap(gaps([5,2]),systems[1])).toEqual(base);
  expect(resetAllSystemGaps(base)).toBe(base);
  expect(resetAllSystemGaps(crowded)).toEqual(base);
  expect(()=>setSystemGap(base,systems[0],5)).toThrow();
});

it('remaps anchors on insert and remove, dropping a removed anchor, together with bar widths',()=>{
  const base=gaps([2,2],[5,.5]);
  expect(mapSystemGaps(defaultEngraving(),[0,1])).toEqual(defaultEngraving());
  const insert=[0,1,3,4,5,6,7,8];
  expect(mapSystemGaps(base,insert).systemGaps).toEqual([{bar:3,scale:2},{bar:6,scale:.5}]);
  const removeTwo=[0,1,null,2,3,4,5,6];
  expect(mapSystemGaps(base,removeTwo).systemGaps).toEqual([{bar:4,scale:.5}]);
  expect(mapSystemGaps(base,[0,1,2,3,4,5])).toBe(base);
  const both=withBarWidths(base,[{bar:2,scale:2}]);
  const mapped=mapEngravingBars(both,insert);
  expect(mapped.systemGaps).toEqual([{bar:3,scale:2},{bar:6,scale:.5}]);
  expect(mapped.barWidths).toEqual([{bar:3,scale:2}]);
  expect(mapEngravingBars(both,[0,1,2,3,4,5])).toBe(both);
});

it('replays an old log without the field and a style neither carries nor clears gaps',()=>{
  const old=previewEdit(blankProject(),{type:'setEngraving',engraving:defaultEngraving()}).project;
  const built=buildDocument(old);
  expect(Object.hasOwn(replayDocumentSettings(old,built).settings.engraving,'systemGaps')).toBe(false);
  const current=gaps([4,2]);
  expect(Object.hasOwn(styleOf(current),'systemGaps')).toBe(false);
  const applied=styleApplied(defaultStyle(),current);
  expect(applied.systemGaps).toEqual([{bar:4,scale:2}]);
  expect(Object.hasOwn(styleApplied(defaultStyle(),defaultEngraving()),'systemGaps')).toBe(false);
});
