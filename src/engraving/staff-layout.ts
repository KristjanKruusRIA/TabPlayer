import { accoladeSvg,systemAccoladeMarks,type AccoladeMark,type AccoladeMetrics,type AccoladePlan } from './accolades';
import type { ScreenBounds,ScreenRenderChunk,ScreenSystem } from './screen-pages';
import type { SvgSystem } from '../export/types';

/** One track's vertical extent in a system, in render pixels of the whole render. `staves` counts its visible staves. */
export interface TrackBand {track:number;top:number;bottom:number;staves:number}
/** Ascending cuts; `offsets[k]` is the cumulative shift for `cuts[k] <= y < cuts[k+1]` (and above `cuts[0]` nothing moves). */
export interface StaffShift {cuts:number[];offsets:number[]}
/** alphaTab's `trackStaffPaddingBetween`, in alphaTab units; the gap base never drops below it. */
export const TRACK_STAFF_PADDING=5;

type BarLike={realBounds:{y:number;h:number};bar:{staff:{index:number;track:{index:number};showStandardNotation?:boolean;showTablature?:boolean;showSlash?:boolean;showNumbered?:boolean}}};
const displayStaves=(staff:BarLike['bar']['staff'])=>Math.max(1,Number(!!staff.showStandardNotation)+Number(!!staff.showTablature)+Number(!!staff.showSlash)+Number(!!staff.showNumbered));

/** One band per track from every `BarBounds.realBounds` in the system, top to bottom. */
export function systemTrackBands(system:ScreenSystem):TrackBand[] {
  const tracks=new Map<number,{top:number;bottom:number;staves:Map<number,number>}>();
  for(const master of system.bars)for(const entry of master.bars as unknown as BarLike[]) {
    const index=entry.bar.staff.track.index,top=entry.realBounds.y,bottom=top+entry.realBounds.h,found=tracks.get(index);
    if(found) {found.top=Math.min(found.top,top);found.bottom=Math.max(found.bottom,bottom);found.staves.set(entry.bar.staff.index,displayStaves(entry.bar.staff));}
    else tracks.set(index,{top,bottom,staves:new Map([[entry.bar.staff.index,displayStaves(entry.bar.staff)]])});
  }
  return [...tracks].map(([track,band])=>({track,top:band.top,bottom:band.bottom,staves:[...band.staves.values()].reduce((sum,count)=>sum+count,0)})).sort((a,b)=>a.top-b.top);
}
export const staffLeftOf=(system:ScreenSystem):number=>system.bars[0].realBounds.x;

/**
 * Per boundary between an upper band `u` and the next band `l`: `measured = l.top - u.bottom`, `base = max(measured, padding)`,
 * `offset = max((scale - 1) * base, -measured)` (so a gap never shrinks below touching), cut at the midpoint of the gap.
 * `gaps` is keyed by the upper track's index; the last band, absent tracks and a scale of 1 add nothing.
 */
export function staffShift(bands:readonly TrackBand[],gaps:ReadonlyMap<number,number>,renderScale:number):StaffShift|null {
  const cuts:number[]=[],offsets:number[]=[];let total=0;
  for(let i=0;i+1<bands.length;i++) {
    const upper=bands[i],lower=bands[i+1],scale=gaps.get(upper.track);
    if(scale===undefined)continue;
    const measured=lower.top-upper.bottom,base=Math.max(measured,TRACK_STAFF_PADDING*renderScale),offset=Math.max((scale-1)*base,-measured);
    if(!offset)continue;
    total+=offset;cuts.push(upper.bottom+measured/2);offsets.push(total);
  }
  return cuts.length?{cuts,offsets}:null;
}

