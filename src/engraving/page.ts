import type { PrintLayout,SvgPage,SvgSystem } from '../export/types';
import type { PageLayout } from './types';
import {measurePageText,pageTitleFontSize} from '../export/page-title';
import {fillHeaderField,validateHeaderFooter,type HeaderFields,type PageBand} from './header-footer';

export interface PageGeometry {
  widthMm:number;heightMm:number;width:number;height:number;
  left:number;top:number;right:number;bottom:number;
  usableWidth:number;usableHeight:number;
}
const pxPerMm=96/25.4;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const keys=(value:unknown,names:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const escaped=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));

export function effectivePageLayout(settings:{page:PageLayout|null;print:PrintLayout}):PageLayout {
  let page=settings.page;
  if(page===null) {
    const print=settings.print;
    if(!['A4','Letter'].includes(print.paper)||!['portrait','landscape'].includes(print.orientation))throw new Error('Choose a supported paper size and orientation.');
    if(!['ScoreTab','Score','Tab'].includes(print.profile))throw new Error('Choose a supported legacy print profile.');
    let [widthMm,heightMm]=print.paper==='A4'?[210,297]:[215.9,279.4];
    if(print.orientation==='landscape')[widthMm,heightMm]=[heightMm,widthMm];
    page={widthMm,heightMm,marginsMm:{top:print.marginMm,right:print.marginMm,bottom:print.marginMm,left:print.marginMm},scale:print.scale,profile:print.profile};
  }
  validatePageLayout(page);
  return structuredClone(page);
}

export function validatePageLayout(value:unknown):asserts value is PageLayout {
  // An undefined header and footer is absent, as it is once serialized for the native side.
  const own=!!value&&typeof value==='object'&&Object.hasOwn(value,'headerFooter'),custom=own&&(value as {headerFooter?:unknown}).headerFooter!==undefined;
  if(!keys(value,['widthMm','heightMm','marginsMm','scale','profile',...own?['headerFooter']:[]]))throw new Error('Invalid page layout fields.');
  if(![value.widthMm,value.heightMm].every(n=>finite(n)&&n>=20&&n<=1000))throw new Error('Page width and height must be between 20 and 1000 mm.');
  if(!keys(value.marginsMm,['top','right','bottom','left'])||!Object.values(value.marginsMm).every(n=>finite(n)&&n>=0))throw new Error('Page margins must be finite and nonnegative.');
  if(!finite(value.scale)||value.scale<0.25||value.scale>3)throw new Error('Print scale must be between 25% and 300%.');
  if(!['document','ScoreTab','Score','Tab'].includes(value.profile as string))throw new Error('Choose a supported page notation profile.');
  if(custom)validateHeaderFooter(value.headerFooter);
  const page=value as unknown as PageLayout,m=page.marginsMm;
  if(page.widthMm*pxPerMm-(m.left*pxPerMm+m.right*pxPerMm)<100||page.heightMm*pxPerMm-(m.top*pxPerMm+m.bottom*pxPerMm)-64<100)throw new Error('Reduce the page margins to leave usable notation width and height.');
}

export function pageGeometry(layout:PageLayout):PageGeometry {
  validatePageLayout(layout);
  const {widthMm,heightMm}=layout,width=widthMm*pxPerMm,height=heightMm*pxPerMm;
  const left=layout.marginsMm.left*pxPerMm,top=layout.marginsMm.top*pxPerMm,right=layout.marginsMm.right*pxPerMm,bottom=layout.marginsMm.bottom*pxPerMm;
  return {widthMm,heightMm,width,height,left,top,right,bottom,usableWidth:width-(left+right),usableHeight:height-(top+bottom)-64};
}

