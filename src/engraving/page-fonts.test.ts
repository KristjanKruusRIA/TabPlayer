import {afterEach,describe,expect,it,vi} from 'vitest';
import type {PageLayout} from './types';
import {pageGeometry,pageTextFontFamily,pageTextItems,pageTextSvg,paginateEngravedSystems,screenPageBaselines,type PageTextItem} from './page';
import {defaultHeaderFooter,type HeaderFields} from './header-footer';
import {measurePageText,pageTitleFontSize} from '../export/page-title';
import {pageRoleFont} from './fonts';

const layout=(margin=15):PageLayout=>({widthMm:180,heightMm:240,marginsMm:{top:margin,right:margin,bottom:margin,left:margin},scale:1,profile:'document'});
const fields:HeaderFields={TITLE:'Song',SUBTITLE:'Sub',ARTIST:'Band',ALBUM:'Alb',WORDS:'W',MUSIC:'M',COPYRIGHT:'C',TABBER:'T',INSTRUCTIONS:'I',NOTICES:'N'};
afterEach(()=>vi.unstubAllGlobals());

const serif=pageRoleFont({roles:{pageHeader:{font:'notoSerif',bold:true,italic:true,size:1.5},pageFooter:{font:'notoSerif'}}},'pageHeader');
const serifFooter=pageRoleFont({roles:{pageHeader:{font:'notoSerif',bold:true,italic:true,size:1.5},pageFooter:{font:'notoSerif'}}},'pageFooter');
/** Canvas stub whose width depends on weight and style, and records the font strings it was given. */
function stubCanvas(){
  const fonts:string[]=[];
  vi.stubGlobal('document',{createElement:()=>{const ctx={font:'',measureText:(text:string)=>{fonts.push(ctx.font);const size=parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)![1]);return {width:text.length*size*(ctx.font.includes('bold')?.7:.5)*(ctx.font.includes('italic')?1.1:1)};}};return {getContext:()=>ctx};}});
  return fonts;
}

