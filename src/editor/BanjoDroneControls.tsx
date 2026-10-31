import { useI18n } from '../i18n';
import { useState } from 'react';
import type { model } from '@coderline/alphatab';
import { maxDroneFret, standardDroneFret } from './banjo-drone';

/** The short fifth string of a banjo. The fret is committed on blur or Enter, the checkbox at once. `onChange` only ever gets a valid value (0 for none), never one for a field nobody changed; `onInvalid` says whether the draft on screen is not valid, so the caller can hold back Apply and keep the last valid value. */
export function BanjoDroneControls({staff,value,disabled,onChange,onInvalid}:{staff:model.Staff;value:number;disabled?:boolean;onChange:(value:number)=>void;onInvalid?:(invalid:boolean)=>void}) {
  const { t } = useI18n();
  const [on,setOn]=useState(value>0),[fretText,setFretText]=useState(String(value||standardDroneFret)),[dirty,setDirty]=useState(false);
  const fret=fretText.trim()===''?NaN:Number(fretText),valid=Number.isInteger(fret)&&fret>=1&&fret<=maxDroneFret;
  const commit=(enabled:boolean)=>{const good=!enabled||valid;onInvalid?.(!good);if(good)onChange(enabled?fret:0);};
  const fiveStrings=staff.tuning.length===5&&!staff.isPercussion;
  return <fieldset className="banjo-drone" disabled={disabled||!fiveStrings}>
    <legend>{t('editor.banjo_drone')}</legend>
    <label className="check"><input type="checkbox" checked={on} onChange={event=>{setOn(event.target.checked);setDirty(true);commit(event.target.checked);}}/>{t('editor.short_drone_string')}</label>
    <label>{t('editor.drone_starts_at_fret')}<input type="number" min={1} max={maxDroneFret} disabled={!on} value={fretText} onChange={event=>{setFretText(event.target.value);setDirty(true);}} onBlur={()=>{if(dirty)commit(on);}} onKeyDown={event=>{if(event.key==='Enter'&&dirty)commit(on);}}/></label>
    {!fiveStrings&&<p className="muted" role="note">{t('editor.banjo_drone_needs_five')}</p>}
    {dirty&&on&&!valid&&<p className="muted" role="alert">{t('editor.drone_fret_range',{max:maxDroneFret})}</p>}
    {on&&valid&&<p className="muted" role="note">{t('editor.drone_fret_numbering',{fret,next:fret+1})}</p>}
  </fieldset>;
}
