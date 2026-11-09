import type {AlphaTabApi,model} from '@coderline/alphatab';
import {pageGeometry} from './page';
import type {PageLayout} from './types';
import {systemGapOffsets,type GapStacking} from './system-gaps';
import type {ScoreLayoutMode,ScoreZoomMode} from './screen-view';
import {shiftY,unshiftY,type StaffShift} from './staff-layout';

export type ScreenRect={x:number;y:number;w:number;h:number};
export type ScreenPoint={x:number;y:number};
export type ScreenBounds=NonNullable<AlphaTabApi['boundsLookup']>;
export type ScreenSystem=ScreenBounds['staffSystems'][number];
/** `height` is the render-space height. `shift` (render coordinates) opens staff gaps in the composed SVG, whose height is `height + shiftTotal(shift)`. */
export type ScreenRenderChunk={id:string;x:number;y:number;width:number;height:number;firstMasterBarIndex:number;lastMasterBarIndex:number;svg:string;shift?:StaffShift};
/** `sourceBounds` x and w are render pixels. With `chunk.shift`, y and h are composed pixels (the opened gaps are included); the DOM box must be `chunk.height + shiftTotal(chunk.shift)` tall. */
export type ScreenPageBlock={chunk:ScreenRenderChunk;system:ScreenSystem|null;page:number;sourceBounds:ScreenRect;x:number;y:number};
export type ScreenPagination={paper:{width:number;height:number;left:number;top:number;right:number;bottom:number};pageCount:number;blocks:ScreenPageBlock[]};
export type ScreenPageArrangement={scale:number;width:number;height:number;pages:Array<{index:number;x:number;y:number;width:number;height:number}>};
export type ScreenPageHit={system:ScreenSystem;beat:model.Beat;note:model.Note|null};
export const SCREEN_PAGE_GAP=24;

const oversize='This score does not fit the selected paper. Display fewer staves, choose a larger page, or reduce print scale.';
function positive(value:number):boolean {return Number.isFinite(value)&&value>0;}
function validRect(rect:ScreenRect,nonempty=false):void {
  if(![rect.x,rect.y,rect.w,rect.h,rect.x+rect.w,rect.y+rect.h].every(Number.isFinite)||rect.w<0||rect.h<0||(nonempty&&(rect.w===0||rect.h===0)))throw new Error('Invalid screen bounds geometry.');
}
/** alphaTab reports a beat's real width as negative when beats are crowded closer than their natural width (forced systems of six or more bars). The rest of its geometry is still sound, so only the width may be negative. */
function validBeatRealRect(rect:ScreenRect,bar:ScreenRect):void {
  if(![rect.x,rect.y,rect.w,rect.h,rect.y+rect.h].every(Number.isFinite)||rect.h<0)throw new Error('Invalid screen bounds geometry.');
  // Negative, but only as far as the bar is wide, and the beat starts inside its bar (one pixel of slack for rounding).
  if(rect.w<-bar.w||rect.x<bar.x-1||rect.x>bar.x+bar.w+1)throw new Error('Invalid screen bounds geometry.');
}
type BeatBox={beat:model.Beat;realBounds:ScreenRect};
/**
 * The stretch of a bar a beat owns: from its own x to the x of the next beat of the same voice, or, for the last one, its own end (the bar's right edge only when that width is negative).
 * alphaTab's real width cannot be used for this when beats are crowded: it is negative for some beats and overshoots the next beat for others.
 */
