import { useEffect,useState } from 'react';
import type { LyricsPanelProps } from './lyrics-types';
import { getTrackLyrics } from './lyrics';

export function LyricsPanel({score,track,busy,onEdit}:LyricsPanelProps) {
  const [draft,setDraft]=useState(()=>getTrackLyrics(score,track));
  useEffect(()=>{setDraft(getTrackLyrics(score,track));},[score,track]);
  const invalid=draft.lines.some(line=>!Number.isInteger(line.startBar)||line.startBar<0||line.startBar>=score.masterBars.length);
  return <details><summary>Lyrics</summary><fieldset disabled={busy}>
    <p>{score.tracks[track].name}</p>
    <label>Visible<input type="checkbox" checked={draft.visible} onChange={e=>setDraft({...draft,visible:e.target.checked})}/></label>
    {draft.source==='distributed'&&<p>Reconstructed from displayed syllables</p>}
    <p>Spaces split syllables; hyphens continue a word; + joins words; [brackets] mark comments. Extra spaces leave blank beats.</p>
    {draft.lines.map((line,index)=><fieldset key={index}><legend>Line {index+1}</legend>
      <label>Line {index+1} start measure<input type="number" min={1} max={score.masterBars.length} step={1} value={line.startBar+1} onChange={e=>setDraft({...draft,lines:draft.lines.map((value,i)=>i===index?{...value,startBar:Number(e.target.value)-1}:value)})}/></label>
      <label>Line {index+1} text<textarea value={line.text} onChange={e=>setDraft({...draft,lines:draft.lines.map((value,i)=>i===index?{...value,text:e.target.value}:value)})}/></label>
      <button type="button" aria-label={`Remove line ${index+1}`} onClick={()=>setDraft({...draft,lines:draft.lines.filter((_,i)=>i!==index)})}>Remove line</button>
    </fieldset>)}
    <button type="button" disabled={draft.lines.length>=5} onClick={()=>setDraft({...draft,lines:[...draft.lines,{startBar:0,text:''}]})}>Add line</button>
    <button type="button" disabled={invalid} onClick={()=>onEdit({type:'setTrackLyrics',track,visible:draft.visible,lines:draft.lines.map(line=>({...line}))})}>Apply lyrics</button>
  </fieldset></details>;
}
