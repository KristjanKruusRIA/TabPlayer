import { useEffect,useRef,useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EngravingCommand,EngravingOverrides } from './types';
import { validateEngravingTracks } from './projection';
import { defaultStyle,newStyleId,putStyleLibraryEntry,readStyleLibrary,removeStyleLibraryEntry,styleApplied,styleNameError,styleOf,subscribeStyleLibrary,type SavedStyle,type StyleEngraving } from './style-library';

interface StylePresetsPanelProps {
  score:model.Score;trackIds:readonly string[];value:EngravingOverrides;
  /** The panel's form holds changes that were not applied; applying a saved style would discard them. */
  unapplied:boolean;
  /** True while the document cannot take an edit. Library actions do not depend on it. */
  busy:boolean;
  /** May return a promise of whether the edit was accepted; anything but a resolved `false` counts as accepted. */
  onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>unknown;
}
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

/** Saves the document's engraving style in the personal style library and applies a saved style to any document.
 * Applying is one `setEngraving` edit: it changes only engraving settings, never the music, and keeps the document's
 * own staff profiles because those belong to its tracks. */
export function StylePresetsPanel({score,trackIds,value,unapplied,busy,onEdit}:StylePresetsPanelProps) {
  const [entries,setEntries]=useState<SavedStyle[]|null>(null),[selected,setSelected]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState(''),[error,setError]=useState(''),[readError,setReadError]=useState(''),[working,setWorking]=useState(false);
  const live=useRef(true),requested=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>subscribeStyleLibrary(library=>{if(live.current){setEntries(library.entries);setReadError('');}}),[]);
  const load=()=>{
    if(requested.current)return;requested.current=true;
    readStyleLibrary().then(library=>{if(live.current){setEntries(library.entries);setReadError('');}},cause=>{requested.current=false;if(live.current)setReadError(`Could not read saved styles: ${message(cause)}`);});
  };
  const chosen=entries?.find(entry=>entry.id===selected)??null,trimmed=name.trim(),nameProblem=trimmed?styleNameError(trimmed):null;
  // The one condition that stops a style being applied to the document. Saving, updating and deleting never use it.
  const documentBlocked=busy;
  const cannotApply=documentBlocked||unapplied||working;
  const run=async(operation:()=>Promise<SavedStyle[]>,done:(next:SavedStyle[])=>void)=>{
    setWorking(true);setError('');setStatus('');
    try{const next=await operation();if(live.current){setEntries(next);setReadError('');done(next);}}
    catch(cause){if(live.current)setError(message(cause));}
    finally{if(live.current)setWorking(false);}
  };
  const applyStyle=async(style:StyleEngraving,label:string)=>{
    const next=styleApplied(style,{...value,profiles:value.profiles.filter(entry=>trackIds.includes(entry.trackId))});
    setError('');setStatus('');
    // Staff profiles belong to the document, so only the style parts decide whether anything would change.
    if(JSON.stringify(styleOf(next))===JSON.stringify(styleOf(value))){setStatus(`${label} already matches this document.`);return;}
    try{
      validateEngravingTracks(score,trackIds,next);
      const accepted=await Promise.resolve<unknown>(onEdit({type:'setEngraving',engraving:next}));
      if(!live.current)return;
      if(accepted===false)setError(`Could not apply ${label}; the document is unchanged.`);else setStatus(`Applied ${label}.`);
    }catch(cause){if(live.current)setError(message(cause));}
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
  const empty=entries===null?(readError?'Saved styles could not be read':'Open to load saved styles'):entries.length?'Choose a saved style':readError?'Saved styles could not be read':'No saved styles yet';
  return <details onToggle={event=>{if((event.currentTarget as HTMLDetailsElement).open)load();}}><summary>Saved styles</summary>
    <p className="muted">Personal styles are kept on this computer and work in every document. Applying one changes only the engraving settings, never the music, and keeps this score's staff profiles. Save stores the style that is applied to the document, not unapplied changes in the form above.</p>
    <label>Saved style<select value={selected} disabled={working||!entries?.length} onChange={event=>{setSelected(event.target.value);setStatus('');}}>
      <option value="">{empty}</option>
      {entries?.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select></label>
    {unapplied&&<p className="muted">Apply or reset your engraving changes before applying a saved style, which would discard them.</p>}
    <div className="pair">
      <button type="button" disabled={cannotApply||!chosen} onClick={()=>{if(chosen)void applyStyle(chosen.engraving,chosen.name);}}>Apply saved style</button>
      <button type="button" disabled={working||!chosen} onClick={remove}>Delete saved style</button>
    </div>
    <label>Style name<input value={name} maxLength={200} disabled={working} aria-invalid={!!nameProblem||undefined} onChange={event=>{setName(event.target.value);setStatus('');}}/></label>
    {nameProblem&&<p className="muted">{nameProblem}</p>}
    <div className="pair">
      <button type="button" disabled={working||!trimmed||!!nameProblem} onClick={saveNew}>Save current style</button>
      <button type="button" disabled={working||!chosen||!!nameProblem} onClick={replaceSelected}>Update saved style</button>
    </div>
    <button type="button" disabled={cannotApply} onClick={()=>{void applyStyle(defaultStyle(),'the default style');}}>Force default style</button>
    {readError&&<p role="alert">{readError}</p>}
    {error&&<p role="alert">{error}</p>}
    <p role="status" className="muted">{status}</p>
  </details>;
}
