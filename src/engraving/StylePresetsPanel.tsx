import { useEffect,useRef,useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EngravingCommand,EngravingOverrides } from './types';
import { validateEngravingTracks } from './projection';
import { defaultStyle,newStyleId,putStyleLibraryEntry,readStyleLibrary,removeStyleLibraryEntry,styleApplied,styleNameError,styleOf,subscribeStyleLibrary,type SavedStyle,type StyleEngraving } from './style-library';

interface StylePresetsPanelProps {
  score:model.Score;trackIds:readonly string[];value:EngravingOverrides;
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>void;
}
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

/** Saves the document's engraving style in the personal style library and applies a saved style to any document.
 * Applying is one `setEngraving` edit: it changes only engraving settings, never the music, and keeps the document's
 * own staff profiles because those belong to its tracks. */
export function StylePresetsPanel({score,trackIds,value,onEdit}:StylePresetsPanelProps) {
  const [entries,setEntries]=useState<SavedStyle[]|null>(null),[selected,setSelected]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const live=useRef(true),requested=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>subscribeStyleLibrary(library=>{if(live.current)setEntries(library.entries);}),[]);
  const load=()=>{
    if(requested.current)return;requested.current=true;
    readStyleLibrary().then(library=>{if(live.current)setEntries(library.entries);},cause=>{requested.current=false;if(live.current){setEntries([]);setError(`Could not read saved styles: ${message(cause)}`);}});
  };
  const chosen=entries?.find(entry=>entry.id===selected)??null,trimmed=name.trim(),nameProblem=trimmed?styleNameError(trimmed):null;
  const run=async(operation:()=>Promise<SavedStyle[]>,done:(next:SavedStyle[])=>void)=>{
    setWorking(true);setError('');setStatus('');
    try{const next=await operation();if(live.current){setEntries(next);done(next);}}
    catch(cause){if(live.current)setError(message(cause));}
    finally{if(live.current)setWorking(false);}
  };
  const applyStyle=(style:StyleEngraving,label:string)=>{
    const next=styleApplied(style,{...value,profiles:value.profiles.filter(entry=>trackIds.includes(entry.trackId))});
    setError('');
    if(JSON.stringify(next)===JSON.stringify(value)){setStatus(`${label} already matches this document.`);return;}
    try{validateEngravingTracks(score,trackIds,next);onEdit({type:'setEngraving',engraving:next});setStatus(`Applied ${label}.`);}catch(cause){setStatus('');setError(message(cause));}
  };
  const saveNew=()=>{
    if(!trimmed||nameProblem)return;const entry:SavedStyle={id:newStyleId(),name:trimmed,engraving:styleOf(value)};
    void run(async()=>(await putStyleLibraryEntry(entry)).entries,()=>{setSelected(entry.id);setStatus(`Saved ${entry.name}.`);});
  };
  const replaceSelected=()=>{
    if(!chosen||nameProblem)return;const entry:SavedStyle={id:chosen.id,name:trimmed||chosen.name,engraving:styleOf(value)};
    void run(async()=>(await putStyleLibraryEntry(entry)).entries,()=>{setName('');setStatus(`Updated ${entry.name} from this document.`);});
  };
  const remove=()=>{
    if(!chosen)return;const removed=chosen.name;
    void run(async()=>(await removeStyleLibraryEntry(chosen.id)).entries,()=>{setSelected('');setStatus(`Deleted ${removed}.`);});
  };
  return <details onToggle={event=>{if((event.currentTarget as HTMLDetailsElement).open)load();}}><summary>Saved styles</summary>
    <p className="muted">Personal styles are kept on this computer and work in every document. Applying one changes only the engraving settings, never the music, and keeps this score's staff profiles.</p>
    <label>Saved style<select value={selected} disabled={working||!entries?.length} onChange={event=>{setSelected(event.target.value);setStatus('');setError('');}}>
      <option value="">{entries===null?'Open to load saved styles':entries.length?'Choose a saved style':'No saved styles yet'}</option>
      {entries?.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select></label>
    <div className="pair">
      <button type="button" disabled={working||!chosen} onClick={()=>chosen&&applyStyle(chosen.engraving,chosen.name)}>Apply saved style</button>
      <button type="button" disabled={working||!chosen} onClick={remove}>Delete saved style</button>
    </div>
    <label>Style name<input value={name} maxLength={200} aria-invalid={!!nameProblem||undefined} onChange={event=>{setName(event.target.value);setStatus('');setError('');}}/></label>
    {nameProblem&&<p className="muted">{nameProblem}</p>}
    <div className="pair">
      <button type="button" disabled={working||!trimmed||!!nameProblem} onClick={saveNew}>Save current style</button>
      <button type="button" disabled={working||!chosen||!!nameProblem} onClick={replaceSelected}>Update saved style</button>
    </div>
    <button type="button" onClick={()=>applyStyle(defaultStyle(),'the default style')}>Force default style</button>
    {error&&<p role="alert">{error}</p>}
    <p role="status" className="muted">{status}</p>
  </details>;
}
