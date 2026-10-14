import { useEffect, useState } from 'react';
import { formatTuning } from './tuning';
import { findTuningPreset, tuningPresets } from './tuning-presets';

const groups=[...new Set(tuningPresets.map(p=>`${p.instrument}/${p.strings}`))];
export function TuningInput({label,presetLabel,value,onChange,disabled=false,placeholder,revision}: {
  label:string;presetLabel:string;value:string;onChange:(notes:string)=>void;disabled?:boolean;placeholder?:string;revision?:object;
}) {
  const [custom,setCustom]=useState(false);useEffect(()=>setCustom(false),[value,revision]);
  const selected=custom?'custom':findTuningPreset(value)?.id??'custom';
  return <><label>{presetLabel}<select disabled={disabled} value={selected} onChange={e=>{
    if(e.target.value==='custom'){setCustom(true);return;}
    const preset=tuningPresets.find(p=>p.id===e.target.value);if(preset){setCustom(false);onChange(formatTuning(preset.tuning));}
  }}><option value="custom">Custom</option>{groups.map(group=>{
    const presets=tuningPresets.filter(p=>`${p.instrument}/${p.strings}`===group),first=presets[0];
    return <optgroup key={group} label={`${first.instrument==='guitar'?'Guitar':'Bass'} · ${first.strings} strings`}>{presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>;
  })}</select></label><label>{label}<input disabled={disabled} placeholder={placeholder} value={value} onChange={e=>{setCustom(false);onChange(e.target.value);}}/></label></>;
}
