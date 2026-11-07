import { model,type Settings } from '@coderline/alphatab';
import type { EngravingOverrides } from './types';
import { drawnGroups,type ResolvedGroup } from './staff-groups';
import type { TrackBand } from './staff-layout';

/** Brace glyphs stretch horizontally with their height, capped at this factor of the glyph width. */
export const BRACE_MAX_X_SCALE=4;
/** alphaTab's default `systemLabelPaddingRight`. */
export const LABEL_PADDING_RIGHT=3;

/** Accolade measurements in render pixels (alphaTab units multiplied by `display.scale`). */
export interface AccoladeMetrics {scale:number;pad:number;bracketThickness:number;staffSpace:number;brace:{width:number;height:number};spike:{top:number;bottom:number}}
export function accoladeMetrics(settings:Settings):AccoladeMetrics {
  const scale=settings.display.scale,unit=settings.display.resources.engravingSettings,glyph=(map:Map<model.MusicFontSymbol,number>,symbol:model.MusicFontSymbol)=>(map.get(symbol)??0)*scale;
  return {scale,pad:settings.display.accoladeBarPaddingRight*scale,bracketThickness:unit.bracketThickness*scale,staffSpace:unit.oneStaffSpace*scale,
    brace:{width:glyph(unit.glyphWidths,model.MusicFontSymbol.Brace),height:glyph(unit.glyphHeights,model.MusicFontSymbol.Brace)},
    spike:{top:glyph(unit.glyphHeights,model.MusicFontSymbol.BracketTop),bottom:glyph(unit.glyphHeights,model.MusicFontSymbol.BracketBottom)}};
}

/** What a render with drawn groups needs. `inner`, `outer` and `reserve` are in alphaTab units. */
export interface AccoladePlan {groups:ResolvedGroup[];nativeMode:number;singleStaffBrackets:boolean;braceTracks:ReadonlySet<number>;inner:number;outer:number;reserve:number}
export interface AccoladeInput {engraving:EngravingOverrides;trackIds:readonly string[];rendered:readonly number[];score:model.Score;nativeMode:number;settings:Settings}

const visibleStaves=(track:model.Track)=>track.staves.reduce((sum,staff)=>sum+Number(staff.showStandardNotation)+Number(staff.showTablature)+Number(staff.showSlash)+Number(staff.showNumbered),0);

/** Null when no group is drawn, so alphaTab keeps drawing its own brackets. */
export function planAccolades(input:AccoladeInput):AccoladePlan|null {
  const {engraving,trackIds,rendered,score,nativeMode,settings}=input,groups=drawnGroups(engraving.staffGroups,trackIds,rendered);
  if(!groups.length)return null;
  const unit=settings.display.resources.engravingSettings,braceWidth=(unit.glyphWidths.get(model.MusicFontSymbol.Brace)??0)*BRACE_MAX_X_SCALE,bar=unit.bracketThickness,pad=settings.display.accoladeBarPaddingRight;
  const singleStaffBrackets=score.stylesheet.showSingleStaffBrackets;
  const braceTracks=new Set(rendered.filter(index=>(score.tracks[index]?.staves.filter(staff=>staff.showStandardNotation).length??0)>1));
  const inBraceGroup=new Set(groups.filter(group=>group.kind==='brace').flatMap(group=>group.tracks)),inAnyGroup=new Set(groups.flatMap(group=>group.tracks));
  let inner=0;
  if(nativeMode!==0){
    if(rendered.some(index=>!inBraceGroup.has(index)&&braceTracks.has(index)))inner=braceWidth;
    else if(rendered.some(index=>!inAnyGroup.has(index)&&score.tracks[index]&&(singleStaffBrackets||visibleStaves(score.tracks[index])>1)))inner=bar;
  }
  const outer=groups.some(group=>group.kind==='brace')?braceWidth:bar;
  return {groups,nativeMode,singleStaffBrackets,braceTracks,inner,outer,reserve:pad+inner+pad+outer};
}

/** null becomes four zeros, one value four equal ones, `[h,v]` becomes `[h,v,h,v]`, three values fill the left from the right-hand side's CSS rule (index 3 = index 1). */
export function normalizedPadding(padding:readonly number[]|null|undefined):[number,number,number,number] {
  if(!padding||!padding.length)return [0,0,0,0];
  if(padding.length===1)return [padding[0],padding[0],padding[0],padding[0]];
  if(padding.length===2)return [padding[0],padding[1],padding[0],padding[1]];
  if(padding.length===3)return [padding[0],padding[1],padding[2],padding[1]];
  return [padding[0],padding[1],padding[2],padding[3]];
}

/**
 * Writes absolute values on every call, so repeated renders never accumulate. Call it after the caller has set
 * `display.scale` and `display.padding` for this pass; without a plan the padding is left as the caller set it.
 */
export function configureAccolades(settings:Settings,score:model.Score,plan:AccoladePlan|null,nativeMode:number):void {
  score.stylesheet.bracketExtendMode=plan?model.BracketExtendMode.NoBrackets:nativeMode;
  settings.display.systemLabelPaddingRight=LABEL_PADDING_RIGHT+(plan?plan.reserve:0);
  if(!plan)return;
  const padding=normalizedPadding(settings.display.padding);padding[0]+=plan.reserve*settings.display.scale;
  settings.display.padding=padding;
}

