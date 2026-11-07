import type { EngravingOverrides,SystemGap } from './types';

/** The factors Rust enforces too. A system's gap is this factor of the standard gap (1 is the default). */
export const SYSTEM_GAP_RANGE={min:.25,max:4} as const;
export const MAX_SYSTEM_BAR_INDEX=99_999,MAX_SYSTEM_GAPS=10_000;
/** A rendered system as its inclusive master-bar interval. */
export interface SystemSpan {first:number;last:number}

export function validateSystemGaps(value:unknown):asserts value is SystemGap[] {
  if(!Array.isArray(value)||value.length>MAX_SYSTEM_GAPS)throw new Error('Invalid system gaps.');
  let previous=-1;
  for(const entry of value) {
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==2||!Object.hasOwn(entry,'bar')||!Object.hasOwn(entry,'scale'))throw new Error('Invalid system gap fields.');
    const {bar,scale}=entry as Record<string,unknown>;
    if(typeof bar!=='number'||!Number.isInteger(bar)||bar<0||bar>MAX_SYSTEM_BAR_INDEX)throw new Error('System gaps must name a bar from 1 to 100000.');
    if(bar<=previous)throw new Error('System gaps must list each bar once, in bar order.');
    previous=bar;
    if(typeof scale!=='number'||!Number.isFinite(scale)||scale<SYSTEM_GAP_RANGE.min||scale>SYSTEM_GAP_RANGE.max)throw new Error('System gaps must be between 25% and 400% of the standard gap.');
  }
}

/** `engraving` carrying `gaps`, leaving the field out while none is set so documents saved before system gaps stay identical. */
export function withSystemGaps(engraving:EngravingOverrides,gaps:readonly SystemGap[]):EngravingOverrides {
  const {systemGaps:_dropped,...rest}=structuredClone(engraving);void _dropped;
  return gaps.length?{...rest,systemGaps:gaps.map(entry=>({...entry}))}:rest;
}

/** The gap of each rendered system, keyed by its first bar. An entry applies to the system containing its bar; the lowest bar wins; entries outside every system are ignored. */
export function resolveSystemGaps(gaps:readonly SystemGap[]|undefined,systems:readonly SystemSpan[]):Map<number,number> {
  const resolved=new Map<number,number>();
  if(!gaps?.length)return resolved;
  const ordered=[...gaps].sort((a,b)=>a.bar-b.bar);
  for(const system of systems)for(const entry of ordered)if(entry.bar>=system.first&&entry.bar<=system.last){resolved.set(system.first,entry.scale);break;}
  return resolved;
}

const inside=(system:SystemSpan)=>(entry:SystemGap)=>entry.bar>=system.first&&entry.bar<=system.last;
const same=(a:readonly SystemGap[],b:readonly SystemGap[])=>a.length===b.length&&a.every((entry,index)=>entry.bar===b[index].bar&&entry.scale===b[index].scale);
const finish=(engraving:EngravingOverrides,next:SystemGap[])=>same(engraving.systemGaps??[],next)?engraving:withSystemGaps(engraving,next);

/** `engraving` with `system`'s gap at `scale`. Scale 1 (within 1e-9) clears the system's entries; otherwise one entry at the system's first bar replaces them. Returns the same object when nothing changes. */
export function setSystemGap(engraving:EngravingOverrides,system:SystemSpan,scale:number):EngravingOverrides {
  if(!Number.isFinite(scale)||scale<SYSTEM_GAP_RANGE.min||scale>SYSTEM_GAP_RANGE.max)throw new Error('System gaps must be between 25% and 400% of the standard gap.');
  if(!Number.isInteger(system.first)||system.first<0||system.first>MAX_SYSTEM_BAR_INDEX||system.last<system.first)throw new Error('System gaps must name a bar from 1 to 100000.');
  if(Math.abs(scale-1)<=1e-9)return resetSystemGap(engraving,system);
  const current=engraving.systemGaps??[];
  const others=current.filter(entry=>!inside(system)(entry));
  return finish(engraving,[...others,{bar:system.first,scale}].sort((a,b)=>a.bar-b.bar));
}
/** `engraving` without any entry inside `system`. */
export function resetSystemGap(engraving:EngravingOverrides,system:SystemSpan):EngravingOverrides {
  const current=engraving.systemGaps??[];
  return finish(engraving,current.filter(entry=>!inside(system)(entry)));
}
export const resetAllSystemGaps=(engraving:EngravingOverrides):EngravingOverrides=>engraving.systemGaps?withSystemGaps(engraving,[]):engraving;
export const hasSystemGaps=(engraving:Pick<EngravingOverrides,'systemGaps'>)=>!!engraving.systemGaps?.length;

/** `engraving` after measures moved: `oldToNew[old]` is a bar's new index, or null when removed. A removed anchor's gap goes with it; colliding anchors keep the lowest old bar's scale. */
export function mapSystemGaps(engraving:EngravingOverrides,oldToNew:ReadonlyArray<number|null>):EngravingOverrides {
  if(!engraving.systemGaps?.length)return engraving;
  const seen=new Set<number>(),moved:SystemGap[]=[];
  for(const {bar,scale} of engraving.systemGaps){const to=oldToNew[bar];if(to===null||to===undefined||seen.has(to))continue;seen.add(to);moved.push({bar:to,scale});}
  moved.sort((a,b)=>a.bar-b.bar);
  return finish(engraving,moved);
}
