import {expect,it} from 'vitest';
import {barMapOfEdit,barMapOfUndo} from './edit-bar-map';

const ids=(count:number)=>Array.from({length:count},(_,bar)=>bar);
it('maps the bars an edit moved',()=>{
  expect(barMapOfEdit({type:'insertMeasures',beforeBar:1,count:2},3)).toEqual({oldToNew:[0,3,4],inserted:[1,2]});
  expect(barMapOfEdit({type:'removeMeasures',firstBar:1,lastBar:2},5)).toEqual({oldToNew:[0,null,null,1,2],inserted:[]});
  expect(barMapOfEdit({type:'appendMeasure'},3)).toEqual({oldToNew:ids(3),inserted:[3]});
  expect(barMapOfEdit({type:'removeMeasure',bar:1},4)).toEqual({oldToNew:[0,null,1,2],inserted:[]});
});
it('maps the bars an undo moves back, from the bar count the undo starts at',()=>{
  expect(barMapOfUndo({type:'insertMeasures',beforeBar:1,count:2},5)).toEqual({oldToNew:[0,null,null,1,2],inserted:[]});
  expect(barMapOfUndo({type:'removeMeasures',firstBar:1,lastBar:2},3)).toEqual({oldToNew:[0,3,4],inserted:[1,2]});
  expect(barMapOfUndo({type:'appendMeasure'},4)).toEqual({oldToNew:[0,1,2,null],inserted:[]});
  expect(barMapOfUndo({type:'removeMeasure',bar:1},3)).toEqual({oldToNew:[0,2,3],inserted:[1]});
});
it('says nothing for edits that leave the bars where they are, or that cannot be traced',()=>{
  expect(barMapOfEdit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7},3)).toBeNull();
  expect(barMapOfUndo({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7},3)).toBeNull();
  expect(barMapOfEdit({type:'removeMeasures',firstBar:0,lastBar:2},3)).toBeNull();
  expect(barMapOfUndo({type:'appendMeasure'},1)).toBeNull();
});