export function beatSpan(bar:{realBounds:ScreenRect;beats:readonly BeatBox[]},bound:BeatBox):ScreenRect {
  const lane=bar.beats.filter(item=>item.beat.voice===bound.beat.voice),index=lane.indexOf(bound),next=index>=0?lane[index+1]:undefined;
  const box=bound.realBounds;
  // The last beat keeps alphaTab's own end (short of the barline) unless that width is negative.
  const right=next?next.realBounds.x:box.w>=0?box.x+box.w:bar.realBounds.x+bar.realBounds.w;
  return {x:box.x,y:box.y,w:Math.max(0,right-box.x),h:box.h};
}
/** `beatSpan` for a beat found through the bounds lookup; a beat without a bar keeps its own box with the width kept non-negative. */
export function beatSpanOf(bound:{beat:model.Beat;realBounds:ScreenRect;barBounds?:{realBounds:ScreenRect;beats:readonly BeatBox[]}|null}):ScreenRect {
  return bound.barBounds?beatSpan(bound.barBounds,bound):{...bound.realBounds,w:Math.max(0,bound.realBounds.w)};
}
function contains(rect:ScreenRect,point:ScreenPoint):boolean {
  return point.x>=rect.x&&point.x<rect.x+rect.w&&point.y>=rect.y&&point.y<rect.y+rect.h;
}
function overlaps(a:ScreenRect,b:ScreenRect):boolean {
  return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
}

export function paginateScreenScore(chunks:readonly ScreenRenderChunk[],bounds:ScreenBounds,page:PageLayout,gaps?:GapStacking):ScreenPagination {
  const {width,height,left,top,right,bottom}=pageGeometry(page);
  const paper={width,height,left,top,right,bottom},blocks:ScreenPageBlock[]=[],ids=new Set<string>(),positions=new Set<string>(),matched=new Set<ScreenSystem>();
  for(const system of bounds.staffSystems) {
    validRect(system.realBounds,true);validRect(system.visualBounds,true);
    if(!system.bars.length)throw new Error('A screen system has no bar interval.');
    if(system.bars.some((bar,i)=>!Number.isInteger(bar.index)||bar.index<0||(i>0&&bar.index<=system.bars[i-1].index)))throw new Error('Invalid screen system bar interval.');
    for(const master of system.bars)for(const bar of master.bars) {
      validRect(bar.realBounds);validRect(bar.visualBounds);
      for(const beat of bar.beats) {
        validBeatRealRect(beat.realBounds,bar.realBounds);validRect(beat.visualBounds);
        for(const note of beat.notes??[])validRect(note.noteHeadBounds);
      }
    }
  }
  const spans=gaps?chunks.filter(c=>Number.isInteger(c.firstMasterBarIndex)&&Number.isInteger(c.lastMasterBarIndex)&&c.firstMasterBarIndex>=0&&c.lastMasterBarIndex>=c.firstMasterBarIndex).map(c=>({first:c.firstMasterBarIndex,last:c.lastMasterBarIndex})).sort((a,b)=>a.first-b.first):[],offsets=systemGapOffsets(gaps,spans),scoreFirst=spans[0]?.first;
  let pageIndex=0,used=0,lastBar=-1;
  for(const chunk of [...chunks].sort((a,b)=>a.y-b.y||a.x-b.x)) {
    const rect={x:chunk.x,y:chunk.y,w:chunk.width,h:chunk.height};validRect(rect,true);
    if(typeof chunk.id!=='string'||!chunk.id||ids.has(chunk.id))throw new Error('Missing or duplicate screen chunk ID.');
    ids.add(chunk.id);
    const position=[rect.x,rect.y,rect.w,rect.h].join(',');
    if(positions.has(position))throw new Error('Duplicate screen render chunk geometry.');
    positions.add(position);
    if(typeof chunk.svg!=='string'||!/^\s*<svg\b[^>]*>[\s\S]*<\/svg>\s*$/.test(chunk.svg))throw new Error('A screen chunk is missing its SVG string.');
    const first=chunk.firstMasterBarIndex,last=chunk.lastMasterBarIndex;
    if(!Number.isInteger(first)||!Number.isInteger(last)||first< -1||last<first||(first===-1&&last!==-1))throw new Error('Invalid screen chunk bar interval.');
    // A multi-bar rest closing a system makes the chunk end at the rest's last bar while the bounds record the rest under its first bar.
    const candidates=first===-1?[]:bounds.staffSystems.filter(s=>s.bars[0].index===first&&s.bars.at(-1)!.index<=last);
    if(first!==-1&&(candidates.length!==1||matched.has(candidates[0])))throw new Error('Missing, duplicate or ambiguous screen system chunk association.');
    const system=candidates[0]??null;
    if(system&&(!overlaps(rect,system.realBounds)||!overlaps(rect,system.visualBounds)||first<=lastBar))throw new Error('Invalid screen system chunk geometry or musical order.');
    if(system){matched.add(system);lastBar=last;}
    const envelopes=system?[rect,system.realBounds,system.visualBounds]:[rect];
    // With a staff-gap shift the bounds live in composed pixels: the top and every bottom (the chunk's and the system's) go through the shift,
    // so the block is exactly as tall as the composed SVG even when the chunk rect extends below the system bounds.
    const x=Math.min(...envelopes.map(r=>r.x)),y=shiftY(chunk.shift,Math.min(...envelopes.map(r=>r.y)),'top');
    const sourceBounds={x,y,w:Math.max(...envelopes.map(r=>r.x+r.w))-x,h:Math.max(...envelopes.map(r=>shiftY(chunk.shift,r.y+r.h,'bottom')))-y};
    if(sourceBounds.w>width-left-right||sourceBounds.h>height-top-bottom)throw new Error(oversize);
    // A gap goes before a system only inside a page, never before the score's first system; a system pushed to a new page drops it.
    let offset=first===-1||first===scoreFirst||used===0?0:offsets.get(first)??0;
    if(used+offset+sourceBounds.h>height-top-bottom){pageIndex++;used=0;offset=0;}
    used+=offset;
    blocks.push({chunk,system,page:pageIndex,sourceBounds,x:left,y:top+used});used+=sourceBounds.h;
  }
  if(matched.size!==bounds.staffSystems.length)throw new Error('Missing or duplicate screen system chunks.');
  if(!blocks.length)throw new Error('No screen render chunks are available.');
  return {paper,pageCount:pageIndex+1,blocks};
}

