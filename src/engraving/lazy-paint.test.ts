import { describe,expect,it } from 'vitest';
import { visiblePartials,type LayoutPartial } from './lazy-paint';

const column=(count:number,height:number):LayoutPartial[]=>Array.from({length:count},(_,index)=>({id:`p${index}`,x:0,y:index*height,width:800,height}));

describe('visiblePartials',()=>{
  it('picks the systems that touch the score area and nothing else',()=>{
    const pieces=column(20,200);
    expect(visiblePartials(pieces,{left:0,top:0},{left:0,top:0,right:800,bottom:500})).toEqual(['p0','p1','p2']);
    expect(visiblePartials(pieces,{left:0,top:0},{left:0,top:1000,right:800,bottom:1300})).toEqual(['p5','p6']);
  });
  it('follows the canvas when the page is scrolled or centred',()=>{
    const pieces=column(10,100);
    // The canvas starts 450 px above the area: the area shows canvas rows 450 to 750.
    expect(visiblePartials(pieces,{left:0,top:-450},{left:0,top:0,right:800,bottom:300})).toEqual(['p4','p5','p6','p7']);
    expect(visiblePartials(pieces,{left:300,top:0},{left:0,top:0,right:200,bottom:300})).toEqual([]);
  });
  it('widens by a margin and skips empty pieces',()=>{
    const pieces=[...column(6,100),{id:'flat',x:0,y:150,width:800,height:0}];
    expect(visiblePartials(pieces,{left:0,top:0},{left:0,top:200,right:800,bottom:300},0)).toEqual(['p2']);
    expect(visiblePartials(pieces,{left:0,top:0},{left:0,top:200,right:800,bottom:300},101)).toEqual(['p0','p1','p2','p3','p4']);
  });
  it('finds the columns of a horizontal layout',()=>{
    const pieces:LayoutPartial[]=Array.from({length:6},(_,index)=>({id:`c${index}`,x:index*300,y:0,width:300,height:400}));
    expect(visiblePartials(pieces,{left:-450,top:0},{left:0,top:0,right:600,bottom:400})).toEqual(['c1','c2','c3']);
  });
});
