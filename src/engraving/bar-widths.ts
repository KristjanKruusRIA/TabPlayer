import { mapSystemGaps } from './system-gaps';
import type { BarWidth,EngravingOverrides } from './types';

/** The weights Rust enforces too. alphaTab shares a system's width between its bars in proportion to these weights (an unset bar counts 1). */
export const BAR_SCALE_RANGE={min:.25,max:4} as const;
export const MAX_BAR_INDEX=99_999,MAX_BAR_WIDTHS=10_000;
/** One key press nudges a bar by this weight; a larger press by the second. */
export const BAR_SCALE_STEP=.1,BAR_SCALE_BIG_STEP=.5;

const round=(scale:number)=>Math.round(scale*100)/100;
/** `scale` held inside the supported range and to two decimals, so a drag never stores noise. */
export const clampBarScale=(scale:number)=>round(Math.min(BAR_SCALE_RANGE.max,Math.max(BAR_SCALE_RANGE.min,scale)));

export function validateBarWidths(value:unknown):asserts value is BarWidth[] {
  if(!Array.isArray(value)||value.length>MAX_BAR_WIDTHS)throw new Error('Invalid bar widths.');
  let previous=-1;
  for(const entry of value) {
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==2||!Object.hasOwn(entry,'bar')||!Object.hasOwn(entry,'scale'))throw new Error('Invalid bar width fields.');
    const {bar,scale}=entry as Record<string,unknown>;
    if(typeof bar!=='number'||!Number.isInteger(bar)||bar<0||bar>MAX_BAR_INDEX)throw new Error('Bar widths must name a bar from 1 to 100000.');
    if(bar<=previous)throw new Error('Bar widths must list each bar once, in bar order.');
    previous=bar;
    if(typeof scale!=='number'||!Number.isFinite(scale)||scale<BAR_SCALE_RANGE.min||scale>BAR_SCALE_RANGE.max)throw new Error('Bar widths must be between 25% and 400% of the default.');
  }
}

/** `engraving` carrying `widths`, leaving the field out while no bar is set so documents saved before bar widths stay identical. */
export function withBarWidths(engraving:EngravingOverrides,widths:readonly BarWidth[]):EngravingOverrides {
  const {barWidths:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return widths.length?{...rest,barWidths:widths.map(entry=>({...entry}))}:rest;
}
/** The weight set here for bar `bar` (0-based), or `base` when none is: `base` is the weight the score itself gives the bar (1, unless an imported file set one). */
export const barScaleOf=(engraving:Pick<EngravingOverrides,'barWidths'>,bar:number,base=1)=>engraving.barWidths?.find(entry=>entry.bar===bar)?.scale??base;
/** A weight a score gives a bar, as the controls show it: unusable values read as the default 1 and the rest are held to the supported range. */
export const sourceBarScale=(weight:unknown)=>typeof weight==='number'&&Number.isFinite(weight)&&weight>0?clampBarScale(weight):1;
export const hasBarWidths=(engraving:Pick<EngravingOverrides,'barWidths'>)=>!!engraving.barWidths?.length;
/** `engraving` with bar `bar` at weight `scale`; the score's own weight `base` for that bar (1 unless imported) clears the entry. Returns the same object when nothing would change. */
export function withBarScale(engraving:EngravingOverrides,bar:number,scale:number,base=1):EngravingOverrides {
  const next=clampBarScale(scale);
  if(!Number.isInteger(bar)||bar<0||bar>MAX_BAR_INDEX)throw new Error('Bar widths must name a bar from 1 to 100000.');
  if(next===barScaleOf(engraving,bar,base))return engraving;
  const others=(engraving.barWidths??[]).filter(entry=>entry.bar!==bar);
  return withBarWidths(engraving,next===base?others:[...others,{bar,scale:next}].sort((a,b)=>a.bar-b.bar));
}
/** `engraving` after measures moved: `oldToNew[old]` is a bar's new index, or null when it was removed. A removed bar's width goes with it; inserted bars keep the score's own weight. */
export function mapBarWidths(engraving:EngravingOverrides,oldToNew:ReadonlyArray<number|null>):EngravingOverrides {
  if(!engraving.barWidths?.length)return engraving;
  const moved=engraving.barWidths.flatMap(({bar,scale})=>{const to=oldToNew[bar];return to===null||to===undefined?[]:[{bar:to,scale}];}).sort((a,b)=>a.bar-b.bar);
  return moved.length===engraving.barWidths.length&&moved.every((entry,index)=>entry.bar===engraving.barWidths![index].bar&&entry.scale===engraving.barWidths![index].scale)?engraving:withBarWidths(engraving,moved);
}
/** `engraving` after measures moved, with both the bar widths and the system gaps remapped through `oldToNew`. Returns the same object when nothing changes. */
export function mapEngravingBars(engraving:EngravingOverrides,oldToNew:ReadonlyArray<number|null>):EngravingOverrides {
  return mapSystemGaps(mapBarWidths(engraving,oldToNew),oldToNew);
}
/** The weight a bar of `width` px and weight `scale` takes when its right edge is dragged by `delta` px. Fixed clef and signature widths are not
 * known here, so the result is an estimate that the next layout corrects. */
export const scaleAfterDrag=(scale:number,width:number,delta:number)=>width>0&&Number.isFinite(delta)?clampBarScale(scale*Math.max(.01,(width+delta)/width)):scale;

/** The weight the score itself gives bar ar in the view shown tracks make, from the same place alphaTab reads it: the master bar when several staves are shown, the bar of the one staff otherwise. */
export function sourceWeight(score:{masterBars:ReadonlyArray<{displayScale:number}>;tracks:ReadonlyArray<{staves:ReadonlyArray<{bars:ReadonlyArray<{displayScale:number}>}>}>},shown:readonly number[],bar:number):number {
  const staves=shown.flatMap(index=>score.tracks[index]?.staves??[]);
  return sourceBarScale(staves.length>1||!staves.length?score.masterBars[bar]?.displayScale:staves[0].bars[bar]?.displayScale);
}
