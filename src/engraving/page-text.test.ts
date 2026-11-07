import { afterEach,describe,expect,it,vi } from 'vitest';
import type { PageLayout } from './types';
import { pageGeometry,pageTextItems,pageTextSvg,paginateEngravedSystems,screenPageBaselines } from './page';
import { defaultHeaderFooter,type HeaderFields } from './header-footer';
import { measurePageText } from '../export/page-title';

const layout=(margin=15):PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:margin,right:margin,bottom:margin,left:margin},scale:1,profile:'document'});
const fields:HeaderFields={TITLE:'Song',SUBTITLE:'Sub',ARTIST:'Band',ALBUM:'Alb',WORDS:'W',MUSIC:'M',COPYRIGHT:'C',TABBER:'T',INSTRUCTIONS:'I',NOTICES:'N'};
const svgTexts=(svg:string)=>[...new DOMParser().parseFromString(svg,'image/svg+xml').querySelectorAll('svg > text')].map(n=>({text:n.textContent,x:Number(n.getAttribute('x')),y:Number(n.getAttribute('y')),size:Number(n.getAttribute('font-size')),anchor:n.getAttribute('text-anchor')??'start'}));
afterEach(()=>vi.unstubAllGlobals());

describe('shared page text items',()=>{
  const d=pageGeometry(layout());
  const common={geometry:d,title:'Song',fields,pages:2,titleScale:1,headerY:30,footerY:200};
  it('matches the default title and page footer export prints',()=>{
    const {header,footer}=pageTextItems({...common,bands:null,page:1});
    expect(header).toEqual([{text:'Song',x:d.left,y:30,size:18,anchor:'start'}]);
    expect(footer).toEqual([{text:'1 / 2',x:d.width/2,y:200,size:11,anchor:'middle'}]);
  });
  it('places three slots and differs between first and other pages',()=>{
    const hf=defaultHeaderFooter();
    hf.first.header={left:'%ARTIST%',center:'%TITLE%',right:'p%PAGE%'};
    const first=pageTextItems({...common,bands:hf.first,page:1}),other=pageTextItems({...common,bands:hf.other,page:2});
    expect(first.header.map(i=>[i.text,i.anchor,i.x])).toEqual([['Band','start',d.left],['Song','middle',d.width/2],['p1','end',d.width-d.right]]);
    expect(other.header.map(i=>i.text)).not.toEqual(first.header.map(i=>i.text));
    expect(other.footer[0].text).toBe('2 / 2');
  });
  it('renders the same text elements as the export page',()=>{
    const hf=defaultHeaderFooter();hf.first.header={left:'a&b',center:'mid',right:'z'};
    const l={...layout(),headerFooter:hf};
    const [page]=paginateEngravedSystems([{width:300,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}],'Song',l,fields);
    const items=pageTextItems({geometry:pageGeometry(l),bands:hf.first,title:'Song',fields,page:1,pages:1,titleScale:1,headerY:pageGeometry(l).top+22,footerY:pageGeometry(l).height-pageGeometry(l).bottom});
    expect(page.svg).toContain(pageTextSvg(items.header)+'<g');
    expect(svgTexts(page.svg).slice(0,3).map(t=>t.text)).toEqual(['a&b','mid','z']);
  });
  it('keeps screen baselines inside the page',()=>{
    for(const m of [15,0]) {
      const g=pageGeometry(layout(m)),{headerY,footerY}=screenPageBaselines(g,1);
      expect(headerY).toBeGreaterThan(0);expect(headerY).toBeLessThan(g.height);
      expect(footerY).toBeGreaterThan(0);expect(footerY).toBeLessThanOrEqual(g.height);
    }
    const g=pageGeometry(layout(15));
    expect(screenPageBaselines(g,1)).toEqual({headerY:Math.max(14.4,g.top-8),footerY:Math.min(g.height-4,g.height-g.bottom+15)});
  });
  it('measures nothing when no canvas context exists',()=>{
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>null})});
    expect(measurePageText('x',12)).toBeNull();
  });
});
