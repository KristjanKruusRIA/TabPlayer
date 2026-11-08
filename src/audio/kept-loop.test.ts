import {describe,expect,it} from 'vitest';
import type {BarIndexMap} from '../editor/measures-types';
import {keptLoopOf,mapKeptLoop,resolveKeptLoop} from './kept-loop';
import type {MeasureOccurrence} from './types';

const occ=(bar:number,occurrence:number,startTick:number,endTick=startTick+3840):MeasureOccurrence=>({bar,occurrence,meterNumerator:4,meterDenominator:4,startTick,endTick,startMs:0,endMs:0});
/** Four plain bars of 3840 ticks. */
const plain=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680),occ(3,0,11520)];
/** Bars 0,1,2 then 1,2 again (a repeat of bars 1 and 2), then 3. */
const repeated=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680),occ(1,1,11520),occ(2,1,15360),occ(3,0,19200)];
const insert=(count:number,beforeBar:number,at:number):BarIndexMap=>({oldToNew:Array.from({length:count},(_,bar)=>bar<beforeBar?bar:bar+at),inserted:Array.from({length:at},(_,i)=>beforeBar+i)});
const remove=(count:number,first:number,last:number):BarIndexMap=>({oldToNew:Array.from({length:count},(_,bar)=>bar<first?bar:bar<=last?null:bar-(last-first+1)),inserted:[]});

describe('keptLoopOf',()=>{
  it('names whole bars by bar and occurrence, with the end at the far edge of its last bar',()=>{
    expect(keptLoopOf({startTick:3840,endTick:11520},plain,4)).toEqual({start:{bar:1,occurrence:0,ratio:0},end:{bar:2,occurrence:0,ratio:1},barCount:4});
  });
  it('names a loop that begins and ends inside bars by the fraction of the bar',()=>{
    expect(keptLoopOf({startTick:3840+960,endTick:7680+2880},plain,4)).toEqual({start:{bar:1,occurrence:0,ratio:.25},end:{bar:2,occurrence:0,ratio:.75},barCount:4});
  });
  it('tells repeated passes of the same bar apart',()=>{
    expect(keptLoopOf({startTick:11520,endTick:19200},repeated,4)).toEqual({start:{bar:1,occurrence:1,ratio:0},end:{bar:2,occurrence:1,ratio:1},barCount:4});
  });
  it('gives nothing for a loop that is not on the plan',()=>{
    expect(keptLoopOf({startTick:99999,endTick:100000},plain,4)).toBeNull();
    expect(keptLoopOf({startTick:5,endTick:5},plain,4)).toBeNull();
  });
});

describe('resolveKeptLoop',()=>{
  const kept=keptLoopOf({startTick:3840,endTick:11520},plain,4)!;
  it('returns the same ticks for the same bars',()=>{
    expect(resolveKeptLoop(kept,plain,4)).toEqual({startTick:3840,endTick:11520});
  });
  it('follows the bars when an edit moves their ticks',()=>{
    const longer=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680,7680+3840+960),occ(3,0,12480)];
    expect(resolveKeptLoop(kept,longer,4)).toEqual({startTick:3840,endTick:12480});
  });
  it('keeps a partial bar edge at the same fraction of the bar',()=>{
    const partial=keptLoopOf({startTick:3840+960,endTick:7680+2880},plain,4)!;
    const longer=[occ(0,0,0),occ(1,0,3840,3840+1920),occ(2,0,5760,5760+3840),occ(3,0,9600)];
    expect(resolveKeptLoop(partial,longer,4)).toEqual({startTick:3840+480,endTick:5760+2880});
  });
  it('restores the pass of a repeated bar it was set on',()=>{
    const second=keptLoopOf({startTick:11520,endTick:19200},repeated,4)!;
    expect(resolveKeptLoop(second,repeated,4)).toEqual({startTick:11520,endTick:19200});
  });
  it('falls back to the only pass of a bar when the repeat is gone',()=>{
    const second=keptLoopOf({startTick:11520,endTick:19200},repeated,4)!;
    expect(resolveKeptLoop(second,plain,4)).toEqual({startTick:3840,endTick:11520});
  });
  it('refuses when a bar has several passes and the one it was set on is gone',()=>{
    const third={start:{bar:1,occurrence:2,ratio:0},end:{bar:2,occurrence:2,ratio:1},barCount:4};
    expect(resolveKeptLoop(third,repeated,4)).toBeNull();
  });
  it('refuses when the number of bars changed without a map',()=>{
    expect(resolveKeptLoop(kept,plain,5)).toBeNull();
  });
  it('refuses when a bar is gone or the range would be empty',()=>{
    expect(resolveKeptLoop(kept,plain.slice(0,2),4)).toBeNull();
    expect(resolveKeptLoop({...kept,end:{bar:1,occurrence:0,ratio:0}},plain,4)).toBeNull();
  });
});

describe('mapKeptLoop',()=>{
  const kept=keptLoopOf({startTick:3840,endTick:11520},plain,4)!;
  it('moves the bars when bars are inserted before the loop',()=>{
    expect(mapKeptLoop(kept,insert(4,0,2))).toEqual({start:{bar:3,occurrence:0,ratio:0},end:{bar:4,occurrence:0,ratio:1},barCount:6});
  });
  it('leaves the bars when bars are inserted after the loop',()=>{
    expect(mapKeptLoop(kept,insert(4,3,2))).toEqual({...kept,barCount:6});
  });
  it('grows the loop when bars are inserted inside it',()=>{
    expect(mapKeptLoop(kept,insert(4,2,1))).toEqual({start:{bar:1,occurrence:0,ratio:0},end:{bar:3,occurrence:0,ratio:1},barCount:5});
  });
  it('moves the bars back when earlier bars are removed',()=>{
    expect(mapKeptLoop(kept,remove(4,0,0))).toEqual({start:{bar:0,occurrence:0,ratio:0},end:{bar:1,occurrence:0,ratio:1},barCount:3});
  });
  it('trims the loop to the bars that remain when an end bar is removed',()=>{
    expect(mapKeptLoop(kept,remove(4,1,1))).toEqual({start:{bar:1,occurrence:null,ratio:0},end:{bar:1,occurrence:0,ratio:1},barCount:3});
    expect(mapKeptLoop(kept,remove(4,2,2))).toEqual({start:{bar:1,occurrence:0,ratio:0},end:{bar:1,occurrence:null,ratio:1},barCount:3});
  });
  it('gives nothing when every bar of the loop is removed',()=>{
    expect(mapKeptLoop(kept,remove(4,1,2))).toBeNull();
  });
  it('gives nothing when the map is for another number of bars',()=>{
    expect(mapKeptLoop(kept,insert(5,0,1))).toBeNull();
  });
  it('resolves a trimmed edge only where its bar plays once',()=>{
    const trimmed=mapKeptLoop(kept,remove(4,1,1))!;
    // Old bars 0,2,3 are now 0,1,2: the loop starts at bar 1, which plays once here.
    const after=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680)];
    expect(resolveKeptLoop(trimmed,after,3)).toEqual({startTick:3840,endTick:7680});
    const twice=[occ(0,0,0),occ(1,0,3840),occ(1,1,7680),occ(2,0,11520)];
    expect(resolveKeptLoop(trimmed,twice,3)).toBeNull();
  });
});
