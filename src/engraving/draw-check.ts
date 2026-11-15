import { rendering,type AlphaTabApi } from '@coderline/alphatab';
import type { LayoutPartial } from './lazy-paint';

/**
 * What is drawn equals what a complete render of the same score would draw (THE-213, draw speed).
 *
 * The live score area lays out the whole score but paints only the systems in view. This check paints every system of the live view, renders the
 * same score again in a renderer of its own (same settings, no lazy loading, nothing carried over from earlier renders) and compares piece by piece:
 * the geometry of each piece, its SVG, and the bounds alphaTab hands out for hit-testing and the playback cursor. It is meant for the desktop test
 * driver and for tests; it is reachable from outside only in development, in tests and in the desktop test build (`globalThis.__tabplayerCheckDraw`).
 */
/** `signature` is a short hash of everything drawn, so a driver can see that an edit changed the drawing; `breaks` lists the first bar of every system (where the lines break); `bars` is the length of the rendered score. */
export interface DrawCheck {equal:boolean;pieces:number;differences:string[];signature:string;breaks:string;bars:number}
interface Piece {x:number;y:number;width:number;height:number;first:number;last:number;svg:string}

/** An SVG string as the DOM serializes it, so that a piece read back from the page equals the string alphaTab produced. */
function normalize(svg:string):string {const holder=document.createElement('template');holder.innerHTML=svg;return holder.innerHTML;}
type Box={x:number;y:number;w:number;h:number}|undefined;
const box=(bounds:Box)=>bounds?`${bounds.x.toFixed(2)},${bounds.y.toFixed(2)},${bounds.w.toFixed(2)},${bounds.h.toFixed(2)}`:'-';
/** Every bounds box alphaTab keeps for the systems, bars and beats, as lines of text in layout order. */
export function describeBounds(lookup:rendering.BoundsLookup|null|undefined):string[] {
  const lines:string[]=[];
  for(const [systemIndex,system] of (lookup?.staffSystems??[]).entries()) {
    lines.push(`system ${systemIndex} real ${box(system.realBounds)} visual ${box(system.visualBounds)}`);
    for(const master of system.bars) {
      lines.push(`  master ${master.index} real ${box(master.realBounds)} visual ${box(master.visualBounds)}`);
      for(const bar of master.bars) {
        lines.push(`    bar ${bar.bar?.index??'-'}/${bar.bar?.staff.index??'-'}/${bar.bar?.staff.track.index??'-'} real ${box(bar.realBounds)}`);
        for(const beat of bar.beats)lines.push(`      beat ${beat.beat?.index??'-'}/${beat.beat?.voice.index??'-'} real ${box(beat.realBounds)} visual ${box(beat.visualBounds)} notes ${(beat.notes??[]).map(note=>`${note.note?.string}:${box(note.noteHeadBounds)}`).join(' ')}`);
      }
    }
  }
  return lines;
}

/** The whole score as a complete render makes it: a renderer of its own, every piece painted at once. */
function renderComplete(view:AlphaTabApi):{pieces:Piece[];bounds:string[]} {
  const score=view.score,tracks=view.tracks;if(!score)return {pieces:[],bounds:[]};
  const saved=view.settings.core.enableLazyLoading;view.settings.core.enableLazyLoading=false;
  const renderer=new rendering.ScoreRenderer(view.settings),pieces:Piece[]=[];
  try {
    renderer.width=view.renderer.width;
    renderer.partialRenderFinished.on(event=>{if(typeof event.renderResult==='string')pieces.push({x:event.x,y:event.y,width:event.width,height:event.height,first:event.firstMasterBarIndex,last:event.lastMasterBarIndex,svg:normalize(event.renderResult)});});
    renderer.renderScore(score,tracks.map(track=>track.index));
    return {pieces,bounds:describeBounds(renderer.boundsLookup)};
  } finally {view.settings.core.enableLazyLoading=saved;renderer.destroy();}
}

