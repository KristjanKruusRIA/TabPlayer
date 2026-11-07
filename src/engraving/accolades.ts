import { model,type Settings } from '@coderline/alphatab';
import type { EngravingOverrides } from './types';
import { drawnGroups,type ResolvedGroup } from './staff-groups';

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

/** null becomes four zeros, one value four equal ones, `[h,v]` becomes `[h,v,h,v]`. */
export function normalizedPadding(padding:readonly number[]|null|undefined):[number,number,number,number] {
  if(!padding||!padding.length)return [0,0,0,0];
  if(padding.length===1)return [padding[0],padding[0],padding[0],padding[0]];
  if(padding.length===2)return [padding[0],padding[1],padding[0],padding[1]];
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