/** `'bottom'` treats `y` as an exclusive end, so a bottom exactly at a cut stays in the upper band. */
export function shiftY(shift:StaffShift|null|undefined,y:number,edge:'top'|'bottom'):number {
  if(!shift)return y;
  let offset=0;
  for(let k=0;k<shift.cuts.length;k++) {
    if(edge==='top'?shift.cuts[k]<=y:shift.cuts[k]<y)offset=shift.offsets[k];else break;
  }
  return y+offset;
}
/** The original y of a shifted point; null inside an opened gap. Where a negative offset overlaps two bands, the lower band wins. */
export function unshiftY(shift:StaffShift|null|undefined,y:number):number|null {
  if(!shift)return y;
  for(let band=shift.cuts.length;band>=0;band--) {
    const offset=band?shift.offsets[band-1]:0,start=band?shift.cuts[band-1]+offset:-Infinity,end=band<shift.cuts.length?shift.cuts[band]+offset:Infinity;
    if(y>=start&&y<end)return y-offset;
  }
  return null;
}
export const shiftTotal=(shift:StaffShift|null|undefined):number=>shift&&shift.offsets.length?shift.offsets[shift.offsets.length-1]:0;

export interface ComposeSvgInput {svg:string;id:string;left:number;top:number;width:number;height:number;shift:StaffShift|null;marks:readonly AccoladeMark[];marksShifted?:boolean}

