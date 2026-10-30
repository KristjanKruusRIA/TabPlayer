import { useEffect,useMemo,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import { formatTuning,parseTuning } from '../tuning';
import { tuningPresets } from '../tuning-presets';
import { AuditionButtons } from './AuditionButtons';
import { isXmlText,newTuningId,putTuningLibraryEntry,readTuningLibrary,removeTuningLibraryEntry,subscribeTuningLibrary,tuningNameError,type SavedTuning } from './library';
import { Dialog } from '../ui/Dialog';
import './saved-tunings-dialog.css';

type Identity={kind:'personal';id:string}|{kind:'builtin';index:number};
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
const groups=[...new Set(tuningPresets.map(p=>`${p.instrument}/${p.strings}`))].map(key=>{
  const members=tuningPresets.map((preset,index)=>({preset,index})).filter(({preset})=>`${preset.instrument}/${preset.strings}`===key),first=members[0].preset;
  return {key,title:`${first.instrument==='guitar'?'Guitar':'Bass'} · ${first.strings} strings`,members};
});
const parsed=(text:string):{notes:number[]}|{error:string}=>{try{return {notes:parseTuning(text)};}catch(cause){return {error:message(cause)};}};
const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((pitch,index)=>pitch===b[index]);

/** Mounted only while open; closing or unmounting discards every late library response. */
export function SavedTuningsDialog({notes,name,onUse,onClose,onAudition}:{notes:string;name:string;onUse:(notes:string,name:string)=>void;onClose:()=>void;onAudition?:(pitches:number[],strum:boolean)=>void}) {
  const [entries,setEntries]=useState<SavedTuning[]>([]),[loaded,setLoaded]=useState(false),[readError,setReadError]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [selection,setSelection]=useState<Identity|null>(null),[detailNotes,setDetailNotes]=useState(notes),[detailName,setDetailName]=useState(name);
  // details counts selections and detail edits, so a library response that settles after the user moved on leaves them alone.
  const nameInput=useRef<HTMLInputElement>(null),generation=useRef(0),details=useRef(0);
  useEffect(()=>{
    const token=++generation.current,live=()=>generation.current===token;
    const apply=(next:SavedTuning[])=>{if(!live())return;setEntries(next);setLoaded(true);setReadError('');};
    const stop=subscribeTuningLibrary(library=>apply(library.entries));
    readTuningLibrary().then(library=>apply(library.entries),cause=>{if(live()){setLoaded(true);setReadError(`Could not read saved tunings: ${message(cause)}`);}});
    return()=>{generation.current++;stop();};
  },[]);
  // A removed personal entry stays only as an independent unsaved draft.
  useEffect(()=>{setSelection(current=>current?.kind==='personal'&&!entries.some(entry=>entry.id.toLowerCase()===current.id.toLowerCase())?null:current);},[entries]);
  const result=useMemo(()=>parsed(detailNotes),[detailNotes]),trimmed=detailName.trim();
  const selectedEntry=selection?.kind==='personal'?entries.find(entry=>entry.id.toLowerCase()===selection.id.toLowerCase()):undefined;
  // Pending actions stay focusable (aria-disabled) so keyboard focus remains in the dialog while a save runs.
  const nameProblem=tuningNameError(trimmed),canSaveNew=!readError&&'notes' in result&&!nameProblem;
  const canSaveChanges=!!selectedEntry&&'notes' in result&&same(result.notes,selectedEntry.tuning)&&!nameProblem;
  const canUse='notes' in result&&isXmlText(trimmed);
  const select=(identity:Identity,pitches:readonly number[],label:string)=>{details.current++;setSelection(identity);setDetailNotes(formatTuning(pitches));setDetailName(label);setError('');};
  async function mutate(action:()=>Promise<SavedTuning[]>,after:()=>void){
    if(pending)return;const token=generation.current,version=details.current;setPending(true);setError('');
    try{const next=await action();if(generation.current!==token)return;setEntries(next);if(details.current===version)after();}
    catch(cause){if(generation.current===token)setError(message(cause));}
    finally{if(generation.current===token)setPending(false);}
  }
  const saveNew=()=>{if(!('notes' in result))return;const entry={id:newTuningId(),name:trimmed,tuning:result.notes};void mutate(async()=>(await putTuningLibraryEntry(entry)).entries,()=>{setSelection({kind:'personal',id:entry.id});setDetailName(entry.name);});};
  const saveChanges=()=>{if(!selectedEntry)return;const entry={id:selectedEntry.id,name:trimmed,tuning:[...selectedEntry.tuning]};void mutate(async()=>(await putTuningLibraryEntry(entry)).entries,()=>setDetailName(entry.name));};
  const remove=()=>{if(!selectedEntry)return;void mutate(async()=>(await removeTuningLibraryEntry(selectedEntry.id)).entries,()=>{setSelection(null);nameInput.current?.focus({preventScroll:true});});};
  const use=()=>{if(!('notes' in result)||!canUse)return;generation.current++;onUse(formatTuning(result.notes),trimmed);onClose();};
  const row=(identity:Identity,key:string,label:string,pitches:readonly number[])=>{
    const active=selection!==null&&(identity.kind==='builtin'?selection.kind==='builtin'&&selection.index===identity.index:selection.kind==='personal'&&selection.id.toLowerCase()===identity.id.toLowerCase());
    return <li key={key}><button type="button" className="saved-tuning-row" aria-pressed={active} onClick={()=>select(identity,pitches,label)}><span className="saved-tuning-row-name">{label}</span><span className="saved-tuning-row-pitches">{formatTuning(pitches)}</span></button></li>;
  };
  const actions=<>
    <button type="button" className="tp-button" onClick={onClose}>Cancel</button>
    <button type="button" className="tp-button primary" disabled={!canUse} onClick={use}>Use tuning</button>
  </>;
  return createPortal(<Dialog title="Saved tunings" onClose={onClose} className="saved-tunings-dialog" actions={actions}>
    <div className="saved-tunings-body">
      <div className="saved-tunings-list">
        <section aria-labelledby="saved-tunings-personal"><h3 id="saved-tunings-personal">Personal</h3>
          {entries.length?<ul>{entries.map(entry=>row({kind:'personal',id:entry.id},entry.id,entry.name,entry.tuning))}</ul>:<p className="muted">{readError?'Personal tunings are unavailable.':loaded?'No personal tunings saved yet.':'Loading saved tunings…'}</p>}
        </section>
        <section aria-labelledby="saved-tunings-builtin"><h3 id="saved-tunings-builtin">Built-in</h3>
          {groups.map(group=><div key={group.key} role="group" aria-label={group.title}><h4>{group.title}</h4><ul>{group.members.map(({preset,index})=>row({kind:'builtin',index},preset.id,preset.name,preset.tuning))}</ul></div>)}
        </section>
      </div>
      <div className="saved-tunings-details"><h3>Details</h3>
        <label>Saved tuning name<input ref={nameInput} data-autofocus value={detailName} aria-describedby="saved-tuning-name-help" aria-invalid={trimmed&&nameProblem?true:undefined} onChange={e=>{details.current++;setDetailName(e.target.value);}}/></label>
        <p className="muted" id="saved-tuning-name-help">{trimmed&&nameProblem?nameProblem:'A name is needed to save. Using a tuning does not require one.'}</p>
        <label>Saved tuning pitches (notes, high to low)<input value={detailNotes} aria-invalid={'error' in result?true:undefined} aria-describedby="saved-tuning-pitch-help" onChange={e=>{details.current++;setDetailNotes(e.target.value);setDetailName('');setSelection(null);setError('');}}/></label>
        <p className={'error' in result?'saved-tuning-problem':'muted'} id="saved-tuning-pitch-help">{'error' in result?result.error:`${result.notes.length} strings. Built-in tunings cannot be changed; save a copy to keep your own.`}</p>
        {onAudition&&'notes' in result&&<AuditionButtons pitches={result.notes} onAudition={onAudition}/>}
        <div className="saved-tunings-actions">
          <button type="button" disabled={!canSaveNew} aria-disabled={pending||undefined} onClick={saveNew}>Save as new</button>
          <button type="button" disabled={!canSaveChanges} aria-disabled={pending||undefined} onClick={saveChanges}>Save changes</button>
          <button type="button" disabled={!selectedEntry} aria-disabled={pending||undefined} onClick={remove}>Delete</button>
        </div>
        {(readError||error)&&<p role="alert" className="saved-tuning-problem">{error||readError}</p>}
        <p className="muted">Saving only updates your library. Use tuning fills the draft; Apply changes the score.</p>
      </div>
    </div>
  </Dialog>,document.body);
}
