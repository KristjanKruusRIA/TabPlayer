import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { TempoPoint } from '../edit-types';
import { describeSelection } from '../engine';
import type { EditorProps } from './TechniquePanel';
import { EnumInput } from './controls';
import { IndexInput } from './IndexInput';

export function MeasurePanel({score,target,busy,onEdit}:EditorProps) {
  const {bar,master}=describeSelection(score,target),reference=score.tracks[0].staves[0].bars[target.bar].voices[0];
  const read=()=>({numerator:master.timeSignatureNumerator,denominator:master.timeSignatureDenominator,pickup:master.isAnacrusis,freeTime:master.isFreeTime,repeatStart:master.isRepeatStart,repeatCount:master.repeatCount,endings:Array.from({length:8},(_,i)=>i+1).filter(n=>master.alternateEndings&(1<<(n-1))),section:master.section?.text??'',tempos:master.tempoAutomations.map(a=>({beat:Math.max(0,reference.beats.findIndex(b=>Math.abs(b.playbackStart-a.ratioPosition*master.calculateDuration(false))<1)),bpm:a.value,linear:a.isLinear}))});
  const [values,setValues]=useState(read),[key,setKey]=useState(Number(bar.keySignature)),[mode,setMode]=useState(Number(bar.keySignatureType)),[clef,setClef]=useState(Number(bar.clef));
  useEffect(()=>{setValues(read());setKey(bar.keySignature);setMode(bar.keySignatureType);setClef(bar.clef);},[score,bar,master]);
  const tempo=(index:number,patch:Partial<TempoPoint>)=>setValues({...values,tempos:values.tempos.map((p,i)=>i===index?{...p,...patch}:p)});
  return <details><summary>Measure & notation</summary><fieldset disabled={busy}>
    <div className="pair"><label>Time numerator<input type="number" min={1} value={values.numerator} onChange={e=>setValues({...values,numerator:Number(e.target.value)})}/></label><label>Time denominator<select value={values.denominator} onChange={e=>setValues({...values,denominator:Number(e.target.value)})}>{[1,2,4,8,16,32,64,128,256].map(n=><option key={n} value={n}>{n}</option>)}</select></label></div>
    <div className="pair"><label className="check"><input type="checkbox" checked={values.pickup} onChange={e=>setValues({...values,pickup:e.target.checked})}/>Pickup measure</label><label className="check"><input type="checkbox" checked={values.freeTime} onChange={e=>setValues({...values,freeTime:e.target.checked})}/>Free time</label></div>
    <label className="check"><input type="checkbox" checked={values.repeatStart} onChange={e=>setValues({...values,repeatStart:e.target.checked})}/>Repeat start</label><label className="check"><input type="checkbox" checked={values.repeatCount>0} onChange={e=>setValues({...values,repeatCount:e.target.checked?2:0})}/>Repeat end</label><label>Repeat count<input type="number" min={2} disabled={!values.repeatCount} value={values.repeatCount||2} onChange={e=>setValues({...values,repeatCount:Number(e.target.value)})}/></label>
    <p>Alternate endings</p><div className="technique-grid">{Array.from({length:8},(_,i)=>i+1).map(n=><label className="check" key={n}><input type="checkbox" checked={values.endings.includes(n)} onChange={e=>setValues({...values,endings:e.target.checked?[...values.endings,n].sort():values.endings.filter(value=>value!==n)})}/>Ending {n}</label>)}</div>
    <label>Section label<input value={values.section} onChange={e=>setValues({...values,section:e.target.value})}/></label><h3>Tempo changes</h3>
    {values.tempos.map((p,index)=><div key={index}><div className="pair"><IndexInput label={`Tempo ${index+1} beat`} value={p.beat+1} min={1} max={Math.max(1,reference.beats.length)} onValue={beat=>tempo(index,{beat:beat-1})}/><label>Tempo {index+1} BPM<input type="number" min={1} value={p.bpm} onChange={e=>tempo(index,{bpm:Number(e.target.value)})}/></label></div><label className="check"><input type="checkbox" checked={p.linear} onChange={e=>tempo(index,{linear:e.target.checked})}/>Tempo {index+1} gradual</label><button aria-label={`Remove tempo ${index+1}`} onClick={()=>setValues({...values,tempos:values.tempos.filter((_,i)=>i!==index)})}>Remove tempo</button></div>)}
    <button onClick={()=>setValues({...values,tempos:[...values.tempos,{beat:Math.min(reference.beats.length-1,(values.tempos.at(-1)?.beat??-1)+1),bpm:score.tempo,linear:false}]})}>Add tempo change</button>
    <button onClick={()=>onEdit({type:'setMeasureSettings',bar:target.bar,...values})}>Apply measure settings</button>
    <h3>Staff bar notation</h3><div className="pair"><label>Key signature<select value={key} onChange={e=>setKey(Number(e.target.value))}>{Array.from({length:15},(_,i)=>i-7).map(n=><option value={n} key={n}>{n===0?'C / A minor':n<0?`${-n} flats`:`${n} sharps`}</option>)}</select></label><EnumInput label="Key mode" value={mode} enumeration={model.KeySignatureType} onValue={setMode}/></div><EnumInput label="Bar clef" value={clef} enumeration={model.Clef} onValue={setClef}/><button onClick={()=>onEdit({type:'setBarNotation',track:target.track,staff:target.staff,bar:target.bar,keySignature:key,keyMode:mode,clef})}>Apply bar notation</button>
  </fieldset></details>;
}
