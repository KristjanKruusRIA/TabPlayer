import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { metadataFields } from './song';

export function SongPanel({score,busy,onEdit}:{score:model.Score;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const read=()=>Object.fromEntries(metadataFields.map(key=>[key,score[key]])) as Pick<model.Score,typeof metadataFields[number]>;
  const [fields,setFields]=useState(read);
  useEffect(()=>{setFields(read());},[score]);
  return <details><summary>Song metadata</summary><fieldset disabled={busy}>
    {([['subTitle','Subtitle'],['album','Album'],['words','Lyrics author'],['music','Music author'],['copyright','Copyright'],['tab','Transcriber']] as const).map(([key,label])=><label key={key}>{label}<input value={fields[key]} onChange={e=>setFields({...fields,[key]:e.target.value})}/></label>)}
    <label>Notices<textarea value={fields.notices} onChange={e=>setFields({...fields,notices:e.target.value})}/></label>
    <label>Instructions<textarea value={fields.instructions} onChange={e=>setFields({...fields,instructions:e.target.value})}/></label>
    <button onClick={()=>onEdit({type:'setScoreMetadata',fields})}>Apply song metadata</button>
  </fieldset></details>;
}
