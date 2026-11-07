// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { Settings } from '@coderline/alphatab';
import { accoladeMetrics,accoladeSvg,BRACE_MAX_X_SCALE,systemAccoladeMarks,type AccoladePlan } from './accolades';
import { composeSystem,composeSystemSvg,shiftTotal,shiftY,staffLeftOf,staffShift,systemTrackBands,TRACK_STAFF_PADDING,unshiftY } from './staff-layout';
import type { ScreenSystem } from './screen-pages';

type Row={track:number;staff:number;y:number;h:number};
/** One master bar whose BarBounds carry the staff and track indices; the staff's left edge is x = 60. */
function fakeSystem(rows:Row[]):ScreenSystem {
  const bars=rows.map(row=>({realBounds:{x:60,y:row.y,w:300,h:row.h},bar:{staff:{index:row.staff,track:{index:row.track}}}}));
  return {bars:[{realBounds:{x:60,y:Math.min(...rows.map(row=>row.y)),w:300,h:10},bars}]} as unknown as ScreenSystem;
}
const system=fakeSystem([{track:0,staff:0,y:100,h:60},{track:1,staff:0,y:200,h:40},{track:1,staff:1,y:260,h:40},{track:2,staff:0,y:340,h:40}]);
const bands=systemTrackBands(system);
const metrics=accoladeMetrics(new Settings());

interface Box {role:string;kind:string;x:number;width:number;top:number;bottom:number}
/** Reads every drawn mark back from its SVG: a bracket from its rect, a brace from its translate, font-size and optional x compression. */
function markBoxes(svg:string):Box[] {
  const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
  return [...doc.querySelectorAll('[data-tp-accolade]')].map(node=>{
    const [role,kind]=node.getAttribute('data-tp-accolade')!.split('-');
    if(kind==='bracket') {
      const rect=node.querySelector('rect')!,x=Number(rect.getAttribute('x')),y=Number(rect.getAttribute('y'));
      return {role,kind,x,width:Number(rect.getAttribute('width')),top:y,bottom:y+Number(rect.getAttribute('height'))};
    }
    const holder=node.querySelector('g')!,transform=holder.getAttribute('transform')!;
    const [, x, y]=/translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(transform)!.map(Number);
    const compress=/scale\(([-\d.e]+) 1\)/.exec(transform),xScale=compress?Number(compress[1]):1;
    const fontScale=Number(/font-size: ([-\d.e]+)%/.exec(node.querySelector('text')!.getAttribute('style')!)![1])/100;
    const factor=fontScale/metrics.scale;
    return {role,kind,x,width:metrics.brace.width*factor*xScale,top:y-metrics.brace.height*factor,bottom:y};
  });
}

describe('track bands',()=>{
  it('builds one band per track from realBounds with its visible staves',()=>expect(bands).toEqual([{track:0,top:100,bottom:160,staves:1},{track:1,top:200,bottom:300,staves:2},{track:2,top:340,bottom:380,staves:1}]));
  it('reads the staff left edge from the first master bar',()=>expect(staffLeftOf(system)).toBe(60));
});

