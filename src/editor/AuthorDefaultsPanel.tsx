import { useI18n } from '../i18n';
import { useId,useState } from 'react';
import type { model } from '@coderline/alphatab';
import { authorDefaultFields,authorDefaultsLimit,clipAuthorText,type AuthorDefaults } from '../workspace/author-defaults';

/** Edits the author details scores made with New start with; the open score is never changed here. */
export function AuthorDefaultsPanel({score,load,onSave}:{score:model.Score;load:()=>AuthorDefaults;onSave:(defaults:AuthorDefaults)=>boolean}) {
  const { t } = useI18n();
  const labels:Record<keyof AuthorDefaults,string>={artist:t('editor.default_artist'),words:t('editor.default_words'),music:t('editor.default_music'),tab:t('editor.default_tab'),copyright:t('editor.default_copyright')};
  const [fields,setFields]=useState(load),[status,setStatus]=useState(''),help=useId();
  const copy=()=>{
    const long=authorDefaultFields.some(field=>score[field].length>authorDefaultsLimit);
    setFields(Object.fromEntries(authorDefaultFields.map(field=>[field,clipAuthorText(score[field])])) as AuthorDefaults);
    setStatus(long?t('editor.copied_details_shortened',{limit:authorDefaultsLimit}):t('editor.copied_details'));
  };
  return <details><summary>{t('editor.author_defaults_title')}</summary>
    <p id={help} className="muted">{t('editor.author_defaults_help')}</p>
    {authorDefaultFields.map(field=><label key={field}>{labels[field]}<input value={fields[field]} maxLength={authorDefaultsLimit} aria-describedby={help} onChange={event=>{setFields({...fields,[field]:event.target.value});setStatus('');}}/></label>)}
    <div className="pair">
      <button type="button" onClick={copy}>{t('editor.use_score_details')}</button>
      <button type="button" onClick={()=>setStatus(onSave(fields)?t('editor.defaults_saved'):t('editor.defaults_storage_error'))}>{t('editor.save_defaults')}</button>
    </div>
    <p role="status" className="muted">{status}</p>
  </details>;
}
