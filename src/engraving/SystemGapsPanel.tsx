import { useEffect,useId,useRef,useState } from 'react';
import type { EngravingCommand,EngravingOverrides } from './types';
import { resetAllSystemGaps,resetSystemGap,resolveSystemGaps,setSystemGap,SYSTEM_GAP_RANGE,type SystemSpan } from './system-gaps';
import { busyGuard } from '../ui';
import { useI18n } from '../i18n';

export interface SystemGapsPanelProps {
  value:EngravingOverrides;
  /** The rendered systems, or null outside the page layouts and while no render has completed. */
  systems:readonly SystemSpan[]|null;
  /** Whether the chosen layout stacks physical pages (the only layouts that apply system gaps). */
  pageLayout:boolean;
  /** The selected bar: the caret's bar, or the start of the music selection. Null when nothing is selected. */
  bar:number|null;
  /** The score is busy or locked: gaps cannot be recorded. The controls keep focus. */
  busy:boolean;
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown;
}

const percent=(scale:number)=>String(Math.round(scale*10000)/100);

/** Extra or reduced space above one rendered system, as a percentage of the standard gap. Saved with the document and printed. */
export function SystemGapsPanel({value,systems,pageLayout,bar,busy,onEdit}:SystemGapsPanelProps) {
  const {t}=useI18n();
  const ordered=systems&&[...systems].sort((a,b)=>a.first-b.first);
  const system=ordered&&bar!==null?ordered.find(span=>bar>=span.first&&bar<=span.last):undefined;
  const first=!!system&&system===ordered?.[0];
  const resolved=system?resolveSystemGaps(value.systemGaps,[system]).get(system.first)??1:1;
  const entries=value.systemGaps??[];
  const hasSelected=!!system&&entries.some(entry=>entry.bar>=system.first&&entry.bar<=system.last);
  const reason=!pageLayout?'system_gaps.status_layout':!systems?'system_gaps.status_rendering':bar===null?'system_gaps.status_no_selection':!system?'system_gaps.status_no_system':first?'system_gaps.status_first':null;
  const available=reason===null;
  const shown=percent(resolved);
  const [draft,setDraft]=useState(shown),[invalid,setInvalid]=useState(false);
  // The system the typed text belongs to; null while the field is untouched. Only edited text is ever committed.
  const edited=useRef<number|null>(null);
  const ids=useId(),statusId=ids+'-status',alertId=ids+'-alert';
  // Follow the document (undo, redo, selecting another system): typed text that has not been committed is dropped.
  useEffect(()=>{setDraft(shown);setInvalid(false);edited.current=null;},[shown,system?.first]);
  const min=SYSTEM_GAP_RANGE.min*100,max=SYSTEM_GAP_RANGE.max*100;
  /** true: handled (committed or nothing to do); false: the text is invalid. */
  const commit=(text:string):boolean=>{
    if(!system||!available||busy||edited.current!==system.first)return true;
    const number=Number(text);
    if(text.trim()===''||!Number.isFinite(number)||number<min||number>max){setInvalid(true);return false;}
    edited.current=null;setInvalid(false);
    // "No change" is judged on the resolved gap (and on the value as shown), not on the stored entries.
    if(text.trim()===shown||Math.abs(number/100-resolved)<=1e-9)return true;
    const engraving=setSystemGap(value,system,number/100);
    if(engraving!==value)onEdit({type:'setEngraving',engraving});
    return true;
  };
  const message=t('system_gaps.invalid',{min,max});
  return <details><summary>{t('system_gaps.title')}</summary>
    <p className="muted">{t('system_gaps.help')}</p>
    <p id={statusId} role="status" className="muted">{reason?t(reason as 'system_gaps.status_layout'):t('system_gaps.selected',{first:system!.first+1,last:system!.last+1})}</p>
    <label>{t('system_gaps.field')}<input type="number" min={min} max={max} step="any" value={draft} readOnly={busy||!available} aria-disabled={busy||!available?'true':undefined} aria-invalid={invalid||undefined} aria-describedby={invalid?statusId+' '+alertId:statusId}
      onChange={event=>{if(busy||!available||!system)return;edited.current=system.first;setDraft(event.target.value);setInvalid(false);}}
      onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit(event.currentTarget.value);}}}
      onBlur={event=>{if(!commit(event.currentTarget.value)){edited.current=null;setDraft(shown);setInvalid(false);}}}/></label>
    {invalid&&<p id={alertId} role="alert" className="muted">{message}</p>}
    <button type="button" {...busyGuard({busy,unavailable:!hasSelected,onClick:()=>{if(!system)return;const engraving=resetSystemGap(value,system);if(engraving!==value)onEdit({type:'setEngraving',engraving});}})}>{t('system_gaps.reset_selected')}</button>
    <button type="button" {...busyGuard({busy,unavailable:!entries.length,onClick:()=>{const engraving=resetAllSystemGaps(value);if(engraving!==value)onEdit({type:'setEngraving',engraving});}})}>{t('system_gaps.reset_all')}</button>
  </details>;
}
