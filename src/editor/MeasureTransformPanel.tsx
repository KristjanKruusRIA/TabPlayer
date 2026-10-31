import { useI18n } from '../i18n';
import { useEffect,useState } from 'react';
import type { MeasureCommand,MeasureTransformPanelProps } from './measures-types';
import { planMeasureMap } from './measures';

export function MeasureTransformPanel({score,bar,busy,onEdit}:MeasureTransformPanelProps) {
  const { t } = useI18n();
  const [count,setCount]=useState('1'),[first,setFirst]=useState(String(bar+1)),[last,setLast]=useState(String(bar+1)),[error,setError]=useState('');
  useEffect(()=>{setCount('1');setFirst(String(bar+1));setLast(String(bar+1));setError('');},[score,bar]);
  const submit=(command:MeasureCommand)=>{
    if(busy)return;
    try {planMeasureMap(score.masterBars.length,command);setError('');onEdit(command);}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  };
  return <details><summary>{t('editor.insert_remove_measures')}</summary><fieldset disabled={busy}>
    <p>{t('editor.measure_n_of',{measure:bar+1,total:score.masterBars.length})}</p>
    <label>{t('editor.measures_to_insert')}<input type="number" min={1} max={1000} step={1} value={count} onChange={event=>setCount(event.target.value)}/></label>
    <div className="pair"><button onClick={()=>submit({type:'insertMeasures',beforeBar:bar,count:count.trim()?Number(count):NaN})}>{t('editor.insert_before')}</button><button onClick={()=>submit({type:'insertMeasures',beforeBar:bar+1,count:count.trim()?Number(count):NaN})}>{t('editor.insert_after')}</button></div>
    <div className="pair"><label>{t('editor.first_measure_to_remove')}<input type="number" min={1} max={score.masterBars.length} step={1} value={first} onChange={event=>setFirst(event.target.value)}/></label><label>{t('editor.last_measure_to_remove')}<input type="number" min={1} max={score.masterBars.length} step={1} value={last} onChange={event=>setLast(event.target.value)}/></label></div>
    <button onClick={()=>submit({type:'removeMeasures',firstBar:first.trim()?Number(first)-1:NaN,lastBar:last.trim()?Number(last)-1:NaN})}>{t('editor.remove_measure_range')}</button>
    {error&&<p role="alert">{error}</p>}
  </fieldset></details>;
}
