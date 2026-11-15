import { expect, it } from 'vitest';
import { sameData } from './same-data';

it('compares plain data by value',()=>{
  expect(sameData({a:[1,{b:2}],c:null},{a:[1,{b:2}],c:null})).toBe(true);
  expect(sameData({a:[1,{b:2}]},{a:[1,{b:3}]})).toBe(false);
  expect(sameData([1,2],[1,2,3])).toBe(false);
  expect(sameData({a:1},{a:1,b:undefined})).toBe(false);
  expect(sameData(NaN,NaN)).toBe(true);
});
it('does not take two different Maps or Sets for equal',()=>{
  expect(sameData(new Map([['a',1]]),new Map([['a',2]]))).toBe(false);
  expect(sameData(new Map([['a',{x:1}]]),new Map([['a',{x:1}]]))).toBe(true);
  expect(sameData(new Map([['a',1]]),new Map([['b',1]]))).toBe(false);
  expect(sameData(new Set([1,2]),new Set([1,3]))).toBe(false);
  expect(sameData(new Set([1,2]),new Set([2,1]))).toBe(true);
  expect(sameData(new Map(),{})).toBe(false);
  expect(sameData(new Set(),[])).toBe(false);
});
