import { afterEach,describe,expect,it,vi } from 'vitest';
import { model } from '@coderline/alphatab';
import type { SvgSystem } from '../export/types';
import type { PageLayout } from './types';
import { paginateEngravedSystems,validatePageLayout } from './page';
import { defaultHeaderFooter,fillHeaderField,headerFieldsOf,validateHeaderFooter,type HeaderFooter } from './header-footer';

const custom=():PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'});
const system=(height:number,id:string):SvgSystem=>({width:500,height,svg:`<svg xmlns="http://www.w3.org/2000/svg"><path id="${id}" d="M0 0L10 10"/></svg>`});
const texts=(svg:string)=>[...new DOMParser().parseFromString(svg,'image/svg+xml').querySelectorAll('svg > text')].map(node=>({text:node.textContent,anchor:node.getAttribute('text-anchor'),x:Number(node.getAttribute('x')),y:Number(node.getAttribute('y')),size:Number(node.getAttribute('font-size'))}));
const fields={TITLE:'A&B <solo>',SUBTITLE:'Live',ARTIST:'The Band',ALBUM:'First',WORDS:'W. Writer',MUSIC:'M. Maker',COPYRIGHT:'© 2026',TABBER:'T. Tabber',INSTRUCTIONS:'Swing',NOTICES:'Draft'};
afterEach(()=>vi.unstubAllGlobals());

describe('header and footer fields',()=>{
  it('substitutes every score field, page numbers and a literal percent sign',()=>{
    expect(fillHeaderField('%TITLE% – %SUBTITLE% by %ARTIST% (%ALBUM%)',fields,2,5)).toBe('A&B <solo> – Live by The Band (First)');
    expect(fillHeaderField('Words %WORDS%, music %MUSIC%, tab %TABBER%, %COPYRIGHT%',fields,1,1)).toBe('Words W. Writer, music M. Maker, tab T. Tabber, © 2026');
    expect(fillHeaderField('%INSTRUCTIONS%/%NOTICES% page %PAGE% of %PAGES% at 100%%',fields,2,5)).toBe('Swing/Draft page 2 of 5 at 100%');
  });
  it('reads the fields from the score metadata',()=>{
    const score=new model.Score();
    Object.assign(score,{title:'T',subTitle:'S',artist:'A',album:'L',words:'W',music:'M',copyright:'C',tab:'B',instructions:'I',notices:'N'});
    expect(headerFieldsOf(score)).toEqual({TITLE:'T',SUBTITLE:'S',ARTIST:'A',ALBUM:'L',WORDS:'W',MUSIC:'M',COPYRIGHT:'C',TABBER:'B',INSTRUCTIONS:'I',NOTICES:'N'});
  });
  it('refuses unknown fields, stray percent signs, line breaks, oversize text and malformed shapes',()=>{
    const with_=(text:string)=>{const value=defaultHeaderFooter();value.other.footer.right=text;return value;};
    expect(()=>validateHeaderFooter(defaultHeaderFooter())).not.toThrow();
    expect(()=>validateHeaderFooter(with_('%COMPOSER%'))).toThrow('Other pages footer right: unknown field %COMPOSER%.');
    expect(()=>validateHeaderFooter(with_('50% off'))).toThrow(/Use %% for a percent sign/);
    expect(()=>validateHeaderFooter(with_('%title%'))).toThrow(/unknown field/);
    expect(()=>validateHeaderFooter(with_('a\nb'))).toThrow(/single line/);
    expect(()=>validateHeaderFooter(with_('a\u0085b'))).toThrow(/single line/);
    expect(()=>validateHeaderFooter(with_('x'.repeat(201)))).toThrow(/200 characters/);
    expect(()=>validateHeaderFooter(with_('x'.repeat(200)))).not.toThrow();
    const extra={...defaultHeaderFooter(),odd:{}};expect(()=>validateHeaderFooter(extra)).toThrow(/Invalid header and footer/);
    const band=defaultHeaderFooter() as unknown as {first:{header:Record<string,unknown>}};band.first.header.left=1;expect(()=>validateHeaderFooter(band)).toThrow(/Invalid header and footer/);
    delete (band.first.header as Record<string,unknown>).left;expect(()=>validateHeaderFooter(band)).toThrow(/Invalid header and footer/);
  });
  it('is an optional page layout field validated with the layout',()=>{
    expect(()=>validatePageLayout(custom())).not.toThrow();
    expect(()=>validatePageLayout({...custom(),headerFooter:defaultHeaderFooter()})).not.toThrow();
    expect(()=>validatePageLayout({...custom(),headerFooter:null})).toThrow();
    const bad=defaultHeaderFooter();bad.first.header.center='%NOPE%';
    expect(()=>validatePageLayout({...custom(),headerFooter:bad})).toThrow(/unknown field %NOPE%/);
  });
});

