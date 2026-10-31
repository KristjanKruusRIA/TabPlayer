import { useI18n } from '../i18n';
import { useEffect,useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { BarGestureCommand } from './gestures-types';

export interface BarGesturePanelProps {
  score:model.Score; track:number; staff:number; bar:number; busy:boolean;
  onEdit:(command:BarGestureCommand)=>void;
}
const octaves=['15ma · two octaves up','8va · octave up','Regular','8vb · octave down','15mb · two octaves down'];
const feels=['Straight','Triplet sixteenths','Triplet eighths','Dotted sixteenths','Dotted eighths','Scottish sixteenths','Scottish eighths'];
type SimileKind=Extract<BarGestureCommand,{type:'setSimile'}>['kind'];

export function BarGesturePanel({score,track,staff,bar,busy,onEdit}:BarGesturePanelProps) {
  const { t } = useI18n();
  const selected=score.tracks[track].staves[staff].bars[bar],master=score.masterBars[bar];
  const read=()=>{
    const rule=master.beamingRules?.groups.entries().next().value;
    return {clefOttava:Number(selected.clefOttava),simile:(selected.simileMark===1?'single':selected.simileMark>=2?'double':'none') as SimileKind,commonTime:master.timeSignatureCommon,doubleBar:master.isDoubleBar,tripletFeel:Number(master.tripletFeel),custom:!!rule,unit:rule?.[0]??8,groups:rule?.[1].join(', ')??''};
  };
  const [values,setValues]=useState(read),[error,setError]=useState('');
  useEffect(()=>{setValues(read());setError('');},[score,track,staff,bar]);
  const commonMeter=(master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4)||(master.timeSignatureNumerator===2&&master.timeSignatureDenominator===2);
  const applyMaster=()=>{
    const groups=values.groups.trim()?values.groups.trim().split(/[,\s]+/).map(Number):[],total=master.timeSignatureNumerator*values.unit/master.timeSignatureDenominator;
    if(values.custom&&(!groups.length||groups.some(value=>!Number.isSafeInteger(value)||value<=0)||groups.reduce((sum,value)=>sum+value,0)!==total)) {
      setError(`Use positive whole numbers adding up to ${total} for this measure.`);return;
    }
    setError('');onEdit({type:'setMasterBarGestures',bar,commonTime:values.commonTime,doubleBar:values.doubleBar,tripletFeel:values.tripletFeel,beaming:values.custom?{unit:values.unit,groups}:null});
  };
  return <details><summary>{t('editor.bar_gestures')}</summary><fieldset disabled={busy}>
    <p>Measure {bar+1}</p>
    <label>{t('editor.clef_octave')}<select value={values.clefOttava} onChange={e=>setValues({...values,clefOttava:Number(e.target.value)})}>{octaves.map((name,value)=><option key={value} value={value}>{name}</option>)}</select></label>
    <button onClick={()=>onEdit({type:'setBarGestures',track,staff,bar,clefOttava:values.clefOttava})}>{t('editor.apply_clef_octave')}</button>
    <label>{t('editor.simile')}<select value={values.simile} onChange={e=>setValues({...values,simile:e.target.value as SimileKind})}><option value="none">{t('editor.simile_none')}</option><option value="single">{t('editor.simile_single')}</option><option value="double">{t('editor.simile_double')}</option></select></label>
    <button onClick={()=>onEdit({type:'setSimile',track,staff,bar,kind:values.simile})}>{t('editor.apply_simile')}</button>
    <label className="check"><input type="checkbox" checked={values.commonTime} disabled={!commonMeter&&!values.commonTime} onChange={e=>setValues({...values,commonTime:e.target.checked})}/>{t('editor.common_cut_time')}</label>
    {!commonMeter&&<p>{t('editor.common_cut_hint')}</p>}
    <label className="check"><input type="checkbox" checked={values.doubleBar} onChange={e=>setValues({...values,doubleBar:e.target.checked})}/>{t('editor.double_bar')}</label>
    <label>{t('editor.rhythmic_feel')}<select value={values.tripletFeel} onChange={e=>setValues({...values,tripletFeel:Number(e.target.value)})}>{feels.map((name,value)=><option key={value} value={value}>{name}</option>)}</select></label>
    <label className="check"><input type="checkbox" checked={values.custom} onChange={e=>setValues({...values,custom:e.target.checked})}/>{t('editor.custom_beaming')}</label>
    <label>{t('editor.beaming_unit')}<select disabled={!values.custom} value={values.unit} onChange={e=>setValues({...values,unit:Number(e.target.value)})}>{([[8,t('editor.beaming_eighths')],[16,t('editor.beaming_sixteenths')],[32,t('editor.beaming_thirty_seconds')]] as const).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>
    <label>{t('editor.beaming_groups')}<input disabled={!values.custom} value={values.groups} placeholder="2, 2, 3" onChange={e=>setValues({...values,groups:e.target.value})}/></label>
    {error&&<p role="alert">{error}</p>}
    <button onClick={applyMaster}>{t('editor.apply_measure_gestures')}</button>
  </fieldset></details>;
}
