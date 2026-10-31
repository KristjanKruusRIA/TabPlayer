import { useId,useState } from 'react';
import type { model } from '@coderline/alphatab';
import { authorDefaultFields,authorDefaultsLimit,clipAuthorText,type AuthorDefaults } from '../workspace/author-defaults';

const labels:Record<keyof AuthorDefaults,string>={artist:'Default artist',words:'Default lyrics author',music:'Default music author',tab:'Default transcriber',copyright:'Default copyright'};

/** Edits the author details scores made with New start with; the open score is never changed here. */
export function AuthorDefaultsPanel({score,load,onSave}:{score:model.Score;load:()=>AuthorDefaults;onSave:(defaults:AuthorDefaults)=>boolean}) {
  const [fields,setFields]=useState(load),[status,setStatus]=useState(''),help=useId();
  const copy=()=>{
    const long=authorDefaultFields.some(field=>score[field].length>authorDefaultsLimit);
    setFields(Object.fromEntries(authorDefaultFields.map(field=>[field,clipAuthorText(score[field])])) as AuthorDefaults);
    setStatus(`Copied this score’s details${long?`, shortening long ones to ${authorDefaultsLimit} characters`:''}. Save to keep them.`);
  };
  return <details><summary>New score defaults</summary>
    <p id={help} className="muted">Scores you create with New start with these details. Opened files, templates and the score shown at startup keep their own.</p>
    {authorDefaultFields.map(field=><label key={field}>{labels[field]}<input value={fields[field]} maxLength={authorDefaultsLimit} aria-describedby={help} onChange={event=>{setFields({...fields,[field]:event.target.value});setStatus('');}}/></label>)}
    <div className="pair">
      <button type="button" onClick={copy}>Use this score’s details</button>
      <button type="button" onClick={()=>setStatus(onSave(fields)?'Saved. Scores you create with New start with these details.':'These defaults could not be stored, so they last only until TabPlayer closes.')}>Save defaults</button>
    </div>
    <p role="status" className="muted">{status}</p>
  </details>;
}
