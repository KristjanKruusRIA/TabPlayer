import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { PitchCurve } from '../edit-types';
import { EnumInput } from './controls';

export function CurveEditor({label,value,onChange,disabled=false,whammy=false}: {label:string;value:PitchCurve|null;onChange:(curve:PitchCurve|null)=>void;disabled?:boolean;whammy?:boolean}) {
  const [curve,setCurve]=useState<PitchCurve|null>(value);
  useEffect(()=>setCurve(value),[value]);
  const point=(index:number,key:'offset'|'value',value:number)=>setCurve(curve=>curve?{...curve,points:curve.points.map((p,i)=>i===index?{...p,[key]:value}:p)}:null);
  return <details className="curve-editor"><summary>{label} curve</summary><fieldset disabled={disabled}>
    <label className="check"><input type="checkbox" checked={curve!==null} onChange={e=>setCurve(e.target.checked?{type:1,style:0,points:[{offset:0,value:0},{offset:60,value:0}]}:null)}/>Enable {label}</label>
    {curve&&<><div className="pair"><EnumInput label={`${label} type`} value={curve.type} enumeration={whammy?model.WhammyType:model.BendType} onValue={type=>setCurve({...curve,type})}/><EnumInput label={`${label} style`} value={curve.style} enumeration={model.BendStyle} onValue={style=>setCurve({...curve,style})}/></div>
      <svg viewBox="0 0 180 76" role="img" aria-label={`${label} pitch curve preview`}><line x1="0" y1="38" x2="180" y2="38" stroke="currentColor" opacity=".3"/><polyline fill="none" stroke="currentColor" strokeWidth="2" points={curve.points.filter(p=>Number.isFinite(p.offset)&&Number.isFinite(p.value)).map(p=>`${p.offset*3},${38-p.value*4}`).join(' ')}/></svg>
      <p className="muted">Position 0–60; pitch in quarter tones{whammy?', including negative values':''}.</p>
      {curve.points.map((p,index)=><div className="curve-point" key={index}><label>Position<input aria-label={`${label} point ${index+1} position`} type="number" min={0} max={60} value={p.offset} disabled={index===0||index===curve.points.length-1} onChange={e=>point(index,'offset',Number(e.target.value))}/></label><label>Pitch<input aria-label={`${label} point ${index+1} value`} type="number" min={whammy?undefined:0} step={1} value={p.value} onChange={e=>point(index,'value',Number(e.target.value))}/></label><button aria-label={`Remove ${label} point ${index+1}`} disabled={index===0||index===curve.points.length-1} onClick={()=>setCurve({...curve,points:curve.points.filter((_,i)=>i!==index)})}>×</button></div>)}
      <button onClick={()=>{const last=curve.points.length-1,offset=(curve.points[last-1].offset+60)/2;setCurve({...curve,points:[...curve.points.slice(0,-1),{offset,value:curve.points[last-1].value},curve.points[last]]});}}>Add {label} point</button>
    </>}
    <button onClick={()=>onChange(curve)}>Apply {label} curve</button>
  </fieldset></details>;
}