describe('printed header and footer',()=>{
  const layout=(headerFooter:HeaderFooter):PageLayout=>({...custom(),headerFooter});
  it('the default fields print exactly what pages printed before',()=>{
    const systems=[system(400,'first'),system(400,'second')];
    expect(paginateEngravedSystems(systems,'A&B <solo>',layout(defaultHeaderFooter()),fields)).toEqual(paginateEngravedSystems(systems,'A&B <solo>',custom()));
  });
  it('fills first-page and other-page bands in their positions on every page',()=>{
    const value:HeaderFooter={
      first:{header:{left:'%TITLE%',center:'%SUBTITLE%',right:'%ARTIST%'},footer:{left:'%COPYRIGHT%',center:'',right:'Page %PAGE%'}},
      other:{header:{left:'',center:'%TITLE% (cont.)',right:''},footer:{left:'',center:'',right:'%PAGE%/%PAGES%'}},
    };
    const pages=paginateEngravedSystems([system(400,'first'),system(400,'second'),system(400,'third')],fields.TITLE,layout(value),fields);
    expect(pages).toHaveLength(3);
    const mm=96/25.4,width=180*mm,height=240*mm,left=16*mm,right=width-12*mm,top=10*mm+22,bottom=height-14*mm;
    expect(texts(pages[0].svg)).toEqual([
      {text:'A&B <solo>',anchor:null,x:left,y:top,size:18},{text:'Live',anchor:'middle',x:width/2,y:top,size:18},{text:'The Band',anchor:'end',x:right,y:top,size:18},
      {text:'© 2026',anchor:null,x:left,y:bottom,size:11},{text:'Page 1',anchor:'end',x:right,y:bottom,size:11},
    ]);
    for(const [index,svg] of pages.slice(1).map(page=>page.svg).entries())expect(texts(svg)).toEqual([
      {text:'A&B <solo> (cont.)',anchor:'middle',x:width/2,y:top,size:18},{text:`${index+2}/3`,anchor:'end',x:right,y:bottom,size:11},
    ]);
    expect(pages[0].svg).toContain('A&amp;B &lt;solo&gt;');
    expect(pages[0].svg).toContain(`<g transform="translate(${left} ${10*mm+40})">`);
  });
  it('shrinks crowded slots to share the band width',()=>{
    const context={font:'',measureText:vi.fn((text:string)=>({width:text.length*10}))};
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>context})});
    const long='x'.repeat(60),value=defaultHeaderFooter();
    value.first.header={left:long,center:'',right:long};
    const [page]=paginateEngravedSystems([system(400,'only')],'',layout(value),fields);
    const usable=180*96/25.4-28*96/25.4,[a,b]=texts(page.svg);
    for(const slot of [a,b])expect(slot.size/18*600).toBeLessThanOrEqual((usable-12)/2+0.001);
  });
});

describe('header and footer review regressions',()=>{
  // Each character is half the font size wide, so a measured width follows the requested size.
  const measure=()=>{const context={font:'',measureText:(text:string)=>({width:[...text].length*Number(/^(\d+(?:\.\d+)?)px/.exec(context.font)![1])/2})};vi.stubGlobal('document',{createElement:()=>({getContext:()=>context})});};
  const mm=96/25.4;
  const spans=(svg:string)=>texts(svg).map(slot=>{const width=[...slot.text!].length*slot.size/2,start=slot.anchor==='middle'?slot.x-width/2:slot.anchor==='end'?slot.x-width:slot.x;return {...slot,start,end:start+width};});
  it('fits footer text at its own size instead of measuring the header size',()=>{
    measure();const value=defaultHeaderFooter(),usable=(180-28)*mm;
    value.first.footer={left:'',center:'',right:'x'.repeat(Math.floor(usable/5.5)-2)};
    const [footer]=texts(paginateEngravedSystems([system(400,'only')],'',{...custom(),headerFooter:value},fields)[0].svg).slice(-1);
    expect(footer.size).toBe(11);
  });
  it('keeps side slots clear of a centered slot, also with uneven margins',()=>{
    measure();
    for(const margins of [{top:10,right:12,bottom:14,left:16},{top:10,right:8,bottom:14,left:30}]){
      const value=defaultHeaderFooter(),long='x'.repeat(150);
      value.first.header={left:long,center:long,right:long};value.first.footer={left:long,center:'Page %PAGE%',right:''};
      const [page]=paginateEngravedSystems([system(400,'only')],'',{...custom(),marginsMm:margins,headerFooter:value},fields);
      const all=spans(page.svg),left=margins.left*mm,right=180*mm-margins.right*mm;
      for(const y of new Set(all.map(slot=>slot.y))){
        const row=all.filter(slot=>slot.y===y).sort((a,b)=>a.start-b.start);
        expect(row[0].start).toBeGreaterThanOrEqual(left-0.001);expect(row.at(-1)!.end).toBeLessThanOrEqual(right+0.001);
        for(let i=1;i<row.length;i++)expect(row[i].start).toBeGreaterThanOrEqual(row[i-1].end+11.99);
      }
    }
  });
  it('shortens text with an ellipsis rather than shrinking it below a legible size',()=>{
    measure();const value=defaultHeaderFooter();value.first.header.left='%NOTICES%';
    const [page]=paginateEngravedSystems([system(400,'only')],'',{...custom(),headerFooter:value},{...fields,NOTICES:'n'.repeat(5000)});
    const [slot]=texts(page.svg);
    expect(slot.size).toBe(5);expect(slot.text!.endsWith('…')).toBe(true);expect([...slot.text!].length*2.5).toBeLessThanOrEqual((180-28)*mm);
  });
  it('prints score metadata line breaks as spaces and drops characters XML cannot carry',()=>{
    const value=defaultHeaderFooter();value.first.header.left='%NOTICES%';
    const [page]=paginateEngravedSystems([system(400,'only')],'',{...custom(),headerFooter:value},{...fields,NOTICES:'one\r\ntwo\tthree\u0001￿\uD800 & <four>'});
    expect(texts(page.svg)[0].text).toBe('one two three & <four>');
  });
  it('refuses unprintable template characters and treats an undefined header and footer as absent',()=>{
    for(const text of ['a￾b','a￿','\uD800x','x\uDC00']){const value=defaultHeaderFooter();value.other.header.left=text;expect(()=>validateHeaderFooter(value)).toThrow(/cannot be printed/);}
    expect(()=>validateHeaderFooter({...defaultHeaderFooter(),first:{...defaultHeaderFooter().first,header:{left:'🎸',center:'',right:''}}})).not.toThrow();
    expect(()=>validatePageLayout({...custom(),headerFooter:undefined})).not.toThrow();
  });
});