export function arrangeScreenPages(pagination:ScreenPagination,mode:Extract<ScoreLayoutMode,'verticalPage'|'horizontalPage'|'grid'>,scale:number,availableWidth:number):ScreenPageArrangement {
  if(!positive(scale)||!Number.isFinite(availableWidth)||availableWidth<0||!positive(pagination.paper.width)||!positive(pagination.paper.height)||!Number.isInteger(pagination.pageCount)||pagination.pageCount<1)throw new Error('Invalid screen page arrangement geometry.');
  const width=pagination.paper.width*scale,height=pagination.paper.height*scale,gap=SCREEN_PAGE_GAP,count=pagination.pageCount;
  const columns=mode==='horizontalPage'?count:mode==='verticalPage'?1:Math.min(count,Math.max(1,Math.floor((availableWidth+gap)/(width+gap))));
  const groupWidth=columns*width+(columns-1)*gap,rows=Math.ceil(count/columns),offset=mode==='horizontalPage'?0:Math.max(0,(availableWidth-groupWidth)/2);
  const totalWidth=groupWidth+2*offset,totalHeight=rows*height+(rows-1)*gap;
  if(![width,height,totalWidth,totalHeight].every(positive))throw new Error('Invalid screen page arrangement geometry.');
  return {scale,width:totalWidth,height:totalHeight,pages:Array.from({length:count},(_,index)=>({index,x:offset+(index%columns)*(width+gap),y:Math.floor(index/columns)*(height+gap),width,height}))};
}

export function mapScreenRect(pagination:ScreenPagination,arrangement:ScreenPageArrangement,system:ScreenSystem,rect:ScreenRect):ScreenRect|null {
  validRect(rect);
  const block=pagination.blocks.find(b=>b.system===system);
  if(!block)return null;
  const sheet=arrangement.pages[block.page],scale=arrangement.scale,shift=block.chunk.shift;
  // The top and the exclusive bottom move separately, so a rect spanning a cut stretches over the opened gap.
  const top=shiftY(shift,rect.y,'top'),height=shift?Math.max(0,shiftY(shift,rect.y+rect.h,'bottom')-top):rect.h;
  return {x:sheet.x+(block.x+rect.x-block.sourceBounds.x)*scale,y:sheet.y+(block.y+top-block.sourceBounds.y)*scale,w:rect.w*scale,h:height*scale};
}

