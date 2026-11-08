// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { music } from '../editor/fixtures';
import { defaultEngraving } from '../engraving/projection';
import { paginateEngravedSystems } from '../engraving/page';
import { withTypography } from '../engraving/typography';
import type { EngravingTypography } from '../engraving/types';
import { setLanguagePreference } from '../i18n';
import { renderPdfPages } from './pdf';
import { assertTextFits,measureSystemText,overflowingText } from './text-bounds';

const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const};
const typography=(over:Partial<EngravingTypography>):EngravingTypography=>({family:'inherit',textScale:null,titleScale:null,tabScale:null,...over});
const options=(over:Partial<EngravingTypography>)=>({page,engraving:withTypography(defaultEngraving(),typography(over)),trackIds:['base/0']});

// jsdom has no layout: give text a deterministic width of 0.55 em per character, anchored like the SVG says.
const sizeOf=(node:Element)=>parseFloat(/(\d+(?:\.\d+)?)px/.exec(node.getAttribute('style')??'')?.[1]??node.getAttribute('font-size')??'12');
beforeEach(()=>{
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(this:HTMLCanvasElement){
    const context={font:'',measureText(text:string){return {width:[...text].length*parseFloat(context.font)*.55};}};return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
    if(this.tagName.toLowerCase()==='svg'){const width=parseFloat(this.getAttribute('width')??'0');return {left:0,right:width,width,top:0,bottom:0,height:0} as DOMRect;}
    if(this.tagName.toLowerCase()!=='text')return {left:0,right:0,width:0,top:0,bottom:0,height:0} as DOMRect;
    const size=sizeOf(this),width=[...(this.textContent??'')].length*size*.55,anchor=this.getAttribute('text-anchor')??'start';
    // Ancestor translations move the text; a quarter-turn (vertical track names) makes its width the line height.
    let shift=0,vertical=false;for(let node:Element|null=this.parentElement;node;node=node.parentElement){const transform=node.getAttribute('transform')??'';shift+=Number(/translate\(\s*(-?[\d.]+)/.exec(transform)?.[1]??0);if(/rotate\(\s*-?(?:90|89|91)/.test(transform))vertical=true;}
    if(vertical)return {left:shift-size/2,right:shift+size/2,width:size,top:0,bottom:0,height:0} as DOMRect;
    const x=shift+parseFloat(this.getAttribute('x')??'0'),left=anchor==='middle'?x-width/2:anchor==='end'?x-width:x;return {left,right:left+width,width,top:0,bottom:0,height:0} as DOMRect;
  });
});
afterEach(()=>vi.restoreAllMocks());
const withText=(text:string)=>{const score=music();score.tracks[0].staves[0].bars[0].voices[0].beats[0].text=text;return score;};

it('overflowingText_reports_text_that_starts_left_of_or_ends_beyond_the_width',()=>{
  const boxes=[{text:'in',left:0,right:100},{text:'right',left:500,right:702},{text:'left',left:-3,right:20},{text:'edge',left:0,right:700.5}];
  expect(overflowingText(boxes,700)).toEqual(['right','left']);expect(overflowingText([],700)).toEqual([]);
});

it('overflowingText_allows_the_page_margin_because_only_the_paper_edge_clips',()=>{
  const boxes=[{text:'Gtr',left:-12,right:4},{text:'end',left:690,right:712}];
  expect(overflowingText(boxes,700,20)).toEqual([]);expect(overflowingText(boxes,700,10)).toEqual(['Gtr','end']);
});

it('assertTextFits_names_the_first_offending_text_and_the_settings_to_change',()=>{
  const systems=[{svg:'<svg/>',width:700,height:50}];
  expect(()=>assertTextFits(systems,700,0,()=>[{text:'ok',left:0,right:50}])).not.toThrow();
  expect(()=>assertTextFits(systems,700,0,()=>[{text:'Cmaj7(♯11)/G',left:650,right:760}])).toThrow(/"Cmaj7\(♯11\)\/G" does not fit the page width.*Reduce Text size/);
  expect(()=>assertTextFits(systems,700,0,()=>[{text:'x'.repeat(40),left:0,right:900}])).toThrow(/"x{29}…"/);
});

it('measureSystemText_reads_text_extents_in_system_pixels_and_skips_empty_text',()=>{
  const svg='<svg width="400" xmlns="http://www.w3.org/2000/svg"><text x="10" style="font:20px Arial">abcd</text><text x="200" text-anchor="end" font-size="10"> </text><text x="390" style="font:10px Arial">xyz</text><text x="-5" style="font:34px Bravura"></text></svg>';
  const boxes=measureSystemText({svg,width:400,height:40});
  expect(boxes.map(box=>[box.text,Math.round(box.left),Math.round(box.right)])).toEqual([['abcd',10,54],['xyz',390,407]]);
  // (the private-use music glyph at x=-5 is not measured);
  expect(document.body.children).toHaveLength(0);
});

it('title_size_scales_the_exported_page_header_and_still_fits_the_page_width',()=>{
  const systems=[{svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>',width:400,height:100}];
  const header=(title:string,scale?:number)=>{const svg=paginateEngravedSystems(systems,title,page,undefined,scale)[0].svg,match=/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="([\d.]+)">/.exec(svg)!;return {y:Number(match[1]),size:Number(match[2])};};
  expect(header('Song').size).toBe(18);expect(header('Song',2).size).toBe(36);expect(header('Song',.5).size).toBe(9);
  // The line stays inside the 40px reserved above the notation, whatever the size.
  expect(header('Song',2).y).toBeGreaterThan(header('Song').y);expect(header('Song',2).y+36*.25).toBeLessThan(40+15*96/25.4);
  // A 30-character title at 200% would run past the page; it is shrunk until it fits the usable width.
  const long=header('A forty-five character song title, quite long.',2),usable=(210-30)*96/25.4;
  expect(long.size).toBeLessThan(36);expect(45*long.size*.55).toBeLessThanOrEqual(usable);
});

it('export_refuses_enlarged_text_that_would_run_past_the_page_and_accepts_text_that_fits',()=>{
  const fits=withText('Short');  expect(()=>renderPdfPages(fits,{tracks:[0],range:null},layout,options({textScale:2}))).not.toThrow();
  // A long annotation, a long chord-sized name and CJK text, each at the largest size.
  for(const text of ['A long annotation line that surely needs more than the room left at the end of the bar, and then some more words','同じ楽譜を漢字かな交じり文で長く書いた注釈の行がページの幅を越えてしまう場合のための確認用の文章です。']){
    const long=withText(text);
    expect(()=>renderPdfPages(long,{tracks:[0],range:null},layout,options({textScale:2})),text).toThrow(/does not fit the page width/);
    // The refusal belongs to the enlarged text: the same score exports at the default size, as before.
    expect(()=>renderPdfPages(long,{tracks:[0],range:null},layout,options({}))).not.toThrow();
  }
});

it('assertTextFits_mentions_a_role_size_only_when_one_is_set',()=>{
  const systems=[{svg:'<svg/>',width:700,height:50}],over=()=>[{text:'Intro',left:650,right:760}];
  expect(()=>assertTextFits(systems,700,0,over)).toThrow(/Reduce Text size/);
  expect(()=>assertTextFits(systems,700,0,over)).not.toThrow(/role/);
  expect(()=>assertTextFits(systems,700,0,over,['Lyrics','Staff text'])).toThrow(/Reduce Text size.*size chosen for Lyrics and Staff text/);
});

it('export_refuses_an_enlarged_role_and_names_it',()=>{
  const long=withText('A long annotation line that surely needs more than the room left at the end of the bar, and then some more words');
  const fonts=(size:number)=>({...defaultEngraving(),fonts:{roles:{staffText:{size}}}});
  expect(()=>renderPdfPages(long,{tracks:[0],range:null},layout,{page,engraving:fonts(2),trackIds:['base/0']})).toThrow(/does not fit the page width.*size chosen for Staff text/);
  expect(()=>renderPdfPages(withText('Short'),{tracks:[0],range:null},layout,{page,engraving:fonts(2),trackIds:['base/0']})).not.toThrow();
});

it('the_fit_check_message_and_role_names_follow_the_language',()=>{
  const systems=[{svg:'<svg/>',width:700,height:50}],over=()=>[{text:'Cmaj7',left:650,right:760}];
  try{
    setLanguagePreference('de');
    expect(()=>assertTextFits(systems,700,0,over)).toThrow('Der Text „Cmaj7“ passt nicht in die Seitenbreite. Verringere „Textgröße“, „Größe der Tabulaturzahlen“ oder den Druckmaßstab, oder verwende eine breitere Seite.');
    setLanguagePreference('et');
    expect(()=>assertTextFits(systems,700,0,over)).toThrow('Tekst „Cmaj7“ ei mahu lehe laiusesse. Vähenda väärtust „Teksti suurus“ või „Tabulatuurinumbrite suurus“, printimise skaalat või kasuta laiemat lehte.');
    // The role names are the font role labels, joined in the language.
    const long=withText('A long annotation line that surely needs more than the room left at the end of the bar, and then some more words');
    setLanguagePreference('de');
    const fonts={...defaultEngraving(),fonts:{roles:{staffText:{size:2},lyrics:{size:2}}}};
    expect(()=>renderPdfPages(long,{tracks:[0],range:null},layout,{page,engraving:fonts,trackIds:['base/0']})).toThrow(/passt nicht in die Seitenbreite.*gewählte Schriftgröße [(]Notensystemtext und Songtext[)]/);
  }finally{setLanguagePreference('en');}
});
