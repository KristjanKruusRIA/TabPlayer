import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { BeatTarget } from '../project';
import { describeSelection } from '../engine';
import type { EditorProps } from './TechniquePanel';
import { IndexInput } from './IndexInput';

/**
 * Voices and the track's system layout. The staff's own settings (tuning, capo, clef, transposition, which notations show,
 * adding and removing a staff) live in the Track tab's Musical notation section and the Tuning dialog.
 */
export function StructurePanel({score,target,busy,locked=false,onEdit,onSelect}:EditorProps&{onSelect:(target:BeatTarget)=>void;/** Finalized: edits are disabled. */locked?:boolean}) {
  const { t } = useI18n();
  const {bar}=describeSelection(score,target),track=score.tracks[target.track];
  const [destination,setDestination]=useState(0),[start,setStart]=useState(1),[end,setEnd]=useState(score.masterBars.length),[barsPerSystem,setBarsPerSystem]=useState(track.defaultSystemsLayout||4),[lineBreaks,setLineBreaks]=useState([...track.lineBreaks??[]].map(n=>n+1).join(','));
  useEffect(()=>{setDestination(target.voice===0&&bar.voices.length>1?1:0);setStart(1);setEnd(score.masterBars.length);setBarsPerSystem(track.defaultSystemsLayout||4);setLineBreaks([...track.lineBreaks??[]].map(n=>n+1).join(','));},[score,bar,track,target.voice]);
  return <details><summary>{t('editor.staff_voices_layout')}</summary>
    <fieldset disabled={busy}>
    <h3>{t('editor.voices')}</h3><div className="pair"><button disabled={locked||bar.voices.length>=4} onClick={()=>{if(busy||locked)return;onEdit({type:'addVoice',track:target.track,staff:target.staff});}}>{t('editor.add_voice')}</button><button disabled={locked||bar.voices.length===1} onClick={()=>onEdit({type:'removeVoice',track:target.track,staff:target.staff,voice:target.voice})}>{t('editor.remove_voice')}</button></div>
    <label>{t('editor.copy_selected_voice_to')}<select value={destination} onChange={e=>setDestination(Number(e.target.value))}>{bar.voices.map(v=><option value={v.index} key={v.index}>{t('editor.voice_n',{voice:v.index+1})}</option>)}</select></label>
    <div className="pair"><IndexInput label={t('editor.copy_from_measure')} value={start} min={1} max={score.masterBars.length} onValue={setStart}/><IndexInput label={t('editor.copy_through_measure')} value={end} min={1} max={score.masterBars.length} onValue={setEnd}/></div>
    <button disabled={locked||destination===target.voice} onClick={()=>onEdit({type:'copyVoice',track:target.track,staff:target.staff,sourceVoice:target.voice,destinationVoice:destination,startBar:start-1,endBar:end-1})}>{t('editor.copy_voice_range')}</button>
    <button onClick={()=>onSelect({...target,voice:destination,beat:0})}>{t('editor.select_destination_voice')}</button>
    <h3>{t('editor.track_system_layout')}</h3><label>{t('editor.bars_per_system')}<input type="number" min={1} value={barsPerSystem} onChange={e=>setBarsPerSystem(Number(e.target.value))}/></label><label>{t('editor.break_after_measures')}<input placeholder="e.g. 4,8" value={lineBreaks} onChange={e=>setLineBreaks(e.target.value)}/></label><button disabled={locked} onClick={()=>onEdit({type:'setTrackLayout',track:target.track,barsPerSystem,lineBreaks:lineBreaks.trim()?lineBreaks.split(',').map(n=>Number(n)-1):[]})}>{t('editor.apply_system_layout')}</button>
  </fieldset></details>;
}