describe('staff shift',()=>{
  it('shifts below a 200% boundary by the measured gap',()=>{
    const shift=staffShift(bands,new Map([[0,2]]),1)!;
    expect(shift).toEqual({cuts:[180],offsets:[40]});
    expect(shiftY(shift,150,'top')).toBe(150);expect(shiftY(shift,250,'top')).toBe(290);
    expect(shiftY(shift,180,'bottom')).toBe(180);expect(shiftY(shift,380,'bottom')).toBe(420);
    expect(unshiftY(shift,190)).toBeNull();expect(unshiftY(shift,290)).toBe(250);expect(shiftTotal(shift)).toBe(40);
  });
  it('treats a top at the cut as moved and a bottom at the cut as unmoved',()=>{
    const shift=staffShift(bands,new Map([[0,2]]),1)!;
    expect(shiftY(shift,180,'top')).toBe(220);expect(shiftY(shift,179.5,'top')).toBe(179.5);
    expect(shiftY(shift,180.5,'bottom')).toBe(220.5);
    expect(unshiftY(shift,179.9)).toBe(179.9);expect(unshiftY(shift,220)).toBe(180);expect(unshiftY(shift,219.9)).toBeNull();
  });
  it('never shrinks below touching, floors the base at the track padding, and the lower band wins an overlap',()=>{
    const shrink=staffShift(bands,new Map([[0,.25]]),1)!;expect(shrink.offsets).toEqual([-30]);
    expect(unshiftY(shrink,165)).toBe(195); // 165 is inside both moved bands; the lower band (moved up by 30) wins
    const tight=[{track:0,top:0,bottom:10,staves:1},{track:1,top:11,bottom:20,staves:1}];
    expect(staffShift(tight,new Map([[0,2]]),2)!.offsets).toEqual([10]);expect(staffShift(tight,new Map([[0,.25]]),2)!.offsets).toEqual([-1]);
    expect(TRACK_STAFF_PADDING).toBe(5);
  });
  it('sums the offsets of several boundaries and answers the null shift as identity',()=>{
    const shift=staffShift(bands,new Map([[0,2],[1,3]]),1)!;
    // Boundary 0: measured 40, offset 40. Boundary 1: measured 40, offset 80, cut at 320.
    expect(shift).toEqual({cuts:[180,320],offsets:[40,120]});
    expect(shiftY(shift,330,'top')).toBe(450);expect(shiftTotal(shift)).toBe(120);
    expect(shiftY(null,123,'top')).toBe(123);expect(shiftY(undefined,123,'bottom')).toBe(123);expect(unshiftY(null,123)).toBe(123);expect(shiftTotal(null)).toBe(0);
  });
  it('ignores the last track, absent tracks and 100%',()=>expect(staffShift(bands,new Map([[2,3],[0,1],[7,2]]),1)).toBeNull());
});