describe('page text with fonts',()=>{
  const d=pageGeometry(layout());
  const common={geometry:d,title:'Song',fields,pages:2,titleScale:1,headerY:30,footerY:200};
  it('items_carry_the_chosen_family_and_flags_only_when_set',()=>{
    const plain=pageTextItems({...common,bands:null,page:1});
    expect(plain.header[0]).toEqual({text:'Song',x:d.left,y:30,size:18,anchor:'start'});
    expect(Object.keys(plain.footer[0])).toEqual(['text','x','y','size','anchor']);
    const chosen=pageTextItems({...common,bands:null,page:1,headerFont:serif,footerFont:serifFooter});
    expect(chosen.header[0]).toMatchObject({family:'TabPlayer Serif',bold:true,italic:true,size:27});
    expect(chosen.footer[0]).toMatchObject({family:'TabPlayer Serif',size:11});
    expect(chosen.footer[0].bold).toBeUndefined();expect(chosen.footer[0].italic).toBeUndefined();
    const hf=defaultHeaderFooter();hf.first.header={left:'a',center:'b',right:'c'};hf.first.footer={left:'x',center:'y',right:'z'};
    const bands=pageTextItems({...common,bands:hf.first,page:1,headerFont:serif,footerFont:serifFooter});
    expect(bands.header.every(item=>item.family==='TabPlayer Serif'&&item.bold===true&&item.size===27)).toBe(true);
    expect(bands.footer.every(item=>item.family==='TabPlayer Serif'&&item.size===11)).toBe(true);
  });
  it('a_size_only_font_scales_without_changing_the_family',()=>{
    const font=pageRoleFont({roles:{pageFooter:{size:2}}},'pageFooter');
    const items=pageTextItems({...common,bands:null,page:1,footerFont:font});
    expect(items.footer[0].size).toBe(22);expect('family' in items.footer[0]).toBe(false);
  });
  it('header_role_size_replaces_the_title_scale',()=>{
    const font=pageRoleFont({roles:{pageHeader:{size:.5}}},'pageHeader');
    expect(pageTextItems({...common,titleScale:2,bands:null,page:1,headerFont:font}).header[0].size).toBe(9);
    expect(pageTextItems({...common,titleScale:2,bands:null,page:1}).header[0].size).toBe(36);
    expect(pageTextItems({...common,titleScale:2,bands:null,page:1,headerFont:pageRoleFont(undefined,'pageHeader')}).header[0].size).toBe(36);
  });
  it('svg_text_adds_family_weight_and_style_only_when_chosen',()=>{
    const defaults:PageTextItem[]=[{text:'a',x:1,y:2,size:11,anchor:'start'}];
    expect(pageTextSvg(defaults)).toBe(`<text x="1" y="2" font-family="${pageTextFontFamily}" font-size="11">a</text>`);
    expect(pageTextFontFamily).toBe('Noto Sans, Noto Sans CJK JP, Noto Emoji');
    const chosen:PageTextItem[]=[{text:'b',x:1,y:2,size:27,anchor:'end',family:'TabPlayer Serif',bold:true,italic:true},{text:'c',x:1,y:2,size:11,anchor:'middle',family:'TabPlayer Mono'}];
    expect(pageTextSvg(chosen)).toBe(
      '<text x="1" y="2" text-anchor="end" font-family="TabPlayer Serif, Noto Sans, Noto Sans CJK JP, Noto Emoji" font-weight="700" font-style="italic" font-size="27">b</text>'+
      '<text x="1" y="2" text-anchor="middle" font-family="TabPlayer Mono, Noto Sans, Noto Sans CJK JP, Noto Emoji" font-size="11">c</text>');
  });
  it('measure_uses_weight_style_and_the_chosen_family',()=>{
    const fonts=stubCanvas();
    measurePageText('Song',18);
    expect(fonts.at(-1)).toBe('18px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"');
    measurePageText('Song',18,{family:null,bold:false,italic:false});
    expect(fonts.at(-1)).toBe('18px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"');
    measurePageText('Song',18,{family:'TabPlayer Serif',bold:true,italic:true});
    expect(fonts.at(-1)).toBe('italic bold 18px "TabPlayer Serif", "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"');
    measurePageText('Song',20,{family:null,bold:true,italic:false});
    expect(fonts.at(-1)).toBe('bold 20px "Noto Sans", "Noto Sans CJK JP", "Noto Emoji"');
  });
  it('a_bold_header_measures_wider_and_shrinks',()=>{
    stubCanvas();
    const text='W'.repeat(100),bold={family:null,bold:true,italic:false},regular={family:null,bold:false,italic:false};
    expect(measurePageText(text,18,bold)!).toBeGreaterThan(measurePageText(text,18,regular)!);
    const hf=defaultHeaderFooter();hf.first.header={left:'',center:text,right:''};
    const wide=pageTextItems({...common,bands:hf.first,page:1,headerFont:{...bold,family:'TabPlayer Sans',scale:null}}).header[0];
    const normal=pageTextItems({...common,bands:hf.first,page:1}).header[0];
    expect(wide.size).toBeLessThan(normal.size);
    expect(pageTitleFontSize(text,d.usableWidth,1,bold)).toBeLessThan(pageTitleFontSize(text,d.usableWidth,1,regular));
    const title=pageTextItems({...common,title:text,bands:null,page:1,headerFont:{...bold,family:'TabPlayer Sans',scale:null}}).header[0];
    expect(title.size).toBeLessThan(pageTitleFontSize(text,d.usableWidth,1));
  });
  it('baseline_follows_the_header_role_size_in_export_pages',()=>{
    const sys=[{width:300,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}];
    const y=(svg:string)=>Number(/<text x="[^"]*" y="([^"]*)"/.exec(svg)![1]);
    const l=layout(),base=paginateEngravedSystems(sys,'Song',l,fields)[0].svg;
    const big=paginateEngravedSystems(sys,'Song',l,fields,1,undefined,undefined,pageRoleFont({roles:{pageHeader:{size:2}}},'pageHeader'))[0].svg;
    expect(y(big)).toBeGreaterThan(y(base));
    // 18*2*.8 = 28.8 above the margin; the role size wins over a titleScale of 2 only by being the same, and over it when smaller.
    const g=pageGeometry(l);
    expect(y(big)).toBeCloseTo(g.top+28.8,5);
    const scaled=paginateEngravedSystems(sys,'Song',l,fields,2)[0].svg;
    const overridden=paginateEngravedSystems(sys,'Song',l,fields,2,undefined,undefined,pageRoleFont({roles:{pageHeader:{size:.5}}},'pageHeader'))[0].svg;
    expect(y(scaled)).toBeCloseTo(g.top+28.8,5);expect(y(overridden)).toBeCloseTo(g.top+22,5);
    expect(big).toContain('font-size="36"');
  });
  it('screen_baselines_take_the_effective_header_scale',()=>{
    const g=pageGeometry(layout(0));
    expect(screenPageBaselines(g,2).headerY).toBeCloseTo(28.8,5);
    expect(screenPageBaselines(g,.5).headerY).toBeCloseTo(7.2,5);
  });
});