const font='font-family="Noto Sans, Noto Sans CJK JP, Noto Emoji"';
const gap=12,minimumSize=5;
/** Score metadata may hold line breaks or characters XML cannot carry; a page line prints them as spaces. */
const printable=(text:string)=>text.replace(/[\t\n\r]+/g,' ').replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,'');
/** Fits text to a width: shrinks it, down to a legible floor, then shortens it with an ellipsis. */
function fit(text:string,width:number,base:number):{text:string;size:number;width:number} {
  const measured=measurePageText(text,base);
  if(measured===null||measured<=width)return {text,size:base,width:measured??width};
  const size=Math.max(minimumSize,base*(width-1)/measured);
  if(measured*size/base<=width)return {text,size,width:measured*size/base};
  const characters=[...text];
  while(characters.length&&(measurePageText(characters.join('')+'…',size)??0)>width)characters.pop();
  const shortened=characters.join('')+'…';
  return {text:shortened,size,width:measurePageText(shortened,size)??width};
}
/** One header or footer line: left and right slots run from the margins toward a centered slot, never into it. */
function band(texts:PageBand,fields:HeaderFields,page:number,pages:number,d:PageGeometry,y:number,base:number):string {
  const value=(slot:keyof PageBand)=>printable(fillHeaderField(texts[slot],fields,page,pages));
  const left=value('left'),center=value('center'),right=value('right'),start=d.left,end=d.width-d.right,middle=d.width/2;
  const line=(x:number,anchor:string,fitted:{text:string;size:number})=>`<text x="${x}" y="${y}"${anchor} ${font} font-size="${fitted.size}">${escaped(fitted.text)}</text>`;
  let half=0,centered='';
  if(center){
    // The centered slot keeps a third of the line when side slots share it, and never crosses a margin.
    const room=2*Math.min(middle-start,end-middle),fitted=fit(center,left||right?Math.min(room,d.usableWidth/3):room,base);
    half=fitted.width/2;centered=line(middle,' text-anchor="middle"',fitted);
  }
  const sides=left&&right&&!center?(d.usableWidth-gap)/2:null;
  const leftLine=left?line(start,'',fit(left,sides??(center?middle-half-gap-start:d.usableWidth),base)):'';
  const rightLine=right?line(end,' text-anchor="end"',fit(right,sides??(center?end-(middle+half+gap):d.usableWidth),base)):'';
  return leftLine+centered+rightLine;
}

/** `titleScale` enlarges the header line (base 18px) and still shrinks it to fit the page width; the footer keeps its size. */
export function paginateEngravedSystems(systems:SvgSystem[],title:string,layout:PageLayout,fields?:HeaderFields,titleScale=1):SvgPage[] {
  const d=pageGeometry(layout),titleSize=pageTitleFontSize(title,d.usableWidth,titleScale),headerBase=18*titleScale,headerY=d.top+Math.min(31,Math.max(22,headerBase*.8)),groups:SvgSystem[][]=[[]];let height=0;
  for(const system of systems) {
    // alphaTab may round the reported system width by one pixel, as in legacy export.
    if(!finite(system.height)||system.height<=0||system.height>d.usableHeight||!finite(system.width)||system.width<=0||system.width>d.usableWidth+1)throw new Error('A notation system does not fit this page. Reduce print scale, use landscape, or export fewer staves.');
    if(height+system.height>d.usableHeight){groups.push([]);height=0;}
    groups.at(-1)!.push(system);height+=system.height;
  }
  const custom=layout.headerFooter,values:HeaderFields=fields??{TITLE:title,SUBTITLE:'',ARTIST:'',ALBUM:'',WORDS:'',MUSIC:'',COPYRIGHT:'',TABBER:'',INSTRUCTIONS:'',NOTICES:''};
  return groups.map((group,index)=>{
    let y=d.top+40;
    const content=group.map(system=>{const at=y;y+=system.height;return `<g transform="translate(${d.left} ${at})">${system.svg.replace(/<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'')}</g>`;}).join('');
    const bands=custom&&(index?custom.other:custom.first);
    const header=bands?band(bands.header,values,index+1,groups.length,d,headerY,headerBase):`<text x="${d.left}" y="${headerY}" ${font} font-size="${titleSize}">${escaped(title)}</text>`;
    const footer=bands?band(bands.footer,values,index+1,groups.length,d,d.height-d.bottom,11):`<text x="${d.width/2}" y="${d.height-d.bottom}" text-anchor="middle" ${font} font-size="11">${index+1} / ${groups.length}</text>`;
    return {widthMm:d.widthMm,heightMm:d.heightMm,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${d.widthMm}mm" height="${d.heightMm}mm" viewBox="0 0 ${d.width} ${d.height}"><style>.at{font-family:Bravura;font-size:34px}text{fill:#111}</style>${header}${content}${footer}</svg>`};
  });
}
