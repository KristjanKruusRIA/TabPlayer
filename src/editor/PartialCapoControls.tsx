import { useI18n } from '../i18n';
import { useState } from 'react';
import type { model } from '@coderline/alphatab';
import { formatPitch } from '../tuning';
import { noPartialCapo, openStringKey, type PartialCapo } from './partial-capo';

/** Fret and strings of a capo over part of the neck. The fret is committed on blur or Enter, the strings at once. `onChange` only ever gets a valid value, never one for a field nobody changed; `onInvalid` says whether the draft on screen is not valid, so the caller can hold back Apply and keep the last valid value. */
export function PartialCapoControls({staff,value,disabled,onChange,onInvalid}:{staff:model.Staff;value:PartialCapo;disabled?:boolean;onChange:(value:PartialCapo)=>void;onInvalid?:(invalid:boolean)=>void}) {
  const { t } = useI18n();
  const [fretText,setFretText]=useState(value.fret?String(value.fret):''),[strings,setStrings]=useState<number[]>(value.strings),[dirty,setDirty]=useState(false);
  const count=staff.tuning.length,fret=fretText.trim()===''?0:Number(fretText),fretValid=Number.isInteger(fret)&&fret>=0&&fret<=127;
  const problem=!fretValid?t('editor.partial_capo_fret_range'):fret>0&&!strings.length?t('editor.partial_capo_choose_strings'):fret===0&&strings.length?t('editor.partial_capo_enter_fret'):'';
  const commit=(nextFret:number,nextStrings:number[],ok:boolean)=>{
    const good=ok&&(nextFret===0?nextStrings.length===0:nextFret>=1&&nextStrings.length>0);
    onInvalid?.(!good);if(good)onChange(nextFret===0?noPartialCapo:{fret:nextFret,strings:[...nextStrings].sort((a,b)=>a-b)});
  };
  const toggle=(string:number,on:boolean)=>{const next=on?[...strings,string]:strings.filter(value=>value!==string);setStrings(next);setDirty(true);commit(fret,next,fretValid);};
  const settle=()=>{if(dirty)commit(fret,strings,fretValid);};
  return <fieldset className="partial-capo" disabled={disabled||staff.isPercussion||!count}>
    <legend>{t('editor.partial_capo')}</legend>
    <label>{t('editor.partial_capo_fret')}<input type="number" min={0} max={127} value={fretText} onChange={event=>{setFretText(event.target.value);setDirty(true);}} onBlur={settle} onKeyDown={event=>{if(event.key==='Enter')settle();}}/></label>
    <div className="partial-capo-strings" role="group" aria-label={t('editor.partial_capo_strings')}>
      {Array.from({length:count},(_,at)=>count-at).map(string=><label className="check" key={string}><input type="checkbox" checked={strings.includes(string)} onChange={event=>toggle(string,event.target.checked)}/>String {string} ({formatPitch(openStringKey(staff,string,noPartialCapo))})</label>)}
    </div>
    {dirty&&problem&&<p className="muted" role="alert">{problem}</p>}
    {dirty&&!problem&&fret>0&&fret<=staff.capo&&strings.length>0&&<p className="muted" role="note">The capo at fret {staff.capo} is higher, so this partial capo changes nothing.</p>}
  </fieldset>;
}
