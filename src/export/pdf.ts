import { LayoutMode, model, rendering, Settings, SystemsLayoutMode } from '@coderline/alphatab';
import { validateSelection, type ExportSelection, type PrintLayout, type SvgPage, type SvgSystem } from './types';
import { selectStaves } from './selection';
import { prepareScoreTimers } from '../editor/timers';
const pxPerMm=96/25.4;
const escaped=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function dimensions(layout:PrintLayout) {
  if(!['A4','Letter'].includes(layout.paper)||!['portrait','landscape'].includes(layout.orientation)) throw new Error('Choose a supported paper size and orientation.');
  if(!Number.isFinite(layout.scale)||layout.scale<0.25||layout.scale>3) throw new Error('Print scale must be between 25% and 300%.');
  if(!Number.isFinite(layout.marginMm)||layout.marginMm<0) throw new Error('Print margins must be nonnegative.');
  let [widthMm,heightMm]=layout.paper==='A4'?[210,297]:[215.9,279.4];
  if(layout.orientation==='landscape')[widthMm,heightMm]=[heightMm,widthMm];
  const width=widthMm*pxPerMm,height=heightMm*pxPerMm,margin=layout.marginMm*pxPerMm;
  if(width-2*margin<100||height-2*margin-64<100)throw new Error('Reduce the page margins to leave usable notation width and height.');
  return {widthMm,heightMm,width,height,margin,usableWidth:width-2*margin,usableHeight:height-2*margin-64};
}
export function paginateSystems(systems:SvgSystem[],title:string,layout:PrintLayout):SvgPage[] {
  const d=dimensions(layout);const groups:SvgSystem[][]=[[]];let height=0;
  for(const system of systems) {
    if(!Number.isFinite(system.height)||system.height<=0||system.height>d.usableHeight||!Number.isFinite(system.width)||system.width>d.usableWidth+1)throw new Error('A notation system does not fit this page. Reduce print scale, use landscape, or export fewer staves.');
    if(height+system.height>d.usableHeight){groups.push([]);height=0;}
    groups.at(-1)!.push(system);height+=system.height;
  }
  return groups.map((group,index)=>{
    let y=d.margin+40;
    const content=group.map(system=>{const at=y;y+=system.height;return `<g transform="translate(${d.margin} ${at})">${system.svg.replace(/<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'')}</g>`;}).join('');
    return {widthMm:d.widthMm,heightMm:d.heightMm,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${d.widthMm}mm" height="${d.heightMm}mm" viewBox="0 0 ${d.width} ${d.height}"><style>.at{font-family:Bravura;font-size:34px}text{fill:#111}</style><text x="${d.margin}" y="${d.margin+22}" font-family="Noto Sans" font-size="18">${escaped(title)}</text>${content}<text x="${d.width/2}" y="${d.height-d.margin}" text-anchor="middle" font-family="Noto Sans" font-size="11">${index+1} / ${groups.length}</text></svg>`};
  });
}
/** Load the bundled fonts before public SVG text measurement in the webview. */
export async function loadExportFonts():Promise<void> {
  if(typeof document==='undefined')return;
  const fonts=[new FontFace('Noto Sans','url(/export-fonts/NotoSans-Regular.ttf)'),new FontFace('Bravura','url(/export-fonts/Bravura.otf)')];
  for(const font of fonts){await font.load();document.fonts.add(font);}
}
export function renderPdfPages(score:model.Score,selection:ExportSelection,layout:PrintLayout):SvgPage[] {
  validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));const d=dimensions(layout);
  // Export modifies only a transient clone; screen zoom and staff visibility stay session state.
  const copy=selectStaves(score,selection);
  prepareScoreTimers(copy);
  copy.title='';
  for(const track of copy.tracks)for(const staff of track.staves){staff.showStandardNotation=layout.profile!=='Tab';staff.showTablature=layout.profile!=='Score';}
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;
  settings.display.scale=layout.scale;settings.display.padding=[0];settings.display.layoutMode=LayoutMode.Page;
  settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;
  settings.display.startBar=(selection.range?.first??0)+1;settings.display.barCount=selection.range?selection.range.last-selection.range.first+1:-1;
  for(const font of settings.display.resources.elementFonts.values())font.families=['Noto Sans'];
  settings.display.resources.tablatureFont.families=['Noto Sans'];
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=d.usableWidth;
  const systems:SvgSystem[]=[];let failure:Error|undefined;
  renderer.error.on(e=>{failure=e;});
  renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string'&&e.height>0)systems.push({svg:e.renderResult,width:e.width,height:e.height});});
  try{renderer.renderScore(copy,selection.tracks);if(failure)throw failure;
    if(renderer.boundsLookup?.staffSystems.some(system=>system.bars.some(bar=>bar.visualBounds.x<-.5||bar.visualBounds.x+bar.visualBounds.w>d.usableWidth+1)))throw new Error('A notation system does not fit this page width. Reduce print scale, use landscape, or add a system break.');
    if(!systems.length)throw new Error('Notation renderer produced no printable systems.');return paginateSystems(systems,score.title,layout);}
  finally{renderer.destroy();}
}
