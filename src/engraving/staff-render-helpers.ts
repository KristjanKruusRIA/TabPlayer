import { createHash } from 'node:crypto';
import { rendering,Settings,type model } from '@coderline/alphatab';
import { vi } from 'vitest';
import { renderPdfPages } from '../export/pdf';
import type { SvgPage } from '../export/types';
import { defaultPrintLayout } from '../document-settings';
import { accoladeMetrics } from './accolades';
import { threeTrackScore } from './staff-fixtures';
import type { ScreenBounds } from './screen-pages';
import type { EngravingOverrides,PageLayout } from './types';

/**
 * Real-renderer helpers for the staff group and staff gap tests (Tasks 5 and 6). Everything is read back from the exported page SVG
 * or from alphaTab's own bounds; none of it calls the production composition code, so a test cannot pass by repeating the code under test.
 * The SVG readers need a DOM (`// @vitest-environment jsdom`).
 */
const pxPerMm=96/25.4;

/** A4, 15 mm margins, scale 1, notation profile as the document has it. */
export const a4Page=():PageLayout=>({widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document'});

export interface ExportInput {engraving:EngravingOverrides;rendered?:number[];score?:model.Score;ids?:string[];page?:PageLayout}

function exportOf(input:ExportInput):SvgPage[] {
  const fixture=input.score?{score:input.score,ids:input.ids??input.score.tracks.map((_,index)=>`base/${index}`)}:threeTrackScore();
  const rendered=input.rendered??fixture.score.tracks.map((_,index)=>index);
  return renderPdfPages(fixture.score,{tracks:rendered,range:null},defaultPrintLayout(),{page:input.page??a4Page(),engraving:input.engraving,trackIds:fixture.ids});
}

/** The pages `renderPdfPages` gives for the shared three-track score (or `score`), exported with `engraving` on A4 at scale 1. */
export const exportPages=(input:ExportInput):SvgPage[]=>exportOf(input);

/**
 * `pages` with alphaTab's per-beat class numbers (`class="b1536"`, from a counter shared by the whole process, so they depend on how many
 * scores were built before) replaced by `b`. Everything else is untouched.
 */
export const stablePages=(pages:SvgPage[]):SvgPage[]=>pages.map(page=>({...page,svg:page.svg.replace(/class="b\d+"/g,'class="b"')}));

/** SHA-256 hex of the JSON of `stablePages(pages)`. */
export const pagesHash=(pages:SvgPage[]):string=>createHash('sha256').update(JSON.stringify(stablePages(pages))).digest('hex');

/** The right edge of the usable page width, in page pixels. */
export const usableRight=(page:SvgPage,marginMm=15):number=>(page.widthMm-marginMm)*pxPerMm;

/** Occurrences of `needle` in `svg`. */
export const countText=(svg:string,needle:string):number=>needle?svg.split(needle).length-1:0;

/** `svg` without every `<g data-tp-accolade=...>...</g>`, nested groups included. */
export function withoutMarks(svg:string):string {
  let out='',at=0;
  for(;;) {
    const start=svg.indexOf('<g data-tp-accolade=',at);
    if(start<0)return out+svg.slice(at);
    out+=svg.slice(at,start);
    const tags=/<g\b|<\/g>/g;tags.lastIndex=start;let depth=0,end=-1;
    for(let tag=tags.exec(svg);tag;tag=tags.exec(svg)) {
      depth+=tag[0]==='</g>'?-1:1;
      if(!depth){end=tag.index+tag[0].length;break;}
    }
    if(end<0)throw new Error('Unbalanced accolade group.');
    at=end;
  }
}

const parse=(svg:string)=>new DOMParser().parseFromString(`<tp-root>${svg}</tp-root>`,'image/svg+xml');
const NUMBER='-?[\\d.]+(?:e[-+]?\\d+)?';
const TRANSLATE=new RegExp(`translate\\(\\s*(${NUMBER})[\\s,]+(${NUMBER})\\s*\\)`);
const translateOf=(node:Element):[number,number]=>{const m=TRANSLATE.exec(node.getAttribute('transform')??'');return m?[Number(m[1]),Number(m[2])]:[0,0];};
/** Sum of every translate from `node` up to the document root. */
function offsetOf(node:Element|null):[number,number] {
  let x=0,y=0;
  for(;node;node=node.parentElement){const [dx,dy]=translateOf(node);x+=dx;y+=dy;}
  return [x,y];
}
const sizeOf=(node:Element)=>parseFloat(/(\d+(?:\.\d+)?)px/.exec(node.getAttribute('style')??'')?.[1]??'12');

interface Band {start:number;end:number;shift:number}
/** One notation system on a page: its `<g transform="translate(left top)">` wrapper, which is a direct child of the page root. */
interface Frame {page:number;wrapper:Element;left:number;top:number;width:number;bands:Band[]}

/** Systems in order across all pages. A chunk without a staff (the tuning line) is not a system. Band wrappers inside a system are ignored. */
function framesOf(doc:Document):Frame[] {
  const frames:Frame[]=[];
  [...doc.documentElement.children].forEach((root,page)=>{
    for(const wrapper of [...root.children].filter(child=>child.tagName==='g'&&child.hasAttribute('transform'))) {
      const rects=[...wrapper.querySelectorAll('rect')].filter(rect=>!rect.closest('clipPath'));
      if(!rects.length)continue;
      const [left,top]=translateOf(wrapper),width=Math.max(...rects.map(rect=>Number(rect.getAttribute('x')??0)+Number(rect.getAttribute('width')??0)));
      const bands=[...wrapper.querySelectorAll('use')].map(use=>{
        const clip=/url\(#([^)]+)\)/.exec(use.getAttribute('clip-path')??'')?.[1],rect=clip?[...wrapper.querySelectorAll('clipPath')].find(node=>node.getAttribute('id')===clip)?.querySelector('rect'):null;
        if(!rect)throw new Error('A band without a clip.');
        const start=Number(rect.getAttribute('y')),height=Number(rect.getAttribute('height'));
        return {start,end:start+height,shift:translateOf(use.parentElement!)[1]};
      });
      frames.push({page,wrapper,left,top,width,bands});
    }
  });
  return frames;
}
/** The page y of a point at `y` in a system's unshifted coordinates, read from the bands the page shows. Where bands overlap the lower one wins. */
const pageY=(frame:Frame,y:number)=>frame.top+y+([...frame.bands].reverse().find(band=>y>=band.start&&y<band.end)?.shift??0);

/** Each system's translate and width (the right end of its staff lines, or of its clip). */
export const systemBoxes=(svg:string):Array<{left:number;top:number;width:number;page:number}>=>framesOf(parse(svg)).map(({left,top,width,page})=>({left,top,width,page}));

export interface MarkBox {system:number;role:string;kind:string;x:number;width:number;top:number;bottom:number}
/** Every drawn accolade, in page pixels: a bracket from its rect, a brace from its translate, font-size and optional x compression. */
export function markBoxes(svg:string):MarkBox[] {
  const doc=parse(svg),metrics=accoladeMetrics(new Settings()),frames=framesOf(doc);
  return [...doc.querySelectorAll('[data-tp-accolade]')].map(node=>{
    const [role,kind]=node.getAttribute('data-tp-accolade')!.split('-'),system=frames.findIndex(frame=>frame.wrapper.contains(node)),[ox,oy]=offsetOf(node.parentElement);
    if(kind==='bracket') {
      const rect=node.querySelector('rect')!,x=Number(rect.getAttribute('x')),y=Number(rect.getAttribute('y'));
      return {system,role,kind,x:ox+x,width:Number(rect.getAttribute('width')),top:oy+y,bottom:oy+y+Number(rect.getAttribute('height'))};
    }
    const holder=node.querySelector('g')!,transform=holder.getAttribute('transform')!,[x,y]=translateOf(holder);
    const compress=/scale\(([-\d.e]+) 1\)/.exec(transform),xScale=compress?Number(compress[1]):1;
    const factor=Number(/font-size: ([-\d.e]+)%/.exec(node.querySelector('text')!.getAttribute('style')!)![1])/100/metrics.scale;
    return {system,role,kind,x:ox+x,width:metrics.brace.width*factor*xScale,top:oy+y-metrics.brace.height*factor,bottom:oy+y};
  });
}

/** The names and short names of a score's tracks. */
export const trackNames=(score:model.Score):string[]=>score.tracks.flatMap(track=>[track.name,track.shortName]).filter(name=>name.length>0);

export interface NameBox {system:number;text:string;left:number;right:number}
/**
 * Track names in page pixels: the text items alphaTab fills with its name colour whose content is one of `names` (see `trackNames`). A horizontal name ends where `text-anchor` puts it
 * (width 0.55 em per character, as the test text measure assumes); a vertical name is a rotated text whose baseline is the translate x.
 */
export function nameBoxes(svg:string,names:readonly string[]):NameBox[] {
  const doc=parse(svg),frames=framesOf(doc);
  return [...doc.querySelectorAll('text')].filter(node=>node.getAttribute('fill')==='#222211'&&names.includes(node.textContent?.trim()??'')).map(node=>{
    const system=frames.findIndex(frame=>frame.wrapper.contains(node)),text=node.textContent!.trim(),[ox]=offsetOf(node),x=ox+Number(node.getAttribute('x')??0);
    if(/rotate/.test(node.parentElement?.getAttribute('transform')??''))return {system,text,left:ox-sizeOf(node),right:ox};
    const width=[...text].length*sizeOf(node)*.55,anchor=node.getAttribute('text-anchor')??'start';
    const right=anchor==='end'?x:anchor==='middle'?x+width/2:x+width;
    return {system,text,left:right-width,right};
  });
}

/** Text content of each system's text items, in drawing order (music glyphs left out). */
export function systemTexts(input:ExportInput):string[][] {
  const doc=parse(exportOf(input).map(page=>page.svg).join('')),frames=framesOf(doc);
  const texts=frames.map(()=>[] as string[]);
  for(const node of doc.querySelectorAll('text')) {
    const system=frames.findIndex(frame=>frame.wrapper.contains(node)),text=node.textContent?.trim();
    if(system>=0&&text&&!/^[-]+$/u.test(text))texts[system].push(text);
  }
  return texts;
}

/** Every alphaTab brace glyph (U+E000) the pages draw: the page y of its baseline and its font size as a factor of the render scale. */
export function braceGlyphs(pages:SvgPage[]):Array<{y:number;scale:number}> {
  const doc=parse(pages.map(page=>page.svg).join(''));
  return [...doc.querySelectorAll('g.at')].filter(node=>node.querySelector('text')?.textContent===String.fromCharCode(0xE000))
    .map(node=>({y:offsetOf(node)[1],scale:Number(/font-size: ([-\d.e]+)%/.exec(node.querySelector('text')!.getAttribute('style')??'')?.[1]??100)/100}));
}
/** Page y of the baseline of every alphaTab brace glyph the pages draw. */
export const braceBaselines=(pages:SvgPage[]):number[]=>braceGlyphs(pages).map(glyph=>glyph.y);

export interface RenderedChunk {x:number;y:number;width:number;height:number;firstBar?:number}
/** What the renderer saw during one export: its chunks and its staff bounds. */
export interface RenderProbe {chunks:RenderedChunk[];bounds:ScreenBounds|null}
/** Runs `run` while recording every chunk the renderer finishes and its bounds just before it is destroyed. */
function probing<T>(run:()=>T):{value:T;probe:RenderProbe} {
  const probe:RenderProbe={chunks:[],bounds:null},prototype=rendering.ScoreRenderer.prototype,render=prototype.renderScore,destroy=prototype.destroy;
  const spyRender=vi.spyOn(prototype,'renderScore').mockImplementation(function(this:rendering.ScoreRenderer,...args:Parameters<typeof render>){
    this.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string'&&e.height>0)probe.chunks.push({x:e.x,y:e.y,width:e.width,height:e.height,...e.firstMasterBarIndex>=0?{firstBar:e.firstMasterBarIndex}:{}});});
    return render.apply(this,args);
  });
  const spyDestroy=vi.spyOn(prototype,'destroy').mockImplementation(function(this:rendering.ScoreRenderer){probe.bounds=(this.boundsLookup as ScreenBounds|undefined)??null;return destroy.call(this);});
  try{return {value:run(),probe};}finally{spyRender.mockRestore();spyDestroy.mockRestore();}
}

export interface SystemMeasure {
  /** Page y of each system's top (the wrapper's translate). */
  systemTops:number[];
  /** Height of each system as exported: the renderer's chunk height plus the shift of its last band. */
  systemHeights:number[];
  /** Page y of the top of each track's staves in each system, from alphaTab's bounds read through the bands the page shows. */
  trackTops:number[][];
  guitarTop:number[];guitarBottom:number[];pianoTop:number[];pianoBottom:number[];
}
export interface MeasuredExport extends SystemMeasure {pages:SvgPage[];svg:string;bounds:Array<{guitarTop:number;guitarBottom:number;pianoTop:number;pianoBottom:number}>}

/** `exportPages` plus the per-system geometry of the render behind it. `bounds[i]` is system i's guitar (track 0) and piano (track 1) extent. */
export function exportWithBounds(input:ExportInput):MeasuredExport {
  const {value:pages,probe}=probing(()=>exportOf(input)),svg=pages.map(page=>page.svg).join(''),frames=framesOf(parse(svg));
  const chunks=probe.chunks.filter(chunk=>chunk.firstBar!==undefined);
  if(!probe.bounds||frames.length!==chunks.length)throw new Error(`Expected ${chunks.length} systems on the pages, found ${frames.length}.`);
  const tracks=frames.map((frame,i)=>{
    const system=probe.bounds!.staffSystems.find(candidate=>candidate.bars[0].index===chunks[i].firstBar);
    if(!system)throw new Error('A system has no bounds.');
    const extent=new Map<number,{top:number;bottom:number}>();
    for(const master of system.bars)for(const entry of master.bars) {
      const index=entry.bar.staff.track.index,top=entry.realBounds.y,bottom=top+entry.realBounds.h,found=extent.get(index);
      extent.set(index,found?{top:Math.min(found.top,top),bottom:Math.max(found.bottom,bottom)}:{top,bottom});
    }
    const place=(index:number)=>{const found=extent.get(index);return found?{top:pageY(frame,found.top-chunks[i].y),bottom:pageY(frame,found.bottom-chunks[i].y)}:{top:NaN,bottom:NaN};};
    return [0,1,2].map(place);
  });
  const bounds=tracks.map(([guitar,piano])=>({guitarTop:guitar.top,guitarBottom:guitar.bottom,pianoTop:piano.top,pianoBottom:piano.bottom}));
  return {
    pages,svg,bounds,systemTops:frames.map(frame=>frame.top),
    systemHeights:frames.map((frame,i)=>chunks[i].height+(frame.bands.at(-1)?.shift??0)),
    trackTops:tracks.map(row=>row.map(track=>track.top)),
    guitarTop:bounds.map(b=>b.guitarTop),guitarBottom:bounds.map(b=>b.guitarBottom),pianoTop:bounds.map(b=>b.pianoTop),pianoBottom:bounds.map(b=>b.pianoBottom),
  };
}

/**
 * jsdom has no layout: gives canvas text and SVG text a deterministic width of 0.55 em per character (a quarter-turn text is one line high),
 * so `assertTextFits` measures something (and text under `<defs>` has no box, as in a browser). Call it in `beforeEach` and undo it with `vi.restoreAllMocks()`.
 */
export function installTextMeasure():void {
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(this:HTMLCanvasElement){
    const context={font:'',measureText(text:string){return {width:[...text].length*parseFloat(context.font)*.55};}};return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
    const box=(left:number,width:number)=>({left,right:left+width,width,top:0,bottom:0,height:0}) as DOMRect;
    if(this.tagName.toLowerCase()==='svg')return box(0,parseFloat(this.getAttribute('width')??'0'));
    // A browser lays out no box for text that is only defined under <defs>; measuring composed systems must therefore find nothing.
    if(this.tagName.toLowerCase()!=='text'||this.closest('defs'))return box(0,0);
    const size=sizeOf(this),width=[...(this.textContent??'')].length*size*.55,anchor=this.getAttribute('text-anchor')??'start';
    let shift=0,vertical=false;
    for(let node:Element|null=this.parentElement;node;node=node.parentElement){shift+=translateOf(node)[0];if(/rotate\(\s*-?(?:90|89|91)/.test(node.getAttribute('transform')??''))vertical=true;}
    if(vertical)return box(shift-size/2,size);
    const x=shift+parseFloat(this.getAttribute('x')??'0');
    return box(anchor==='middle'?x-width/2:anchor==='end'?x-width:x,width);
  });
}