describe('compose a system SVG',()=>{
  it('returns the same SVG string with no shift and no marks',()=>{
    const svg='<svg width="500" height="400"><text>x</text></svg>';
    expect(composeSystemSvg({svg,id:'s0',left:0,top:0,width:500,height:400,shift:null,marks:[]}).svg).toBe(svg);
  });
  it('composes clipped, translated bands with the chunk-local cut and the new height',()=>{
    const out=composeSystemSvg({svg:'<svg width="500" height="400" viewBox="0 0 500 400"><rect y="20"/></svg>',id:'export-s4',left:0,top:100,width:500,height:400,shift:{cuts:[180],offsets:[40]},marks:[]});
    expect(out.height).toBe(440);expect(out.svg).toMatch(/^<svg\b[^>]*height="440"[^>]*viewBox="0 0 500 440"/);
    expect(out.svg.match(/<use\b/g)).toHaveLength(2);expect(out.svg).toContain('id="export-s4-content"');
    expect(out.svg).toContain('<rect x="0" y="80" width="500"');expect(out.svg).toContain('translate(0 40)');
  });
  it('clips the first band from -1 and the last to the height plus 1, and keeps the pixel unit of alphaTab roots',()=>{
    const out=composeSystemSvg({svg:'<svg xmlns="http://www.w3.org/2000/svg" width="500px" height="400px" class="at-surface-svg"><rect/></svg>',id:'c',left:0,top:0,width:500,height:400,shift:{cuts:[180],offsets:[-30]},marks:[]});
    expect(out.height).toBe(370);expect(out.svg).toContain('height="370px"');
    const clips=[...out.svg.matchAll(/<clipPath id="c-c(\d)"><rect x="0" y="([-\d.]+)" width="500" height="([-\d.]+)"/g)].map(m=>[m[1],Number(m[2]),Number(m[3])]);
    expect(clips).toEqual([['0',-1,181],['1',180,221]]);
    expect(out.svg).toContain('clip-path="url(#c-c0)"');expect(out.svg).toContain('<use href="#c-content"');
    expect(out.svg).toContain('translate(0 0)');expect(out.svg).toContain('translate(0 -30)');
  });
  it('inserts marks without bands when there is no shift',()=>{
    const out=composeSystemSvg({svg:'<svg width="500" height="400"><text>x</text></svg>',id:'s0',left:0,top:0,width:500,height:400,shift:null,marks:[{role:'group',kind:'brace',x:10,top:100,bottom:300,width:20}]});
    expect(out.height).toBe(400);expect(out.svg).not.toContain('<defs>');expect(out.svg).toMatch(/<text>x<\/text><g data-tp-accolade="group-brace"[\s\S]*&#57344;[\s\S]*<\/svg>$/);
  });
  it('draws marks in chunk-local coordinates and shifts their y by the band shift',()=>{
    const marks=[{role:'group' as const,kind:'bracket' as const,x:110,top:250,bottom:350,width:6,glyphScale:1}];
    const out=composeSystemSvg({svg:'<svg width="500" height="400"></svg>',id:'s',left:100,top:50,width:500,height:400,shift:{cuts:[180],offsets:[40]},marks});
    const [box]=markBoxes(out.svg);
    expect(box.x).toBe(10);
    // A mark's top and bottom already hold its overflow: 250 moves to 290 and 350 to 390, both lose the chunk top of 50, the bar adds 3 each side.
    expect(box.top).toBeCloseTo(290-50-3,6);expect(box.bottom).toBeCloseTo(390-50+3,6);
  });
  it('emits alphaTab glyph markup for a bracket: a rect and both spikes',()=>{
    const svg=accoladeSvg([{role:'track',kind:'bracket',x:30,top:100,bottom:200,width:6,glyphScale:1.5}],{left:0,top:0});
    expect(svg).toMatch(/^<g data-tp-accolade="track-bracket">/);expect(svg).toContain('<rect ');
    expect(svg).toContain('<g transform="translate(30 ');expect(svg).toContain('class="at" ><text style="font-size: 150%; stroke:none">&#57347;</text></g>');
    expect(svg).toContain('&#57348;');expect(svg).not.toContain('&#57344;');
  });
});

describe('accolade marks',()=>{
  const plan=(over:Partial<AccoladePlan>={}):AccoladePlan=>({groups:[{index:0,kind:'bracket' as const,tracks:[0,1]}],nativeMode:1,singleStaffBrackets:false,braceTracks:new Set([1]),inner:metrics.brace.width*BRACE_MAX_X_SCALE/metrics.scale,outer:metrics.bracketThickness/metrics.scale,reserve:0,...over});
  it('places group marks outside track marks and spans moved staves',()=>{
    const p=plan({braceTracks:new Set([1])});
    const out=composeSystem({svg:'<svg width="500" height="400"></svg>',id:'s',left:0,top:0,width:500,height:400,system,plan:p,gaps:new Map([[0,2]]),metrics});
    const marks=markBoxes(out.svg);
    const group=marks.find(m=>m.role==='group')!,brace=marks.find(m=>m.kind==='brace')!;
    expect(out.shift).toEqual({cuts:[180],offsets:[40]});expect(out.height).toBe(440);
    expect(brace.x+brace.width).toBeCloseTo(60-metrics.pad,1);expect(group.x+group.width).toBeLessThanOrEqual(brace.x-metrics.pad+1e-6);
    expect(group.top).toBeCloseTo(100-metrics.staffSpace/4-3,1);expect(group.bottom).toBeCloseTo(300+40+metrics.staffSpace/4+3,1); // spans the moved piano
    expect(brace.bottom).toBeCloseTo(340,1);expect(brace.width).toBeLessThanOrEqual(metrics.brace.width*BRACE_MAX_X_SCALE+1e-6);
  });
  it('puts the outer column left of the whole inner column, even where the inner mark is narrower',()=>{
    const marks=systemAccoladeMarks(plan(),bands,metrics,60),inner=marks.find(m=>m.role==='track')!,group=marks.find(m=>m.role==='group')!;
    expect(inner.kind).toBe('brace');expect(inner.x+inner.width).toBeCloseTo(60-metrics.pad,6);
    expect(group.x+group.width).toBeCloseTo(60-metrics.pad-metrics.brace.width*BRACE_MAX_X_SCALE-metrics.pad,6);
  });
  it('gives a track in a brace group no inner mark and a track in a bracket group only its brace',()=>{
    const brace=systemAccoladeMarks(plan({groups:[{index:0,kind:'brace',tracks:[1,2]}]}),bands,metrics,60);
    expect(brace.filter(m=>m.role==='track').map(m=>m.kind)).toEqual([]); // the piano is in the brace group, the guitar has 1 staff and no single staff brackets
    const withGuitarPair=systemAccoladeMarks(plan({groups:[{index:0,kind:'brace',tracks:[1,2]}]}),bands.map(b=>b.track===0?{...b,staves:2}:b),metrics,60);
    expect(withGuitarPair.filter(m=>m.role==='track').map(m=>`${m.kind}`)).toEqual(['bracket']);
    const bracket=systemAccoladeMarks(plan(),bands.map(b=>b.track===0?{...b,staves:2}:b),metrics,60);
    expect(bracket.filter(m=>m.role==='track').map(m=>m.kind)).toEqual(['brace']); // guitar is in the bracket group: its inner bracket is dropped
  });
  it('draws no inner marks with the Brackets setting None',()=>{
    const marks=systemAccoladeMarks(plan({nativeMode:0,inner:0}),bands,metrics,60);
    expect(marks.filter(m=>m.role==='track')).toEqual([]);expect(marks.filter(m=>m.role==='group')).toHaveLength(1);
    expect(marks[0].x+marks[0].width).toBeCloseTo(60-metrics.pad-metrics.pad,6);
  });
  it('caps a tall brace at four glyph widths by compressing it horizontally',()=>{
    const p=plan({groups:[{index:0,kind:'brace',tracks:[0,1]}],braceTracks:new Set<number>()});
    const out=composeSystem({svg:'<svg width="500" height="400"></svg>',id:'s',left:0,top:0,width:500,height:400,system,plan:p,gaps:new Map(),metrics});
    const brace=markBoxes(out.svg).find(m=>m.kind==='brace')!;
    expect(brace.top).toBeCloseTo(100,6);expect(brace.bottom).toBeCloseTo(300,6);
    expect(brace.width).toBeCloseTo(metrics.brace.width*BRACE_MAX_X_SCALE,6);expect(out.svg).toContain('scale(');
  });
  it('draws a one-staff group only with single staff brackets',()=>{
    const only=fakeSystem([{track:0,staff:0,y:100,h:60}]);
    const p=(single:boolean)=>({groups:[{index:0,kind:'bracket' as const,tracks:[0,1]}],nativeMode:1,singleStaffBrackets:single,braceTracks:new Set<number>(),inner:0,outer:1,reserve:0});
    expect(systemAccoladeMarks(p(false),systemTrackBands(only),metrics,60).filter(m=>m.role==='group')).toEqual([]);
    expect(systemAccoladeMarks(p(true),systemTrackBands(only),metrics,60).filter(m=>m.role==='group')).toHaveLength(1);
  });
  it('draws nothing for a group none of whose tracks has a band in the system',()=>{
    const only=fakeSystem([{track:2,staff:0,y:100,h:60}]);
    expect(systemAccoladeMarks(plan({singleStaffBrackets:true}),systemTrackBands(only),metrics,60).filter(m=>m.role==='group')).toEqual([]);
  });
  it('composes nothing new without a plan and without a shift',()=>{
    const svg='<svg width="500" height="400"><text>x</text></svg>';
    const out=composeSystem({svg,id:'s',left:0,top:0,width:500,height:400,system,plan:null,gaps:new Map(),metrics});
    expect(out.svg).toBe(svg);expect(out.shift).toBeNull();expect(out.height).toBe(400);
  });
});
