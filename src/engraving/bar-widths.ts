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
    // The default width is the absence of an entry, so one width has one saved form.
    if(scale===1)throw new Error('A default bar width is not stored.');
  }
}

/** `engraving` carrying `widths`, leaving the field out while no bar is set so documents saved before bar widths stay identical. */
export function withBarWidths(engraving:EngravingOverrides,widths:readonly BarWidth[]):EngravingOverrides {
  const {barWidths:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return widths.length?{...rest,barWidths:widths.map(entry=>({...entry}))}:rest;
}
/** The weight of bar `bar` (0-based): 1 when it keeps its default width. */
export const barScaleOf=(engraving:Pick<EngravingOverrides,'barWidths'>,bar:number)=>engraving.barWidths?.find(entry=>entry.bar===bar)?.scale??1;
export const hasBarWidths=(engraving:Pick<EngravingOverrides,'barWidths'>)=>!!engraving.barWidths?.length;
/** `engraving` with bar `bar` at weight `scale` (a weight of 1 restores the default), or the same object when nothing would change. */
export function withBarScale(engraving:EngravingOverrides,bar:number,scale:number):EngravingOverrides {
  const next=clampBarScale(scale);
  if(!Number.isInteger(bar)||bar<0||bar>MAX_BAR_INDEX)throw new Error('Bar widths must name a bar from 1 to 100000.');
  if(next===barScaleOf(engraving,bar))return engraving;
  const others=(engraving.barWidths??[]).filter(entry=>entry.bar!==bar);
  return withBarWidths(engraving,next===1?others:[...others,{bar,scale:next}].sort((a,b)=>a.bar-b.bar));
}
/** The weight a bar of `width` px and weight `scale` takes when its right edge is dragged by `delta` px. Fixed clef and signature widths are not
 * known here, so the result is an estimate that the next layout corrects. */
export const scaleAfterDrag=(scale:number,width:number,delta:number)=>width>0&&Number.isFinite(delta)?clampBarScale(scale*Math.max(.01,(width+delta)/width)):scale;
