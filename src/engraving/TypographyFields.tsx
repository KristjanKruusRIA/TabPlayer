import { useEffect,useState } from 'react';
import type { EngravingTypography,TextFamily } from './types';
import { MUSIC_FONT_NAME,TAB_SCALE_RANGE,TEXT_SCALE_RANGE,textFamilies } from './typography';

const percent=(value:number|null)=>value===null?'':String(Math.round(value*10000)/100);
interface PercentFieldProps {label:string;value:number|null;range:{min:number;max:number};onCommit:(value:number|null)=>void;onInvalid:(message:string)=>void}
/** Keeps what is being typed until blur or Enter, so a half-typed number never rewrites the setting. */
function PercentField({label,value,range,onCommit,onInvalid}:PercentFieldProps) {
  const [text,setText]=useState(percent(value));
  useEffect(()=>setText(percent(value)),[value]);
  const low=Math.round(range.min*100),high=Math.round(range.max*100);
  const commit=()=>{
    const trimmed=text.trim();
    if(trimmed===''){if(value!==null)onCommit(null);setText('');return;}
    const entered=Number(trimmed);
    if(!Number.isFinite(entered)||entered<low||entered>high){onInvalid(`${label} must be between ${low}% and ${high}%.`);setText(percent(value));return;}
    const next=Math.round(entered*100)/10000;
    if(next!==value)onCommit(next);else setText(percent(value));
  };
  return <label>{label} (%)<input type="number" min={low} max={high} step="any" placeholder="Source/default (100%)" value={text} onChange={e=>setText(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();}}/></label>;
}

export interface TypographyFieldsProps {value:EngravingTypography;onChange:(value:EngravingTypography)=>void;onInvalid:(message:string)=>void}
export function TypographyFields({value,onChange,onInvalid}:TypographyFieldsProps) {
  return <>
    <p>Music font: {MUSIC_FONT_NAME} (the bundled music font; every notation symbol is drawn from it). Text fonts fall back to a system face for any missing character.</p>
    <label>Text font<select value={value.family} onChange={e=>onChange({...value,family:e.target.value as TextFamily})}><option value="inherit">Source/default</option>{textFamilies.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    <PercentField label="Text size" value={value.textScale} range={TEXT_SCALE_RANGE} onCommit={textScale=>onChange({...value,textScale})} onInvalid={onInvalid}/>
    <PercentField label="Title size" value={value.titleScale} range={TEXT_SCALE_RANGE} onCommit={titleScale=>onChange({...value,titleScale})} onInvalid={onInvalid}/>
    <PercentField label="Tab number size" value={value.tabScale} range={TAB_SCALE_RANGE} onCommit={tabScale=>onChange({...value,tabScale})} onInvalid={onInvalid}/>
    <p>Blank keeps the renderer size. Tab number size also scales numbered-notation digits; fret and staff numbers keep the default font.</p>
    <p>Exports set text in the bundled Noto fonts and ignore Text font; Text size and Tab number size apply, and Title size scales the page header line, shrunk to fit the page width. An export is refused, naming the text, if enlarged text would run past the page width. On screen the renderer draws the score title as one centred line, so a very long title at a large Title size can run past the page edge.</p>
  </>;
}