/**
 * One drawn accolade in render pixels. A bracket's `top` and `bottom` already include alphaTab's quarter-staff-space overflow
 * (the bar's extra 3 and the spikes are added when it is written); a brace's are the staff span. `width` is the drawn width.
 * `glyphScale` is the font-size multiplier of the glyph (render scale times the brace's vertical factor; 1 when absent) and
 * `xScale` a horizontal compression for a brace taller than `BRACE_MAX_X_SCALE` (1 when absent).
 */
export interface AccoladeMark {role:'group'|'track';kind:'bracket'|'brace';x:number;top:number;bottom:number;width:number;glyphScale?:number;xScale?:number}

const BRACKET_BAR_SHIFT=3;

function braceMark(role:AccoladeMark['role'],right:number,top:number,bottom:number,metrics:AccoladeMetrics):AccoladeMark {
  const factor=metrics.brace.height>0?(bottom-top)/metrics.brace.height:1,widthFactor=Math.min(factor,BRACE_MAX_X_SCALE);
  const width=metrics.brace.width*widthFactor;
  return {role,kind:'brace',x:right-width,top,bottom,width,glyphScale:metrics.scale*factor,...(factor>BRACE_MAX_X_SCALE?{xScale:BRACE_MAX_X_SCALE/factor}:{})};
}
function bracketMark(role:AccoladeMark['role'],right:number,top:number,bottom:number,metrics:AccoladeMetrics):AccoladeMark {
  const overflow=metrics.staffSpace/4;
  return {role,kind:'bracket',x:right-metrics.bracketThickness,top:top-overflow,bottom:bottom+overflow,width:metrics.bracketThickness,glyphScale:metrics.scale};
}

/**
 * The marks of one system, from its track bands (unshifted render pixels). The inner column's right edge is `staffLeft - pad` and the
 * outer column's right edge is the inner column's left edge minus `pad`; plan widths are alphaTab units, so they are scaled here.
 */
export function systemAccoladeMarks(plan:AccoladePlan,bands:readonly TrackBand[],metrics:AccoladeMetrics,staffLeft:number):AccoladeMark[] {
  const innerRight=staffLeft-metrics.pad,outerRight=innerRight-plan.inner*metrics.scale-metrics.pad;
  const groupKind=new Map<number,'bracket'|'brace'>();
  for(const group of plan.groups)for(const track of group.tracks)groupKind.set(track,group.kind);
  const canPaint=(staves:number)=>staves>=2||plan.singleStaffBrackets,marks:AccoladeMark[]=[];
  if(plan.nativeMode!==0) {
    for(const band of bands) {
      if(groupKind.get(band.track)==='brace'||!canPaint(band.staves))continue;
      if(plan.braceTracks.has(band.track))marks.push(braceMark('track',innerRight,band.top,band.bottom,metrics));
      else if(!groupKind.has(band.track))marks.push(bracketMark('track',innerRight,band.top,band.bottom,metrics));
    }
  }
  for(const group of plan.groups) {
    const members=new Set(group.tracks),present=bands.filter(band=>members.has(band.track));
    if(!present.length||!canPaint(present.reduce((sum,band)=>sum+band.staves,0)))continue;
    const top=Math.min(...present.map(band=>band.top)),bottom=Math.max(...present.map(band=>band.bottom));
    marks.push(group.kind==='brace'?braceMark('group',outerRight,top,bottom,metrics):bracketMark('group',outerRight,top,bottom,metrics));
  }
  return marks;
}

const glyph=(x:number,y:number,scale:number,symbol:model.MusicFontSymbol,xScale=1)=>
  `<g transform="translate(${x} ${y})${xScale===1?'':` scale(${xScale} 1)`}" class="at" ><text style="${scale===1?'':`font-size: ${scale*100}%; `}stroke:none">&#${symbol};</text></g>`;

/** Marks already shifted by the caller, written in alphaTab's glyph markup in the coordinates of the chunk at `origin`. */
export function accoladeSvg(marks:readonly AccoladeMark[],origin:{left:number;top:number}):string {
  return marks.map(mark=>{
    const x=mark.x-origin.left,top=mark.top-origin.top,bottom=mark.bottom-origin.top,scale=mark.glyphScale??1,name=`${mark.role}-${mark.kind}`;
    if(mark.kind==='brace')return `<g data-tp-accolade="${name}">${glyph(x,bottom,scale,model.MusicFontSymbol.Brace,mark.xScale??1)}</g>`;
    return `<g data-tp-accolade="${name}"><rect x="${x}" y="${top-BRACKET_BAR_SHIFT}" width="${mark.width}" height="${bottom-top+BRACKET_BAR_SHIFT*2}" fill="#000000" />\n${glyph(x,top,scale,model.MusicFontSymbol.BracketTop)}${glyph(x,bottom,scale,model.MusicFontSymbol.BracketBottom)}</g>`;
  }).join('');
}
