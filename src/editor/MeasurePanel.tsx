import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { TempoPoint } from '../edit-types';
import { describeSelection } from '../engine';
import type { EditorProps } from './TechniquePanel';
import { EnumInput } from './controls';
import { IndexInput } from './IndexInput';
import { readMeasureSettings } from './measure-settings';

export function MeasurePanel({score,target,busy,onEdit}:EditorProps) {
  const { t } = useI18n();
  const {bar,master}=describeSelection(score,target),reference=score.tracks[0].staves[0].bars[target.bar].voices[0];
  const read=()=>readMeasureSettings(score,target.bar);
  const [values,setValues]=useState(read),[key,setKey]=useState(Number(bar.keySignature)),[mode,setMode]=useState(Number(bar.keySignatureType)),[clef,setClef]=useState(Number(bar.clef));
  useEffect(()=>{setValues(read());setKey(bar.keySignature);setMode(bar.keySignatureType);setClef(bar.clef);},[score,bar,master]);
  const tempo=(index:number,patch:Partial<TempoPoint>)=>setValues({...values,tempos:values.tempos.map((p,i)=>i===index?{...p,...patch}:p)});
  return <details><summary>{t('editor.measure_and_notation')}</summary><fieldset disabled={busy}>
    <div className="pair"><label>{t('editor.time_numerator')}<input type="number" min={1} value={values.numerator} onChange={e=>setValues({...values,numerator:Number(e.target.value)})}/></label><label>{t('editor.time_denominator')}<select value={values.denominator} onChange={e=>setValues({...values,denominator:Number(e.target.value)})}>{[1,2,4,8,16,32,64,128,256].map(n=><option key={n} value={n}>{n}</option>)}</select></label></div>
    <div className="pair"><label className="check"><input type="checkbox" checked={values.pickup} onChange={e=>setValues({...values,pickup:e.target.checked})}/>{t('editor.pickup_measure')}</label><label className="check"><input type="checkbox" checked={values.freeTime} onChange={e=>setValues({...values,freeTime:e.target.checked})}/>{t('editor.free_time')}</label></div>
    <label className="check"><input type="checkbox" checked={values.repeatStart} onChange={e=>setValues({...values,repeatStart:e.target.checked})}/>{t('editor.repeat_start')}</label><label className="check"><input type="checkbox" checked={values.repeatCount>0} onChange={e=>setValues({...values,repeatCount:e.target.checked?2:0})}/>{t('editor.repeat_end')}</label><label>{t('editor.repeat_count')}<input type="number" min={2} disabled={!values.repeatCount} value={values.repeatCount||2} onChange={e=>setValues({...values,repeatCount:Number(e.target.value)})}/></label>
    <p>{t('editor.alternate_endings')}</p><div className="technique-grid">{Array.from({length:8},(_,i)=>i+1).map(n=><label className="check" key={n}><input type="checkbox" checked={values.endings.includes(n)} onChange={e=>setValues({...values,endings:e.target.checked?[...values.endings,n].sort():values.endings.filter(value=>value!==n)})}/>{t('editor.ending_n', { number: n })}</label>)}</div>
    <label>{t('editor.section_label')}<input value={values.section} onChange={e=>setValues({...values,section:e.target.value})}/></label><h3>{t('editor.tempo_changes')}</h3>
    {values.tempos.map((p,index)=><div key={index}><div className="pair"><IndexInput label={t('editor.tempo_beat', { index: index+1 })} value={p.beat+1} min={1} max={Math.max(1,reference.beats.length)} onValue={beat=>tempo(index,{beat:beat-1})}/><label>{t('editor.tempo_bpm', { index: index+1 })}<input type="number" min={1} value={p.bpm} onChange={e=>tempo(index,{bpm:Number(e.target.value)})}/></label></div><label className="check"><input type="checkbox" checked={p.linear} onChange={e=>tempo(index,{linear:e.target.checked})}/>{t('editor.tempo_gradual', { index: index+1 })}</label><button aria-label={t('editor.remove_tempo_n', { index: index+1 })} onClick={()=>setValues({...values,tempos:values.tempos.filter((_,i)=>i!==index)})}>{t('editor.remove_tempo')}</button></div>)}
    <button onClick={()=>setValues({...values,tempos:[...values.tempos,{beat:Math.min(reference.beats.length-1,(values.tempos.at(-1)?.beat??-1)+1),bpm:score.tempo,linear:false}]})}>{t('editor.add_tempo_change')}</button>
    <button onClick={()=>onEdit({type:'setMeasureSettings',bar:target.bar,...values})}>{t('editor.apply_measure_settings')}</button>
    <h3>{t('editor.staff_bar_notation')}</h3><div className="pair"><label>{t('editor.key_signature')}<select value={key} onChange={e=>setKey(Number(e.target.value))}>{Array.from({length:15},(_,i)=>i-7).map(n=><option value={n} key={n}>{n===0?t('editor.key_natural'):n<0?t('editor.key_flats',{count:-n}):t('editor.key_sharps',{count:n})}</option>)}</select></label><EnumInput label={t('editor.key_mode')} value={mode} enumeration={model.KeySignatureType} onValue={setMode}/></div><EnumInput label={t('editor.bar_clef')} value={clef} enumeration={model.Clef} onValue={setClef}/><button onClick={()=>onEdit({type:'setBarNotation',track:target.track,staff:target.staff,bar:target.bar,keySignature:key,keyMode:mode,clef})}>{t('editor.apply_bar_notation')}</button>
  </fieldset></details>;
}
