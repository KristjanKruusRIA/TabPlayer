import { useEffect, useState } from 'react';

export function IndexInput({label,value,min,max,disabled,onValue}: {
  label:string;value:number;min:number;max:number;disabled?:boolean;onValue:(value:number)=>void;
}) {
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  return <label>{label}<input type="number" min={min} max={max} step={1} disabled={disabled} value={draft} onChange={event=>{
    const text=event.target.value;setDraft(text);
    const next=Number(text);
    if (text.trim()!=='' && Number.isInteger(next) && next>=min && next<=max) onValue(next);
  }}/></label>;
}
