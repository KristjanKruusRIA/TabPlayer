import { useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import { formatTuning, parseTuning } from './tuning';
import { findTuningPreset, tuningPresets } from './tuning-presets';
import { SavedTuningsDialog } from './tuning/SavedTuningsDialog';
import { AuditionButtons } from './tuning/AuditionButtons';

const groups=[...new Set(tuningPresets.map(p=>`${p.instrument}/${p.strings}`))];
export function TuningInput({label,presetLabel,value,onChange,tuningName,onTuningNameChange,disabled=false,placeholder,revision,error,inputRef,onAudition}: {
  label:string;presetLabel:string;value:string;onChange:(notes:string)=>void;tuningName:string;onTuningNameChange:(name:string)=>void;disabled?:boolean;placeholder?:string;revision?:object;error?:string|null;inputRef?:Ref<HTMLInputElement>;onAudition?:(pitches:number[],strum:boolean)=>void;
}) {
  const [custom,setCustom]=useState(false),[library,setLibrary]=useState(false);useEffect(()=>setCustom(false),[value,revision]);useEffect(()=>{if(disabled)setLibrary(false);},[disabled]);useEffect(()=>setLibrary(false),[revision]);
  const errorId=useId(),errorElement=useRef<HTMLSpanElement>(null);
  useEffect(()=>{if(error)errorElement.current?.scrollIntoView?.({block:'nearest'});},[error]);
  const audible=useMemo(()=>{if(!onAudition)return null;try{return parseTuning(value);}catch{return null;}},[onAudition,value]);
  const selected=custom?'custom':findTuningPreset(value)?.id??'custom';
  return <><label>{presetLabel}<select disabled={disabled} value={selected} onChange={e=>{
    if(e.target.value==='custom'){setCustom(true);return;}
    const preset=tuningPresets.find(p=>p.id===e.target.value);if(preset){setCustom(false);onChange(formatTuning(preset.tuning));onTuningNameChange(preset.name);}
  }}><option value="custom">Custom</option>{groups.map(group=>{
    const presets=tuningPresets.filter(p=>`${p.instrument}/${p.strings}`===group),first=presets[0];
    return <optgroup key={group} label={`${first.instrument==='guitar'?'Guitar':'Bass'} · ${first.strings} strings`}>{presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>;
  })}</select></label><div className="tuning-field"><label>{label}<input ref={inputRef} disabled={disabled} placeholder={placeholder} value={value} aria-invalid={error?true:undefined} aria-describedby={error?errorId:undefined} onChange={e=>{setCustom(false);onChange(e.target.value);onTuningNameChange('');}}/></label>{error&&<span id={errorId} ref={errorElement} role="alert" className="tuning-error">{error}</span>}<button type="button" className="tuning-saved-button" disabled={disabled} aria-label={`Saved tunings for ${label}`} onClick={()=>setLibrary(true)}>Saved tunings…</button>{audible&&onAudition&&<AuditionButtons pitches={audible} disabled={disabled} label={label} onAudition={onAudition}/>}</div>{library&&<SavedTuningsDialog onAudition={onAudition} notes={value} name={tuningName} onClose={()=>setLibrary(false)} onUse={(notes,name)=>{setCustom(false);onChange(notes);onTuningNameChange(name);}}/>}</>;
}