export function unmapScreenPoint(pagination:ScreenPagination,arrangement:ScreenPageArrangement,point:ScreenPoint):{system:ScreenSystem;point:ScreenPoint}|null {
  if(![point.x,point.y].every(Number.isFinite))throw new Error('Invalid screen point geometry.');
  for(const block of pagination.blocks) {
    if(!block.system)continue;
    const sheet=arrangement.pages[block.page],scale=arrangement.scale;
    const left=sheet.x+block.x*scale,top=sheet.y+block.y*scale;
    const right=sheet.x+(block.x+block.sourceBounds.w)*scale,bottom=sheet.y+(block.y+block.sourceBounds.h)*scale;
    if(point.x>=left&&point.x<right&&point.y>=top&&point.y<bottom) {
      const composed=(point.y-sheet.y)/scale-block.y+block.sourceBounds.y,y=unshiftY(block.chunk.shift,composed);
      // A point inside an opened staff gap belongs to no score position.
      if(y===null)return null;
      return {system:block.system,point:{x:(point.x-sheet.x)/scale-block.x+block.sourceBounds.x,y}};
    }
  }
  return null;
}

export function hitTestScreenPages(pagination:ScreenPagination,arrangement:ScreenPageArrangement,point:ScreenPoint,preferredLane?:{track:number;staff:number;voice:number}):ScreenPageHit|null {
  const hit=unmapScreenPoint(pagination,arrangement,point);if(!hit)return null;
  const {system,point:source}=hit,notes:ScreenPageHit[]=[],beats:ScreenPageHit[]=[];
  // Actual noteheads take precedence over the broad beat rectangles of another voice.
  for(const master of system.bars)for(const bar of master.bars)for(const beat of bar.beats) {
    for(const note of beat.notes??[])if(contains(note.noteHeadBounds,source))notes.push({system,beat:beat.beat,note:note.note});
    const span=beatSpan(bar,beat);
    if(contains(bar.realBounds,source)&&source.x>=span.x&&source.x<span.x+span.w)beats.push({system,beat:beat.beat,note:null});
  }
  const preferred=(hit:ScreenPageHit)=>{
    const voice=hit.beat.voice,staff=voice.bar.staff;
    return preferredLane&&staff.track.index===preferredLane.track&&staff.index===preferredLane.staff&&voice.index===preferredLane.voice?0:1;
  };
  return (notes.length?notes:beats).sort((a,b)=>preferred(a)-preferred(b)||a.beat.voice.index-b.beat.voice.index||(a.note?.index??0)-(b.note?.index??0)||a.beat.index-b.beat.index)[0]??null;
}

export function resolveScreenZoom(input:{zoomMode:ScoreZoomMode;manualPercent:number;available:{width:number;height:number};natural:{width:number;height?:number};minPercent?:number}):{percent:number;limited:boolean} {
  if(input.zoomMode==='manual') {
    if(!Number.isFinite(input.manualPercent)||input.manualPercent<25||input.manualPercent>300)throw new Error('Manual zoom must be between 25% and 300%.');
    return {percent:input.manualPercent,limited:false};
  }
  const {available,natural}=input;
  if(!positive(available.width)||!positive(natural.width))throw new Error('Fit requires positive measured widths.');
  let ratio=available.width/natural.width;
  if(input.zoomMode==='fitPage') {
    if(!positive(available.height)||natural.height===undefined||!positive(natural.height))throw new Error('Fit page requires positive measured heights.');
    ratio=Math.min(ratio,available.height/natural.height);
  }
  const minPercent=input.minPercent??25;
  const percent=ratio*100;
  return {percent:Math.max(minPercent,Math.min(300,percent)),limited:percent<minPercent||percent>300};
}
