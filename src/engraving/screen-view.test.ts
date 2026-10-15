import { expect,it } from 'vitest';
import { isPhysicalPageLayout,repairScoreDisplay,resolveScoreDisplay,type ScoreLayoutMode,type ScoreZoomMode } from './screen-view';

const layouts:ScoreLayoutMode[]=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'];
const policies:ScoreZoomMode[]=['manual','fitWidth','fitPage'];
const pairs=layouts.flatMap(layout=>policies.map(zoomMode=>({layout,zoomMode})));

it.each(pairs)('repairs and resolves $layout / $zoomMode',value=>{
  const zoomMode=value.zoomMode==='fitPage'&&['parchment','verticalScreen','horizontalScreen'].includes(value.layout)?'fitWidth':value.zoomMode;
  const expected={layout:value.layout,zoomMode};
  expect(repairScoreDisplay(value)).toEqual(expected);
  expect(resolveScoreDisplay(value)).toEqual(expected);
  expect(repairScoreDisplay(value)).not.toBe(value);
  expect(resolveScoreDisplay(value)).not.toBe(value);
});

it.each([
  ['verticalPage',true],['horizontalPage',true],['grid',true],
  ['parchment',false],['verticalScreen',false],['horizontalScreen',false],
] as const)('classifies %s physical page applicability',(layout,expected)=>expect(isPhysicalPageLayout(layout)).toBe(expected));

const invalid:unknown[]=[
  undefined,null,[],['grid','fitPage'],true,0,'grid',{},
  {layout:'grid'},{zoomMode:'manual'},
  {layout:'grid',zoomMode:'manual',extra:true},
  {layout:'GRID',zoomMode:'manual'},{layout:'unknown',zoomMode:'manual'},
  {layout:1,zoomMode:'manual'},{layout:'grid',zoomMode:'Manual'},
  {layout:'grid',zoomMode:'unknown'},{layout:'grid',zoomMode:1},
  {layout:null,zoomMode:'manual'},{layout:'grid',zoomMode:undefined},
  Object.create({layout:'grid',zoomMode:'manual'}),
  Object.assign(Object.create({layout:'grid'}),{zoomMode:'manual'}),
  Object.defineProperty({layout:'grid',zoomMode:'manual'},'extra',{value:true}),
  {layout:'grid',zoomMode:'manual',[Symbol('extra')]:true},
];
it.each(invalid.map((value,index)=>({value,index})))('drops malformed preference $index and resolves a fresh default',({value})=>{
  expect(repairScoreDisplay(value)).toBeUndefined();
  const first=resolveScoreDisplay(value),second=resolveScoreDisplay(value);
  expect(first).toEqual({layout:'parchment',zoomMode:'manual'});
  expect(second).toEqual({layout:'parchment',zoomMode:'manual'});
  expect(first).not.toBe(second);
  first.layout='grid';expect(resolveScoreDisplay(value)).toEqual({layout:'parchment',zoomMode:'manual'});
});

it('does not mutate a frozen endless preference when repairing fit page',()=>{
  const supplied=Object.freeze({layout:'parchment',zoomMode:'fitPage'});
  expect(resolveScoreDisplay(supplied)).toEqual({layout:'parchment',zoomMode:'fitWidth'});
  expect(supplied).toEqual({layout:'parchment',zoomMode:'fitPage'});
});
