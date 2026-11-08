import {describe,expect,it} from 'vitest';
import {loopFractions,loopPassage,loopRunsOf,loopText} from './loop-passage';
import type {MeasureOccurrence} from './types';

const occ=(bar:number,occurrence:number,startTick:number,endTick=startTick+3840):MeasureOccurrence=>({bar,occurrence,meterNumerator:4,meterDenominator:4,startTick,endTick,startMs:0,endMs:0});
const plain=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680),occ(3,0,11520)];
/** Bars 0,1,2 then 1,2 again (a repeat of bars 1 and 2), then 3. */
const repeated=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680),occ(1,1,11520),occ(2,1,15360),occ(3,0,19200)];

describe('loopPassage',()=>{
  it('lists the bars of a whole-bar loop, each as played from its start to its end',()=>{
    const passage=loopPassage({startTick:3840,endTick:11520},plain)!;
    expect(passage.first).toBe(1);expect(passage.last).toBe(2);
    expect(passage.bars).toEqual([{bar:1,from:0,to:3840,length:3840},{bar:2,from:0,to:3840,length:3840}]);
  });
  it('keeps the ticks into the bar where a loop begins and ends inside bars',()=>{
    const passage=loopPassage({startTick:3840+960,endTick:7680+2880},plain)!;
    expect(passage.bars).toEqual([{bar:1,from:960,to:3840,length:3840},{bar:2,from:0,to:2880,length:3840}]);
  });
  it('is one bar when the loop lies inside it',()=>{
    expect(loopPassage({startTick:3840+960,endTick:3840+1920},plain)!.bars).toEqual([{bar:1,from:960,to:1920,length:3840}]);
  });
  it('covers each bar of a repeat once, whichever pass it was set on',()=>{
    const second=loopPassage({startTick:11520,endTick:19200},repeated)!;
    expect(second.bars.map(bar=>bar.bar)).toEqual([1,2]);
    const through=loopPassage({startTick:7680,endTick:19200+3840},repeated)!;
    expect(through.bars.map(bar=>bar.bar)).toEqual([1,2,3]);
    expect(through.first).toBe(1);expect(through.last).toBe(3);
  });
  it('draws a bar that is played whole in one pass and partly in another as whole',()=>{
    // From the middle of bar 1 on its first pass, through bar 2 and the whole repeat of bar 1.
    const passage=loopPassage({startTick:3840+1920,endTick:15360},repeated)!;
    expect(passage.bars.find(bar=>bar.bar===1)).toEqual({bar:1,from:0,to:3840,length:3840});
    expect(passage.bars.find(bar=>bar.bar===2)).toEqual({bar:2,from:0,to:3840,length:3840});
  });
  it('gives nothing without a loop, a plan, or a loop that is not on the plan',()=>{
    expect(loopPassage(null,plain)).toBeNull();
    expect(loopPassage({startTick:0,endTick:3840},[])).toBeNull();
    expect(loopPassage({startTick:5,endTick:5},plain)).toBeNull();
    expect(loopPassage({startTick:99999,endTick:100000},plain)).toBeNull();
  });
});

describe('loopRunsOf',()=>{
  it('joins neighbouring bars into runs',()=>{
    expect(loopRunsOf(loopPassage({startTick:3840,endTick:15360},plain.concat([occ(4,0,15360)]))!)).toEqual([{first:1,last:3}]);
  });
  it('breaks a run where the loop skips a bar',()=>{
    const skipping=[occ(0,0,0),occ(1,0,3840),occ(2,0,7680),occ(0,1,11520),occ(1,1,15360),occ(2,1,19200)];
    expect(loopRunsOf(loopPassage({startTick:7680,endTick:15360},skipping)!)).toEqual([{first:0,last:0},{first:2,last:2}]);
    const jump=[occ(0,0,0),occ(1,0,3840),occ(5,0,7680),occ(6,0,11520)];
    expect(loopRunsOf(loopPassage({startTick:3840,endTick:15360},jump)!)).toEqual([{first:1,last:1},{first:5,last:6}]);
  });
});

describe('loopText',()=>{
  it('is the first and last bar, one-based, or a single bar',()=>{
    expect(loopText(loopPassage({startTick:3840,endTick:11520},plain)!)).toEqual({first:2,last:3});
    expect(loopText(loopPassage({startTick:0,endTick:3840},plain)!)).toEqual({first:1,last:1});
  });
});

describe('loopFractions',()=>{
  const timed=[0,1,2,3].map(bar=>({...occ(bar,0,bar*3840),startMs:bar*2000,endMs:(bar+1)*2000}));
  it('places the loop along the plan by its own clock',()=>{
    expect(loopFractions({startTick:3840,endTick:11520},timed)).toEqual({from:.25,to:.75});
    expect(loopFractions({startTick:3840+1920,endTick:7680},timed)).toEqual({from:.375,to:.5});
  });
  it('gives nothing for no loop, no plan, or a plan without time',()=>{
    expect(loopFractions(null,timed)).toBeNull();
    expect(loopFractions({startTick:0,endTick:3840},[])).toBeNull();
    expect(loopFractions({startTick:0,endTick:3840},plain)).toBeNull();
  });
});
