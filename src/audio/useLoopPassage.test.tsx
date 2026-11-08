// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {renderHook} from '@testing-library/react';
import {useLoopPassage} from './useLoopPassage';
import type {MeasureOccurrence} from './types';

const occ=(bar:number)=>({bar,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:bar*3840,endTick:(bar+1)*3840,startMs:0,endMs:0}) as MeasureOccurrence;
const plan=[0,1,2,3].map(occ);

describe('useLoopPassage',()=>{
  it('places a loop set while the controller still reports no occurrences once they arrive, on the same loop',()=>{
    let occurrences:readonly MeasureOccurrence[]=[];
    const player={playbackOccurrences:()=>occurrences};
    const {result,rerender}=renderHook(({loop})=>useLoopPassage(player,{loop}),{initialProps:{loop:{startTick:3840,endTick:11520}}});
    expect(result.current).toBeNull();
    occurrences=plan;
    rerender({loop:{startTick:3840,endTick:11520}});
    expect(result.current?.bars.map(bar=>bar.bar)).toEqual([1,2]);
  });
  it('keeps the same passage object while a tick hands over an equal loop, and the plan is the same',()=>{
    const player={playbackOccurrences:()=>plan};
    const {result,rerender}=renderHook(({loop})=>useLoopPassage(player,{loop}),{initialProps:{loop:{startTick:0,endTick:3840}}});
    const first=result.current;expect(first).not.toBeNull();
    rerender({loop:{startTick:0,endTick:3840}});
    expect(result.current).toBe(first);
    rerender({loop:{startTick:0,endTick:7680}});
    expect(result.current).not.toBe(first);expect(result.current?.last).toBe(1);
  });
  it('is null without a loop or a player',()=>{
    expect(renderHook(()=>useLoopPassage(null,{loop:{startTick:0,endTick:3840}})).result.current).toBeNull();
    expect(renderHook(()=>useLoopPassage({playbackOccurrences:()=>plan},{loop:null})).result.current).toBeNull();
  });
});