/** Only the cuts between bands clip. The outer edges of the first and last band, and both sides, are unbounded in practice, so content that overhangs the system (as it does without a gap) is not cut off. */
const OUTER_CLIP=1e5;
const OPEN_SVG=/^\s*<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/;
const ATTRIBUTE=/(\s)([^\s=\/>"']+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;
const unquoted=(value:string)=>/^["']/.test(value)?value.slice(1,-1):value;
const quoted=(original:string,value:string)=>original.startsWith("'")?`'${value}'`:`"${value}"`;

/** Sets `height` and the viewBox height on the root tag, reading attributes quote-aware so values never match as attributes. */
function withRootHeight(open:string,height:number):string {
  let found=false;
  const tag=open.replace(ATTRIBUTE,(all,space:string,name:string,equals:string,value:string)=>{
    if(name==='height'){found=true;return `${space}${name}${equals}${quoted(value,`${height}${/[a-z%]+$/i.exec(unquoted(value))?.[0]??''}`)}`;}
    if(name==='viewBox') {
      const parts=unquoted(value).trim().split(/[\s,]+/);if(parts.length!==4)return all;
      parts[3]=String(height);return `${space}${name}${equals}${quoted(value,parts.join(' '))}`;
    }
    return all;
  });
  return found?tag:tag.replace(/>$/,` height="${height}">`);
}

/**
 * The one place a system's SVG is rewritten. With a shift the content is defined once and shown through one clipped, translated
 * `<use>` per band; marks (given in unshifted render pixels) are drawn after the shift. With only marks they are inserted before the
 * final `</svg>`; with neither the string is returned unchanged. `marksShifted` says the marks are already in shifted pixels.
 */
export function composeSystemSvg(input:ComposeSvgInput):{svg:string;height:number} {
  const {svg,id,left,top,height,shift,marks}=input;
  if(!shift&&!marks.length)return {svg,height};
  const moved=input.marksShifted?marks:marks.map(mark=>({...mark,top:shiftY(shift,mark.top,'top'),bottom:shiftY(shift,mark.bottom,'bottom')}));
  const drawn=accoladeSvg(moved,{left,top}),close=svg.lastIndexOf('</svg>');
  if(close<0)throw new Error('Cannot compose a system without a closing svg tag.');
  if(!shift)return {svg:`${svg.slice(0,close)}${drawn}${svg.slice(close)}`,height};
  const open=OPEN_SVG.exec(svg);
  if(!open||open[0].endsWith('/>'))throw new Error('Cannot compose a system without an svg root.');
  const total=shiftTotal(shift),newHeight=height+total,edges=[-OUTER_CLIP,...shift.cuts.map(cut=>cut-top),height+OUTER_CLIP];
  const clips=edges.slice(0,-1).map((start,k)=>`<clipPath id="${id}-c${k}"><rect x="${-OUTER_CLIP}" y="${start}" width="${2*OUTER_CLIP}" height="${edges[k+1]-start}"/></clipPath>`).join('');
  const uses=edges.slice(0,-1).map((_start,k)=>`<g transform="translate(0 ${k?shift.offsets[k-1]:0})"><use href="#${id}-content" clip-path="url(#${id}-c${k})"/></g>`).join('');
  return {svg:`${withRootHeight(open[0],newHeight)}<defs><g id="${id}-content">${svg.slice(open[0].length,close)}</g>${clips}</defs>${uses}${drawn}</svg>`,height:newHeight};
}

export interface ComposeInput {svg:string;id:string;left:number;top:number;width:number;height:number;system:ScreenSystem;plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics}
/**
 * Bands, then the shift, then the marks, then the composition: the only path both screen and export take. Marks are built from the
 * bands after the shift, so a brace or bracket over several tracks is sized to the moved staves, not to the original span.
 */
export function composeSystem(input:ComposeInput):{svg:string;height:number;shift:StaffShift|null} {
  const {system,plan,gaps,metrics,...rest}=input,bands=systemTrackBands(system),shift=staffShift(bands,gaps,metrics.scale);
  const moved=bands.map(band=>({...band,top:shiftY(shift,band.top,'top'),bottom:shiftY(shift,band.bottom,'bottom')}));
  const marks=plan?systemAccoladeMarks(plan,moved,metrics,staffLeftOf(system)):[];
  return {...composeSystemSvg({...rest,shift,marks,marksShifted:true}),shift};
}

/**
 * Composes every system chunk of an export through `composeSystem` (the one core the screen uses too), matching each to its staff bounds by
 * first bar (a multi-bar rest closing a system makes the chunk's last bar later than the last bar its bounds record) and giving it the id `<idPrefix>-s<firstBar>`. Chunks without a first bar (title, tunings) are untouched; the input array is
 * returned when nothing composes. Run the width and text-fit checks on the raw chunks first: text moved under `<defs>` has no box.
 */
export function composeEngravedSystems(systems:SvgSystem[],bounds:ScreenBounds,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics;idPrefix:string}):SvgSystem[] {
  const {plan,gaps,metrics,idPrefix}=input;
  if(!plan&&!gaps.size)return systems;
  let changed=false;
  const composed=systems.map(system=>{
    const first=system.firstBar;
    if(first===undefined)return system;
    const found=bounds.staffSystems.filter(candidate=>candidate.bars[0].index===first&&(system.lastBar===undefined||candidate.bars.at(-1)!.index<=system.lastBar));
    if(found.length!==1)throw new Error('A rendered system has no matching staff bounds.');
    const out=composeSystem({svg:system.svg,id:`${idPrefix}-s${first}`,left:system.left??0,top:system.top??0,width:system.width,height:system.height,system:found[0],plan,gaps,metrics});
    if(out.svg===system.svg)return system;
    changed=true;
    return {...system,svg:out.svg,height:out.height};
  });
  return changed?composed:systems;
}

/**
 * Composes every system chunk of the paginated screen through `composeSystem` (the one core export uses too) with the id `tp-<chunk.id>`,
 * the chunk's own origin as `left` and `top`, and its `shift` attached. `height` stays render-space: the composed box is `height + shiftTotal(shift)` tall.
 * A chunk is matched to its bounds by first bar, as `paginateScreenScore` does, so a multi-bar rest closing a system composes. Chunks without a system
 * (title, tunings) and chunks no bounds match are left as they are, and pagination reports the latter. The input array is returned when nothing composes.
 */
export function composeScreenChunks(chunks:readonly ScreenRenderChunk[],bounds:ScreenBounds,input:{plan:AccoladePlan|null;gaps:ReadonlyMap<number,number>;metrics:AccoladeMetrics}):ScreenRenderChunk[] {
  const {plan,gaps,metrics}=input;
  if(!plan&&!gaps.size)return chunks as ScreenRenderChunk[];
  let changed=false;
  const composed=chunks.map(chunk=>{
    const first=chunk.firstMasterBarIndex;
    if(first<0)return chunk;
    const found=bounds.staffSystems.filter(candidate=>candidate.bars[0].index===first&&candidate.bars.at(-1)!.index<=chunk.lastMasterBarIndex);
    if(found.length!==1)return chunk;
    const out=composeSystem({svg:chunk.svg,id:`tp-${chunk.id}`,left:chunk.x,top:chunk.y,width:chunk.width,height:chunk.height,system:found[0],plan,gaps,metrics});
    if(out.svg===chunk.svg)return chunk;
    changed=true;
    return {...chunk,svg:out.svg,...(out.shift?{shift:out.shift}:{})};
  });
  return changed?composed:chunks as ScreenRenderChunk[];
}
