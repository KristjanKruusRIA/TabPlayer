import { expect,it } from 'vitest';
import { music } from './fixtures';
import { gridTicks,moveRangeEnd } from './range-edge';
import { rangeEndFraction,validateMusicSelection } from './range-selection';
import { eraseCommandFor } from './range-cut';
import type { BeatRange } from './range-types';

const lanes=[{track:0,staff:0,voice:0}];
const range=(start:[number,number],end:[number,number]):BeatRange=>({start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes});
const moved=(result:ReturnType<typeof moveRangeEnd>)=>{if('refusal'in result)throw new Error(result.refusal);return result.range;};

it('the grid is the written length with its dots',()=>{
  expect([gridTicks(4,0),gridTicks(8,0),gridTicks(4,1),gridTicks(2,0),gridTicks(16,2)]).toEqual([960,480,1440,1920,420]);
});
it('moves the end by one grid step, into the middle of a beat, and back',()=>{
  const score=music(),one=moved(moveRangeEnd(score,range([0,0],[0,960]),480,1));
  expect(one.end).toEqual({bar:0,tick:1440});validateMusicSelection(score,{kind:'range',range:one});
  expect(rangeEndFraction(score,one)).toBe(.5);
  expect(moved(moveRangeEnd(score,one,480,-1)).end).toEqual({bar:0,tick:960});
  expect(rangeEndFraction(score,range([0,0],[0,960]))).toBeUndefined();
});
it('crossing a barline writes the bar end as the next bar start, and the score end stops the move',()=>{
  const score=music();
  expect(moved(moveRangeEnd(score,range([0,0],[0,2880]),960,1)).end).toEqual({bar:1,tick:0});
  expect(moved(moveRangeEnd(score,range([0,0],[0,3840]),480,1)).end).toEqual({bar:1,tick:480});
  const edge=moved(moveRangeEnd(score,range([0,0],[3,2880]),960,5)).end;expect(edge).toEqual({bar:3,tick:3840});
  expect(moved(moveRangeEnd(score,range([0,0],[3,3840]),960,1)).end).toEqual({bar:3,tick:3840});
});
it('never reaches the range start: a move that would is not made',()=>{
  const score=music(),same=range([0,960],[0,1440]);
  expect(moved(moveRangeEnd(score,same,480,-1))).toEqual(same);
  expect(moved(moveRangeEnd(score,same,960,-1))).toEqual(same);
});
it('a range touching a free-time bar is refused with its reason',()=>{
  const score=music();score.masterBars[1].isFreeTime=true;
  expect(moveRangeEnd(score,range([0,0],[0,3840]),480,1)).toEqual({refusal:'editor.range_edge_free_time'});
  expect(moveRangeEnd(score,range([0,0],[0,960]),480,1)).toHaveProperty('range');
});
it('erasing a range that ends inside a sounding beat is the splitting cut, a whole-beat range stays an erase',()=>{
  const score=music();
  expect(eraseCommandFor(score,{kind:'range',range:range([0,0],[0,1440])}).type).toBe('cutSelection');
  expect(eraseCommandFor(score,{kind:'range',range:range([0,0],[0,960])}).type).toBe('eraseSelection');
  expect(eraseCommandFor(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0}).type).toBe('eraseSelection');
});
import { rangeExtent } from './range-edge';
it('names a range by measure and beat, with a fraction between beats',()=>{
  const score=music();
  expect(rangeExtent(score,range([0,0],[1,1440]))).toEqual({startBar:1,startBeat:'1',endBar:2,endBeat:'2.5'});
  expect(rangeExtent(score,range([0,480],[0,2880]))).toEqual({startBar:1,startBeat:'1.5',endBar:1,endBeat:'4'});
});
