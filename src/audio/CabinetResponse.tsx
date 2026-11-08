import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { CabinetIrRef } from '../edit-types';
import { announceCabinetLibrary, cabinetIrs, irDuration, irNotice, type CabinetIrEntry, type CabinetIrStatus } from './cabinet-ir';

/**
 * Picks a cabinet impulse response for a cabinet block from the responses that ship with TabPlayer or the user's own
 * library, imports one, takes one out of the library, and trims its level. The response plays in place of the built-in
 * model while the library has it; where it does not, a notice says so and the model plays, and nothing in the document
 * changes.
 */
export function CabinetResponse({ir,model,label,scope,onChange,onLibraryChange}:{
  ir:CabinetIrRef|undefined;
  /** The built-in cabinet that plays when the response cannot. */model:string;
  /** Names a control for this pedalboard. */label:(text:string)=>string;
  /** Names the sound this belongs to, so a choice made while the file dialog was open is not written to another. */scope?:string;
  onChange:(ir:CabinetIrRef|undefined)=>void;
  /** Called when the library gains or loses a response, so playback resolves the cabinet responses again. The document does not change when one is imported, so nothing else would. */
  onLibraryChange?:()=>void;
}) {
  const { t } = useI18n();
  const [entries,setEntries]=useState<CabinetIrEntry[]>([]),[found,setStatus]=useState<CabinetIrStatus>(),[message,setMessage]=useState(''),[problem,setProblem]=useState('');
  const [draft,setDraft]=useState<string|null>(null);
  const refresh=useCallback(()=>cabinetIrs.list().then(setEntries,()=>setEntries([])),[]);
  useEffect(()=>{void refresh();},[refresh]);
  const id=ir?.id;
  // The file dialog is modal to the user, not to the app: when it closes the sound may have changed, so what follows reads this.
  const latest=useRef({ir,scope,onChange});latest.current={ir,scope,onChange};
  // The picker can be gone by then (another track or block was opened), and then nothing is written.
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  // What the library can supply is asked again whenever the response named, or the library's contents, change.
  // The previous answer stays until the new one arrives, so a refresh does not blink the notice; one that belongs to another response is never shown.
  const status=found&&found.id===id?found:undefined;
  useEffect(()=>{
    let alive=true;
    if(id)cabinetIrs.status([id]).then(found=>{if(alive)setStatus(found.find(item=>item.id===id));},()=>{});
    return()=>{alive=false;};
  },[id,entries]);
  const listed=ir?entries.find(entry=>entry.id===ir.id):undefined;
  const fallback=model.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`);
  const warning=ir?irNotice(ir.name,status,fallback,(k,values)=>t(k,values)):null;
  const pick=(entry:CabinetIrEntry)=>onChange({id:entry.id,name:entry.name,levelDb:ir?.levelDb??0});
  const importFile=async()=>{
    setProblem('');setMessage('');
    const opened=scope;
    try {
      const entry=await cabinetIrs.import();
      if(!entry)return;
      await refresh();announceCabinetLibrary();onLibraryChange?.();
      if(!mounted.current)return;
      // The sound as it is now, not as it was when the dialog opened. A file that is the response already named is not
      // a change: the document gains no edit, and the notice clears. If the track changed meanwhile, nothing is written.
      const now=latest.current;let note='';
      if(now.scope!==opened)note=` ${t('sound.ir_track_changed')}`;
      else if(now.ir?.id!==entry.id)now.onChange({id:entry.id,name:entry.name,levelDb:now.ir?.levelDb??0});
      setMessage(entry.bundled ? t('sound.ir_already_bundled', { name: entry.name, note }) : t('sound.ir_imported', { name: entry.name, duration: irDuration(entry.durationMs), notice: entry.notice ? ` ${entry.notice}` : '', note }));


    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  const remove=async()=>{
    if(!ir)return;
    setProblem('');setMessage('');
    try {
      await cabinetIrs.remove(ir.id);await refresh();announceCabinetLibrary();onLibraryChange?.();
      setMessage(t('sound.ir_removed', { name: ir.name }));
    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  /** The trim commits when the field is left or Enter is pressed, so typing a partial number loses nothing. */
  const commit=()=>{
    if(!ir||draft===null)return;
    const value=Number(draft);setDraft(null);
    if(draft.trim()!==''&&Number.isFinite(value)&&value>=-12&&value<=12&&value!==ir.levelDb)onChange({...ir,levelDb:value});
  };
  return <div className="sound-cabinet-ir" role="group" aria-label={label(t('sound.ir_label'))}>
    <label>{t('sound.ir_select_label')}<select aria-label={label(t('sound.ir_label'))} value={ir?.id??''} onChange={e=>{
      const entry=entries.find(item=>item.id===e.target.value);
      if(entry)pick(entry);else if(!e.target.value)onChange(undefined);
    }}>
      <option value="">{t('sound.ir_builtin')}</option>
      {entries.map(entry=><option key={entry.id} value={entry.id}>{entry.name} · {irDuration(entry.durationMs)}</option>)}
      {ir&&!listed&&<option value={ir.id}>{t('sound.ir_not_in_library', { name: ir.name })}</option>}
    </select></label>
    <button aria-label={label(t('sound.ir_import_aria'))} onClick={()=>void importFile()}>{t('sound.ir_import')}</button>
    <button aria-label={label(t('sound.ir_remove_aria'))} disabled={!listed||listed.bundled} title={listed?.bundled?t('sound.ir_bundled_title'):undefined} onClick={()=>void remove()}>{t('sound.ir_remove')}</button>
    {ir&&<label>{t('sound.ir_level')}<input aria-label={label(t('sound.ir_level_aria'))} type="number" min={-12} max={12} step={.5} value={draft??ir.levelDb}
      onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();else if(e.key==='Escape')setDraft(null);}}/></label>}
    {warning&&<p className="sound-ir-notice" role="status">{warning}</p>}
    {message&&<p className="muted" role="status">{message}</p>}
    {problem&&<p className="sound-ir-problem" role="alert">{problem}</p>}
    <p className="muted">{t('sound.ir_help')}</p>
  </div>;
}
