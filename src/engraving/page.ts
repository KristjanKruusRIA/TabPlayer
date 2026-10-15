import type { PrintLayout,SvgPage,SvgSystem } from '../export/types';
import type { PageLayout } from './types';

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
  return {...page,marginsMm:{...page.marginsMm}};
}

export function validatePageLayout(value:unknown):asserts value is PageLayout {
  if(!keys(value,['widthMm','heightMm','marginsMm','scale','profile']))throw new Error('Invalid page layout fields.');
  if(![value.widthMm,value.heightMm].every(n=>finite(n)&&n>=20&&n<=1000))throw new Error('Page width and height must be between 20 and 1000 mm.');
  if(!keys(value.marginsMm,['top','right','bottom','left'])||!Object.values(value.marginsMm).every(n=>finite(n)&&n>=0))throw new Error('Page margins must be finite and nonnegative.');
  if(!finite(value.scale)||value.scale<0.25||value.scale>3)throw new Error('Print scale must be between 25% and 300%.');
  if(!['document','ScoreTab','Score','Tab'].includes(value.profile as string))throw new Error('Choose a supported page notation profile.');
  const page=value as unknown as PageLayout,m=page.marginsMm;
  if(page.widthMm*pxPerMm-(m.left*pxPerMm+m.right*pxPerMm)<100||page.heightMm*pxPerMm-(m.top*pxPerMm+m.bottom*pxPerMm)-64<100)throw new Error('Reduce the page margins to leave usable notation width and height.');
}

export function pageGeometry(layout:PageLayout):PageGeometry {
  validatePageLayout(layout);
  const {widthMm,heightMm}=layout,width=widthMm*pxPerMm,height=heightMm*pxPerMm;
  const left=layout.marginsMm.left*pxPerMm,top=layout.marginsMm.top*pxPerMm,right=layout.marginsMm.right*pxPerMm,bottom=layout.marginsMm.bottom*pxPerMm;
  return {widthMm,heightMm,width,height,left,top,right,bottom,usableWidth:width-(left+right),usableHeight:height-(top+bottom)-64};
}

export function paginateEngravedSystems(systems:SvgSystem[],title:string,layout:PageLayout):SvgPage[] {
  const d=pageGeometry(layout),groups:SvgSystem[][]=[[]];let height=0;
  for(const system of systems) {
    // alphaTab may round the reported system width by one pixel, as in legacy export.
    if(!finite(system.height)||system.height<=0||system.height>d.usableHeight||!finite(system.width)||system.width<=0||system.width>d.usableWidth+1)throw new Error('A notation system does not fit this page. Reduce print scale, use landscape, or export fewer staves.');
    if(height+system.height>d.usableHeight){groups.push([]);height=0;}
    groups.at(-1)!.push(system);height+=system.height;
  }
  return groups.map((group,index)=>{
    let y=d.top+40;
    const content=group.map(system=>{const at=y;y+=system.height;return `<g transform="translate(${d.left} ${at})">${system.svg.replace(/<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'')}</g>`;}).join('');
    return {widthMm:d.widthMm,heightMm:d.heightMm,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${d.widthMm}mm" height="${d.heightMm}mm" viewBox="0 0 ${d.width} ${d.height}"><style>.at{font-family:Bravura;font-size:34px}text{fill:#111}</style><text x="${d.left}" y="${d.top+22}" font-family="Noto Sans" font-size="18">${escaped(title)}</text>${content}<text x="${d.width/2}" y="${d.height-d.bottom}" text-anchor="middle" font-family="Noto Sans" font-size="11">${index+1} / ${groups.length}</text></svg>`};
  });
}
