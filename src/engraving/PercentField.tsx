import { useEffect,useState } from 'react';
import { useI18n } from '../i18n';

const percent=(value:number|null)=>value===null?'':String(Math.round(value*10000)/100);
export interface PercentFieldProps {
  /** The field's name without the unit, e.g. "Text size"; the unit "(%)" is added. */
  label:string;value:number|null;range:{min:number;max:number};
  onCommit:(value:number|null)=>void;onInvalid:(message:string)=>void;
  /** While busy the field keeps focus and what was typed, but nothing is committed. */
  busy?:boolean;
}
/** A percentage field for a scale held as a factor (1 is 100%). Keeps what is being typed until blur or Enter, so a half-typed number never rewrites the setting. */
export function PercentField({label,value,range,onCommit,onInvalid,busy=false}:PercentFieldProps) {
  const {t}=useI18n(),[text,setText]=useState(percent(value));
  useEffect(()=>setText(percent(value)),[value]);
  const low=Math.round(range.min*100),high=Math.round(range.max*100);
  const commit=()=>{
    // A commit refused for busy puts back what the draft holds, so the field never shows a value the draft lacks.
    if(busy){setText(percent(value));return;}
    const trimmed=text.trim();
    if(trimmed===''){if(value!==null)onCommit(null);setText('');return;}
    const entered=Number(trimmed);
    if(!Number.isFinite(entered)||entered<low||entered>high){onInvalid(t('typography.size_range',{label,low,high}));setText(percent(value));return;}
    const next=Math.round(entered*100)/10000;
    if(next!==value)onCommit(next);else setText(percent(value));
  };
  return <label>{t('typography.percent_label',{label})}<input type="number" min={low} max={high} step="any" placeholder={t('typography.size_placeholder')} value={text} readOnly={busy} aria-disabled={busy?'true':undefined} onChange={e=>{if(!busy)setText(e.target.value);}} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();}}/></label>;
}
