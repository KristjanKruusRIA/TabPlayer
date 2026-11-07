import { afterEach,describe,expect,it,vi } from 'vitest';
import type { PageLayout } from './types';
import { pageGeometry,pageTextFontFamily,pageTextItems,pageTextSvg,paginateEngravedSystems,screenPageBaselines } from './page';
import { defaultHeaderFooter,type HeaderFields } from './header-footer';
import { measurePageText } from '../export/page-title';

const layout=(margin=15):PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:margin,right:margin,bottom:margin,left:margin},scale:1,profile:'document'});
const fields:HeaderFields={TITLE:'Song',SUBTITLE:'Sub',ARTIST:'Band',ALBUM:'Alb',WORDS:'W',MUSIC:'M',COPYRIGHT:'C',TABBER:'T',INSTRUCTIONS:'I',NOTICES:'N'};
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
  describe('with canvas measuring stubbed',()=>{
    const width=(text:string,size:number)=>text.length*size*0.5;
    const stub=()=>vi.stubGlobal('document',{createElement:()=>{const ctx={font:'',measureText:(t:string)=>({width:width(t,parseFloat(ctx.font))})};return {getContext:()=>ctx};}});
    const sys=[{width:300,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}];
    const sections=(svg:string)=>({head:svg.slice(svg.indexOf('</style>')+8,svg.indexOf('<g transform')),foot:svg.slice(svg.lastIndexOf('</g>')+4,svg.length-'</svg>'.length)});
    // Literal text captured from the export code before the shared items existed (develop at 1b79f74), so a change on
    // both sides of the shared path still fails here.
    const golden={"default": {"head": "<text x=\"56.69291338582678\" y=\"78.69291338582678\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"18\">Song</text>", "foot": "<text x=\"340.15748031496065\" y=\"850.3937007874017\" text-anchor=\"middle\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"11\">1 / 1</text>"}, "custom": {"head": "<text x=\"56.69291338582678\" y=\"78.69291338582678\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"18\">a&amp;b</text><text x=\"340.15748031496065\" y=\"78.69291338582678\" text-anchor=\"middle\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"18\">mid</text><text x=\"623.6220472440946\" y=\"78.69291338582678\" text-anchor=\"end\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"18\">z</text>", "foot": "<text x=\"56.69291338582678\" y=\"850.3937007874017\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"11\">L</text><text x=\"340.15748031496065\" y=\"850.3937007874017\" text-anchor=\"middle\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"11\">1 of 1</text><text x=\"623.6220472440946\" y=\"850.3937007874017\" text-anchor=\"end\" font-family=\"Noto Sans, Noto Sans CJK JP, Noto Emoji\" font-size=\"11\">R</text>"}};
    const compare=(l:PageLayout,expected:{head:string;foot:string})=>{
      stub();
      const g=pageGeometry(l),[page]=paginateEngravedSystems(sys,'Song',l,fields),bands=l.headerFooter?.first??null;
      const items=pageTextItems({geometry:g,bands,title:'Song',fields,page:1,pages:1,titleScale:1,headerY:g.top+22,footerY:g.height-g.bottom});
      const {head,foot}=sections(page.svg);
      expect(head).toBe(pageTextSvg(items.header));
      expect(foot).toBe(pageTextSvg(items.footer));
      expect(head).toContain('font-family="'+pageTextFontFamily+'"');
      expect({head,foot}).toEqual(expected);
    };
    it('prints custom bands exactly as export does',()=>{
      const hf=defaultHeaderFooter();hf.first.header={left:'a&b',center:'mid',right:'z'};hf.first.footer={left:'L',center:'%PAGE% of %PAGES%',right:'R'};
      compare({...layout(),headerFooter:hf},golden.custom);
    });
    it('prints the default title and footer exactly as export does',()=>compare(layout(),golden.default));
    it('shrinks then shortens a long centre slot and keeps the sides clear of it',()=>{
      stub();
      const hf=defaultHeaderFooter();hf.first.header={left:'Left',center:'X'.repeat(200),right:'Right'};
      const {header}=pageTextItems({...common,bands:hf.first,page:1});
      const [left,center,right]=header;
      expect(center.size).toBeLessThan(18);expect(center.text.endsWith('…')).toBe(true);
      const half=width(center.text,center.size)/2,middle=d.width/2;
      expect(left.x+width(left.text,left.size)).toBeLessThanOrEqual(middle-half);
      expect(right.x-width(right.text,right.size)).toBeGreaterThanOrEqual(middle+half);
      expect(width(center.text,center.size)).toBeLessThanOrEqual(d.usableWidth/3);
    });
  });
  it('puts screen baselines at known places inside the page',()=>{
    const g=pageGeometry(layout(15));
    expect(g.height).toBeCloseTo(907.09,1);
    const b=screenPageBaselines(g,1);
    expect(b.headerY).toBeCloseTo(48.69,1);
    expect(b.footerY).toBeCloseTo(865.39,1);
    const z=pageGeometry(layout(0)),zb=screenPageBaselines(z,1);
    expect(zb.headerY).toBeCloseTo(14.4,5);
    expect(zb.footerY).toBeLessThanOrEqual(z.height-4);
    expect(screenPageBaselines(z,2).headerY).toBeCloseTo(28.8,5);
    expect(screenPageBaselines(g,2).headerY).toBeLessThan(g.height);
  });
  it('measures nothing when no canvas context exists',()=>{
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>null})});
    expect(measurePageText('x',12)).toBeNull();
  });
});
