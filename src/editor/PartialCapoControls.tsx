import { useState } from 'react';
import type { model } from '@coderline/alphatab';
import { formatPitch } from '../tuning';
import { noPartialCapo, openStringKey, type PartialCapo } from './partial-capo';

/** Fret and strings of a capo over part of the neck. The fret is committed on blur or Enter, the strings at once; `onChange` gets a valid value, or `noPartialCapo` while the draft is not one. */
export function PartialCapoControls({staff,value,disabled,onChange}:{staff:model.Staff;value:PartialCapo;disabled?:boolean;onChange:(value:PartialCapo)=>void}) {
  const [fretText,setFretText]=useState(value.fret?String(value.fret):''),[strings,setStrings]=useState<number[]>(value.strings);
  const count=staff.tuning.length,fret=fretText.trim()===''?0:Number(fretText),valid=Number.isInteger(fret)&&fret>=0&&fret<=127;
  const commit=(nextFret:number,nextStrings:number[])=>onChange(Number.isInteger(nextFret)&&nextFret>=1&&nextFret<=127&&nextStrings.length?{fret:nextFret,strings:[...nextStrings].sort((a,b)=>a-b)}:noPartialCapo);
  const toggle=(string:number,on:boolean)=>{const next=on?[...strings,string]:strings.filter(value=>value!==string);setStrings(next);commit(valid?fret:0,next);};
  return <fieldset className="partial-capo" disabled={disabled||staff.isPercussion||!count}>
    <legend>Partial capo</legend>
    <label>Partial capo fret<input type="number" min={0} max={127} value={fretText} onChange={event=>setFretText(event.target.value)} onBlur={()=>commit(valid?fret:0,strings)} onKeyDown={event=>{if(event.key==='Enter')commit(valid?fret:0,strings);}}/></label>
    <div className="partial-capo-strings" role="group" aria-label="Partial capo strings">
      {Array.from({length:count},(_,at)=>count-at).map(string=><label className="check" key={string}><input type="checkbox" checked={strings.includes(string)} onChange={event=>toggle(string,event.target.checked)}/>String {string} ({formatPitch(openStringKey(staff,string,noPartialCapo))})</label>)}
    </div>
    {!valid&&<p className="muted" role="note">Use a fret from 1 to 127, or leave it empty for no partial capo.</p>}
    {valid&&fret>0&&!strings.length&&<p className="muted" role="note">Choose the strings the partial capo covers.</p>}
    {valid&&fret>0&&fret<=staff.capo&&strings.length>0&&<p className="muted" role="note">The capo at fret {staff.capo} is higher, so this partial capo changes nothing.</p>}
  </fieldset>;
}
