import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { metadataFields } from './song';

export function SongPanel({score,busy,onEdit}:{score:model.Score;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const { t } = useI18n();
  const read=()=>Object.fromEntries(metadataFields.map(key=>[key,score[key]])) as Pick<model.Score,typeof metadataFields[number]>;
  const [fields,setFields]=useState(read);
  useEffect(()=>{setFields(read());},[score]);
  return <details><summary>{t('editor.song_metadata')}</summary><fieldset disabled={busy}>
    {([['subTitle',t('editor.subtitle')],['album',t('editor.album')],['words',t('editor.lyrics_author')],['music',t('editor.music_author')],['copyright',t('editor.copyright')],['tab',t('editor.transcriber')]] as const).map(([key,label])=><label key={key}>{label}<input value={fields[key]} onChange={e=>setFields({...fields,[key]:e.target.value})}/></label>)}
    <label>{t('editor.notices')}<textarea value={fields.notices} onChange={e=>setFields({...fields,notices:e.target.value})}/></label>
    <label>{t('editor.instructions')}<textarea value={fields.instructions} onChange={e=>setFields({...fields,instructions:e.target.value})}/></label>
    <button onClick={()=>onEdit({type:'setScoreMetadata',fields})}>{t('editor.apply_song_metadata')}</button>
  </fieldset></details>;
}