/** The live view painted completely: its pieces are painted here, read back at once (before alphaTab's own visibility handling takes the ones out of view away again), and read in the order they were laid out. */
function readLive(view:AlphaTabApi,partials:readonly LayoutPartial[]):Piece[]|null {
  const element=(view.canvasElement as unknown as {element?:HTMLElement}).element;if(!element||element.children.length!==partials.length)return null;
  for(const piece of partials)view.renderer.renderResult(piece.id);
  return partials.map((piece,index)=>({x:piece.x,y:piece.y,width:piece.width,height:piece.height,first:piece.firstMasterBarIndex??-1,last:piece.lastMasterBarIndex??-1,svg:normalize(element.children[index].innerHTML)}));
}

export function checkDraw(view:AlphaTabApi,partials:readonly LayoutPartial[]):DrawCheck {
  const differences:string[]=[],full=renderComplete(view),live=readLive(view,partials);
  if(!live)return {equal:false,pieces:0,signature:'',breaks:'',bars:view.score?.masterBars.length??0,differences:['the live view has no pieces to compare (nothing is laid out, or its pieces are not the ones laid out last)']};
  if(live.length!==full.pieces.length)differences.push(`${live.length} pieces drawn, ${full.pieces.length} in a complete render`);
  for(let index=0;index<Math.min(live.length,full.pieces.length);index++) {
    const a=live[index],b=full.pieces[index];
    for(const key of ['x','y','width','height','first','last'] as const)if(Math.abs(a[key]-b[key])>1e-6)differences.push(`piece ${index} ${key}: ${a[key]} drawn, ${b[key]} in a complete render`);
    if(a.svg!==b.svg){
      let at=0;while(at<a.svg.length&&a.svg[at]===b.svg[at])at++;
      differences.push(`piece ${index} (bars ${b.first}-${b.last}) differs from its complete render at character ${at}: «${a.svg.slice(Math.max(0,at-40),at+60)}» against «${b.svg.slice(Math.max(0,at-40),at+60)}»`);
    }
  }
  const bounds=describeBounds(view.boundsLookup);
  if(bounds.length!==full.bounds.length)differences.push(`${bounds.length} bounds lines, ${full.bounds.length} in a complete render`);
  for(let index=0;index<Math.min(bounds.length,full.bounds.length);index++)if(bounds[index]!==full.bounds[index]){differences.push(`bounds line ${index}: «${bounds[index]}» against «${full.bounds[index]}»`);break;}
  let hash=2166136261;for(const piece of live)for(const number of [piece.first,piece.last])hash=Math.imul(hash^number,16777619);
  for(const piece of live)for(let at=0;at<piece.svg.length;at++){hash^=piece.svg.charCodeAt(at);hash=Math.imul(hash,16777619);}
  return {equal:differences.length===0,pieces:live.length,signature:(hash>>>0).toString(16),breaks:live.map(piece=>piece.first).join(','),bars:view.score?.masterBars.length??0,differences:differences.slice(0,10)};
}

const developerHooks=(()=>{const env=(import.meta as {env?:{DEV?:boolean;MODE?:string;VITE_DESKTOP_TEST?:string}}).env;return !!(env?.DEV||env?.MODE==='test'||env?.VITE_DESKTOP_TEST==='1');})();
/** Makes the live score area checkable from outside (development, tests and the desktop test build only). Returns what to call when the area goes away. */
export function exposeDrawCheck(live:()=>{view:AlphaTabApi|null;partials:readonly LayoutPartial[]}):()=>void {
  if(!developerHooks)return ()=>{};
  const hook=()=>{const {view,partials}=live();return view?checkDraw(view,partials):{equal:false,pieces:0,signature:'',breaks:'',bars:0,differences:['no score view']};};
  const host=globalThis as {__tabplayerCheckDraw?:typeof hook};host.__tabplayerCheckDraw=hook;
  return ()=>{if(host.__tabplayerCheckDraw===hook)delete host.__tabplayerCheckDraw;};
}
