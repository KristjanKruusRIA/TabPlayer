import { useI18n } from '../i18n';
import { useEffect,useState } from 'react';
import type { LyricsPanelProps } from './lyrics-types';
import { getTrackLyrics } from './lyrics';

export function LyricsPanel({score,track,busy,onEdit}:LyricsPanelProps) {
  const { t } = useI18n();
  const [draft,setDraft]=useState(()=>getTrackLyrics(score,track));
  useEffect(()=>{setDraft(getTrackLyrics(score,track));},[score,track]);
  const invalid=draft.lines.some(line=>!Number.isInteger(line.startBar)||line.startBar<0||line.startBar>=score.masterBars.length);
  return <details><summary>{t('editor.lyrics')}</summary><fieldset disabled={busy}>
    <p>{score.tracks[track].name}</p>
    <label>{t('editor.visible')}<input type="checkbox" checked={draft.visible} onChange={e=>setDraft({...draft,visible:e.target.checked})}/></label>
    {draft.source==='distributed'&&<p>{t('editor.lyrics_reconstructed')}</p>}
    <p>{t('editor.lyrics_syntax_hint')}</p>
    {draft.lines.map((line,index)=><fieldset key={index}><legend>{t('editor.lyrics_line_n', { index: index+1 })}</legend>
      <label>{t('editor.lyrics_start_measure', { index: index+1 })}<input type="number" min={1} max={score.masterBars.length} step={1} value={line.startBar+1} onChange={e=>setDraft({...draft,lines:draft.lines.map((value,i)=>i===index?{...value,startBar:Number(e.target.value)-1}:value)})}/></label>
      <label>{t('editor.lyrics_text', { index: index+1 })}<textarea value={line.text} onChange={e=>setDraft({...draft,lines:draft.lines.map((value,i)=>i===index?{...value,text:e.target.value}:value)})}/></label>
      <button type="button" aria-label={t('editor.remove_line_n', { index: index+1 })} onClick={()=>setDraft({...draft,lines:draft.lines.filter((_,i)=>i!==index)})}>{t('editor.remove_line')}</button>
    </fieldset>)}
    <button type="button" disabled={draft.lines.length>=5} onClick={()=>setDraft({...draft,lines:[...draft.lines,{startBar:0,text:''}]})}>{t('editor.add_line')}</button>
    <button type="button" disabled={invalid} onClick={()=>onEdit({type:'setTrackLyrics',track,visible:draft.visible,lines:draft.lines.map(line=>({...line}))})}>{t('editor.apply_lyrics')}</button>
  </fieldset></details>;
}
