import { useCallback, useEffect, useState } from 'react';
import type { CabinetIrRef } from '../edit-types';
import { cabinetIrs, irDuration, irNotice, type CabinetIrEntry, type CabinetIrStatus } from './cabinet-ir';

/**
 * Picks the user's own cabinet impulse response for a cabinet block, imports one into the personal library, takes one
 * out of it, and trims its level. The response plays in place of the built-in model while the library has it; where it
 * does not, a notice says so and the model plays, and nothing in the document changes.
 */
export function CabinetResponse({ir,model,label,onChange}:{
  ir:CabinetIrRef|undefined;
  /** The built-in cabinet that plays when the response cannot. */model:string;
  /** Names a control for this pedalboard. */label:(text:string)=>string;
  onChange:(ir:CabinetIrRef|undefined)=>void;
}) {
  const [entries,setEntries]=useState<CabinetIrEntry[]>([]),[status,setStatus]=useState<CabinetIrStatus>(),[message,setMessage]=useState(''),[problem,setProblem]=useState('');
  const [draft,setDraft]=useState<string|null>(null);
  const refresh=useCallback(()=>cabinetIrs.list().then(setEntries,()=>setEntries([])),[]);
  useEffect(()=>{void refresh();},[refresh]);
  const id=ir?.id;
  // What the library can supply is asked again whenever the response named, or the library's contents, change.
  useEffect(()=>{
    let alive=true;setStatus(undefined);
    if(id)cabinetIrs.status([id]).then(found=>{if(alive)setStatus(found.find(item=>item.id===id));},()=>{});
    return()=>{alive=false;};
  },[id,entries]);
  const listed=ir?entries.find(entry=>entry.id===ir.id):undefined;
  const fallback=model.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`);
  const warning=ir?irNotice(ir.name,status,fallback):null;
  const pick=(entry:CabinetIrEntry)=>onChange({id:entry.id,name:entry.name,levelDb:ir?.levelDb??0});
  const importFile=async()=>{
    setProblem('');setMessage('');
    try {
      const entry=await cabinetIrs.import();
      if(!entry)return;
      // A file that is the response already named is not a change: the document gains no edit, and the notice clears.
      await refresh();if(ir?.id!==entry.id)pick(entry);
      setMessage(`Imported “${entry.name}” (${irDuration(entry.durationMs)}).${entry.notice?` ${entry.notice}`:''}`);
    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  const remove=async()=>{
    if(!ir)return;
    setProblem('');setMessage('');
    try {
      await cabinetIrs.remove(ir.id);await refresh();
      setMessage(`Removed “${ir.name}” from the library. Sounds that use it play their built-in cabinet.`);
    } catch(e) { setProblem(String(e instanceof Error?e.message:e)); }
  };
  /** The trim commits when the field is left or Enter is pressed, so typing a partial number loses nothing. */
  const commit=()=>{
    if(!ir||draft===null)return;
    const value=Number(draft);setDraft(null);
    if(draft.trim()!==''&&Number.isFinite(value)&&value>=-12&&value<=12&&value!==ir.levelDb)onChange({...ir,levelDb:value});
  };
  return <div className="sound-cabinet-ir" role="group" aria-label={label('Cabinet impulse response')}>
    <label>Impulse response<select aria-label={label('Cabinet impulse response')} value={ir?.id??''} onChange={e=>{
      const entry=entries.find(item=>item.id===e.target.value);
      if(entry)pick(entry);else if(!e.target.value)onChange(undefined);
    }}>
      <option value="">Built-in cabinet (model above)</option>
      {entries.map(entry=><option key={entry.id} value={entry.id}>{entry.name} · {irDuration(entry.durationMs)}</option>)}
      {ir&&!listed&&<option value={ir.id}>{ir.name} (not in this library)</option>}
    </select></label>
    <button aria-label={label('Import cabinet impulse response')} onClick={()=>void importFile()}>Import impulse response…</button>
    <button aria-label={label('Remove cabinet impulse response from library')} disabled={!listed} onClick={()=>void remove()}>Remove from library</button>
    {ir&&<label>Impulse response level (dB)<input aria-label={label('Cabinet impulse response level (dB)')} type="number" min={-12} max={12} step={.5} value={draft??ir.levelDb}
      onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')commit();else if(e.key==='Escape')setDraft(null);}}/></label>}
    {warning&&<p className="sound-ir-notice" role="status">{warning}</p>}
    {message&&<p className="muted" role="status">{message}</p>}
    {problem&&<p className="sound-ir-problem" role="alert">{problem}</p>}
    <p className="muted">WAV files, mono or stereo, up to 2 seconds. A copy is kept in your library; documents only name it.</p>
  </div>;
}
