import { describe,expect,it } from 'vitest';
import { paginateSystems } from '../export/pdf';
import type { PrintLayout,SvgSystem } from '../export/types';
import type { PageLayout } from './types';
import { effectivePageLayout,pageGeometry,paginateEngravedSystems,validatePageLayout } from './page';

const legacy:PrintLayout={paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'};
const custom=():PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'});
const system=(height:number,id:string,width=500):SvgSystem=>({width,height,svg:`<svg xmlns="http://www.w3.org/2000/svg"><path id="${id}" d="M0 0L10 10"/></svg>`});

describe('physical page geometry',()=>{
  it.each([
    ['A4','portrait',210,297],['A4','landscape',297,210],
    ['Letter','portrait',215.9,279.4],['Letter','landscape',279.4,215.9]
  ] as const)('legacy %s %s retains physical geometry and complete-system grouping',(paper,orientation,widthMm,heightMm)=>{
    const print={...legacy,paper,orientation,scale:1.25,profile:'Score' as const};
    const page=effectivePageLayout({page:null,print}),systems=[system(400,'first'),system(400,'second'),system(400,'third')];
    expect(page).toEqual({widthMm,heightMm,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1.25,profile:'Score'});
    const g=pageGeometry(page);
    expect(g.width).toBeCloseTo(widthMm*96/25.4);expect(g.height).toBeCloseTo(heightMm*96/25.4);
    expect(g.left).toBeCloseTo(56.6929133858);expect(g.top).toBeCloseTo(56.6929133858);
    expect(g.right).toBeCloseTo(56.6929133858);expect(g.bottom).toBeCloseTo(56.6929133858);
    expect(g.usableWidth).toBeCloseTo(widthMm*96/25.4-113.3858267717);
    expect(g.usableHeight).toBeCloseTo(heightMm*96/25.4-177.3858267717);
    expect(paginateEngravedSystems(systems,'A&B <solo>',page)).toEqual(paginateSystems(systems,'A&B <solo>',print));
  });
  it.each([
    [20,642.5196850393702,907.3385826771655],
    [25,604.724409448819,869.5433070866143],
    [30,566.9291338582677,831.748031496063]
  ])('legacy %s mm margins retain exact body capacity and grouping',(marginMm,width,height)=>{
    const print={...legacy,marginMm},page=effectivePageLayout({page:null,print}),g=pageGeometry(page);
    expect(g.usableWidth).toBe(width);expect(g.usableHeight).toBe(height);
    const systems=[system(height/2,'first',width+1),system(height/2,'second',width+1),system(1,'third',width)];
    const pages=paginateEngravedSystems(systems,'Capacity',page);
    expect(pages).toEqual(paginateSystems(systems,'Capacity',print));expect(pages).toHaveLength(2);
    expect(pages[0].svg).toContain('id="second"');expect(pages[0].svg).not.toContain('id="third"');
    expect(paginateEngravedSystems([system(height,'full',width+1)],'Capacity',page)).toHaveLength(1);
    expect(()=>paginateEngravedSystems([system(height+0.000001,'tall',width)],'',page)).toThrow(/system.*fit/i);
    expect(()=>paginateEngravedSystems([system(height,'wide',width+1.000001)],'',page)).toThrow(/system.*fit/i);
  });
  it('explicit page wins over legacy without sharing or modifying applied data',()=>{
    const page=custom(),print={...legacy},settings={page,print};
    const effective=effectivePageLayout(settings);
    expect(effective).toEqual({widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'});
    effective.marginsMm.left=20;
    expect(page.marginsMm.left).toBe(16);expect(print).toEqual(legacy);
    for(const profile of ['ScoreTab','Score','Tab'] as const)expect(effectivePageLayout({page:null,print:{...legacy,profile}}).profile).toBe(profile);
    expect(()=>effectivePageLayout({page:null,print:{...legacy,paper:'A3'} as unknown as PrintLayout})).toThrow(/paper/i);
    expect(()=>effectivePageLayout({page:null,print:{...legacy,orientation:'diagonal'} as unknown as PrintLayout})).toThrow(/orientation/i);
    expect(()=>effectivePageLayout({page:null,print:{...legacy,profile:'document'} as unknown as PrintLayout})).toThrow(/profile/i);
  });
  it('asymmetric custom page has one physical truth independent of notation scale',()=>{
    const g=pageGeometry(custom());
    expect(g.widthMm).toBe(180);expect(g.heightMm).toBe(240);
    expect(g.width).toBeCloseTo(680.3149606299);expect(g.height).toBeCloseTo(907.0866141732);
    expect(g.usableWidth).toBeCloseTo(574.4881889764);expect(g.usableHeight).toBeCloseTo(752.3779527559);
    expect(g.left).toBeCloseTo(60.4724409449);expect(g.top).toBeCloseTo(37.7952755906);
    expect(g.right).toBeCloseTo(45.3543307087);expect(g.bottom).toBeCloseTo(52.9133858268);
    expect(pageGeometry({...custom(),scale:2})).toEqual(g);
  });
  it.each([
    null,[],{}, {...custom(),extra:true},{...custom(),heightMm:undefined},
    {...custom(),widthMm:'180'},{...custom(),widthMm:19.99},{...custom(),heightMm:1000.01},
    {...custom(),widthMm:NaN},{...custom(),heightMm:Infinity},
    {...custom(),marginsMm:null},{...custom(),marginsMm:[]},
    {...custom(),marginsMm:{top:10,right:12,bottom:14}},
    {...custom(),marginsMm:{top:10,right:12,bottom:14,left:16,all:15}},
    ...(['top','right','bottom','left'] as const).flatMap(side=>[-1,NaN,Infinity,'10'].map(value=>({...custom(),marginsMm:{...custom().marginsMm,[side]:value}}))),
    {...custom(),scale:0.249},{...custom(),scale:3.001},{...custom(),scale:NaN},{...custom(),scale:Infinity},
    {...custom(),profile:'source'},
    {...custom(),widthMm:20},{...custom(),heightMm:20},
    {...custom(),marginsMm:{top:100,right:80,bottom:100,left:80}}
  ])('rejects malformed or unusable layout %# before geometry or pagination',(value)=>{
    expect(()=>validatePageLayout(value)).toThrow();
    expect(()=>pageGeometry(value as PageLayout)).toThrow();
    expect(()=>paginateEngravedSystems([],'',value as PageLayout)).toThrow();
  });
  it('accepts inclusive scale and physical-size upper bounds',()=>{
    for(const scale of [0.25,3])expect(()=>validatePageLayout({widthMm:1000,heightMm:1000,marginsMm:{top:0,right:0,bottom:0,left:0},scale,profile:'document'})).not.toThrow();
    expect(()=>validatePageLayout({widthMm:31.75,heightMm:63.5,marginsMm:{top:0,right:0,bottom:0,left:5.291666666666667},scale:1,profile:'Tab'})).not.toThrow();
  });
  it('allows a 100px notation body and rejects either dimension just below it',()=>{
    const page:PageLayout={widthMm:31.75,heightMm:63.5,marginsMm:{top:20.108333333333334,right:0,bottom:0,left:5.291666666666667},scale:1,profile:'document'};
    expect(pageGeometry(page).usableWidth).toBeCloseTo(100);expect(pageGeometry(page).usableHeight).toBeCloseTo(100);
    expect(()=>validatePageLayout({...page,marginsMm:{...page.marginsMm,left:5.292}})).toThrow(/width|margin/i);
    expect(()=>validatePageLayout({...page,marginsMm:{...page.marginsMm,top:20.109}})).toThrow(/height|margin/i);
  });
  it('accepts exact 100px converted body dimensions even when mm-delta arithmetic rounds below them',()=>{
    const page:PageLayout={widthMm:40,heightMm:70,marginsMm:{top:0,right:13.541666666666671,bottom:26.608333333333345,left:0},scale:1,profile:'document'};
    expect(()=>validatePageLayout(page)).not.toThrow();
    expect(pageGeometry(page).usableWidth).toBe(100);expect(pageGeometry(page).usableHeight).toBe(100);
  });
  it('rejects converted width below 100px even when mm-delta arithmetic rounds to 100',()=>{
    expect(()=>validatePageLayout({...custom(),widthMm:50,marginsMm:{top:0,right:23.541666666666668,bottom:0,left:0}})).toThrow(/margin/i);
  });
  it('rejects converted height below 100px even when mm-delta arithmetic rounds to 100',()=>{
    expect(()=>validatePageLayout({...custom(),heightMm:50,marginsMm:{top:0,right:0,bottom:6.608333333333339,left:0}})).toThrow(/margin/i);
  });
});

describe('engraved system pagination',()=>{
  it('packs whole systems at independent left/top margins and escapes the fixed title',()=>{
    const pages=paginateEngravedSystems([system(400,'first'),system(400,'second')],`A&B <solo> "lead" 'guitar'`,custom());
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({widthMm:180,heightMm:240});
    expect(pages[0].svg).toContain('width="180mm" height="240mm" viewBox="0 0 680.3149606299213 907.0866141732284"');
    expect(pages[0].svg).toContain('transform="translate(60.472440944881896 77.79527559055119)"');
    expect(pages[0].svg).toContain('x="60.472440944881896" y="59.795275590551185"');
    expect(pages[0].svg).toContain('y="854.1732283464568" text-anchor="middle"');
    expect(pages[0].svg).toContain('A&amp;B &lt;solo&gt; &quot;lead&quot; &apos;guitar&apos;');
    expect(pages[0].svg).toContain('id="first"');expect(pages[0].svg).not.toContain('id="second"');
    expect(pages[1].svg).toContain('id="second"');expect(pages[1].svg).not.toContain('id="first"');
    expect(pages[0].svg).toContain('1 / 2');expect(pages[1].svg).toContain('2 / 2');
    expect(pages[0].svg.match(/<svg\b/g)).toHaveLength(1);
    expect(paginateEngravedSystems([system(400,'first'),system(400,'second')],`A&B <solo> "lead" 'guitar'`,{...custom(),scale:2})).toEqual(pages);
  });
  it('stacks systems and starts a new page only when the complete system exceeds capacity',()=>{
    const pages=paginateEngravedSystems([system(300,'first'),system(300,'second'),system(200,'third')],'',custom());
    expect(pages).toHaveLength(2);expect(pages[0].svg).toContain('id="second"');
    expect(pages[0].svg).toContain('transform="translate(60.472440944881896 377.79527559055117)"');
    expect(pages[1].svg).toContain('id="third"');expect(pages[1].svg).not.toContain('id="second"');
  });
  it.each([
    {height:753,width:500},{height:100,width:576},{height:0,width:500},{height:-1,width:500},
    {height:NaN,width:500},{height:Infinity,width:500},{height:100,width:0},
    {height:100,width:-1},{height:100,width:NaN},{height:100,width:Infinity}
  ])('rejects nonfinite, nonpositive or clipped system %#',({width,height})=>{
    expect(()=>paginateEngravedSystems([system(height,'bad',width)],'',custom())).toThrow(/system.*fit/i);
  });
  it('retains the legacy one-pixel renderer-width allowance and empty-page convention',()=>{
    expect(paginateEngravedSystems([system(100,'rounded',575)],'',custom())).toHaveLength(1);
    const pages=paginateEngravedSystems([],'Empty',custom());
    expect(pages).toHaveLength(1);expect(pages[0].svg).toContain('>Empty</text>');expect(pages[0].svg).toContain('1 / 1');
  });
});

describe('per-system gaps in export',()=>{
  const sys=(height:number,id:string,firstBar?:number,lastBar?:number):SvgSystem=>({...system(height,id),...(firstBar===undefined?{}:{firstBar,lastBar})});
  const page=():PageLayout=>({...custom(),scale:1.5});
  const ys=(p:ReturnType<typeof paginateEngravedSystems>)=>p.map(x=>[...x.svg.matchAll(/translate\(([\d.]+) ([\d.]+)\)/g)].map(m=>Number(m[2])));
  const systems=[sys(40,'title'),sys(100,'a',0,1),sys(100,'b',2,3),sys(100,'c',4,5)];
  const gap=(bar:number,scale:number,spacing:number|null=null)=>({gaps:[{bar,scale}],systemSpacing:spacing,scale:1.5});
  const base=ys(paginateEngravedSystems(systems,'T',page()))[0];
  it('is byte-identical without gaps or with gaps outside every system',()=>{
    const plain=paginateEngravedSystems(systems,'T',page());
    expect(paginateEngravedSystems(systems,'T',page(),undefined,1,{gaps:undefined,systemSpacing:null,scale:1.5})).toEqual(plain);
    expect(paginateEngravedSystems(systems,'T',page(),undefined,1,gap(90,3))).toEqual(plain);
  });
  it('offsets the chosen system and later ones by (s-1) x 20 x spacing x scale, shrinking below 100%',()=>{
    for(const [scale,spacing] of [[2,null],[.5,null],[2,2]] as const) {
      const offset=(scale-1)*20*(spacing??1)*1.5,got=ys(paginateEngravedSystems(systems,'T',page(),undefined,1,gap(2,scale,spacing)))[0];
      expect(got.slice(0,2)).toEqual(base.slice(0,2));
      expect(got[2]).toBeCloseTo(base[2]+offset);expect(got[3]).toBeCloseTo(base[3]+offset);
    }
  });
  it('adds nothing before the first system of the score or a page top',()=>{
    expect(ys(paginateEngravedSystems(systems,'T',page(),undefined,1,gap(0,4)))[0]).toEqual(base);
    const d=pageGeometry(page()),tall=[sys(d.usableHeight-150,'a',0,1),sys(100,'b',2,3),sys(100,'c',4,5)];
    const plain=ys(paginateEngravedSystems(tall,'T',page()));expect(plain).toHaveLength(2);
    expect(ys(paginateEngravedSystems(tall,'T',page(),undefined,1,gap(4,4,4)))).toEqual(plain);
  });
  it('counts the offset in the page fit and drops it on the new page',()=>{
    const d=pageGeometry(page()),tall=[sys(d.usableHeight-250,'a',0,1),sys(100,'b',2,3)];
    expect(ys(paginateEngravedSystems(tall,'T',page()))).toHaveLength(1);
    // Offset 3 x 20 x 4 x 1.5 = 360 px pushes the second system over.
    const pages=ys(paginateEngravedSystems(tall,'T',page(),undefined,1,gap(2,4,4)));
    expect(pages).toHaveLength(2);expect(pages[1][0]).toBeCloseTo(page().marginsMm.top*96/25.4+40);
  });
});
