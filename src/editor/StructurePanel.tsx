import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { StaffSettings } from '../edit-types';
import { describeSelection } from '../engine';
import type { EditorProps } from './TechniquePanel';
import { EnumInput } from './controls';
import { IndexInput } from './IndexInput';
import { formatTuning, parseTuning } from '../tuning';
import { TuningInput } from '../TuningInput';

const readSettings=(staff:model.Staff,clef:number):StaffSettings=>({tuning:[...staff.tuning],capo:staff.capo,transposition:staff.transpositionPitch,displayTransposition:staff.displayTranspositionPitch,clef,showTab:staff.showTablature,showNotation:staff.showStandardNotation});
export function StructurePanel({score,target,busy,onEdit,onSelect}:EditorProps&{onSelect:(target:BeatTarget)=>void}) {
  const {staff,bar}=describeSelection(score,target),track=score.tracks[target.track];
  const [settings,setSettings]=useState(readSettings(staff,bar.clef)),[tuning,setTuning]=useState(formatTuning(staff.tuning)),[tuningError,setTuningError]=useState<string|null>(null),[destination,setDestination]=useState(0),[start,setStart]=useState(1),[end,setEnd]=useState(score.masterBars.length),[barsPerSystem,setBarsPerSystem]=useState(track.defaultSystemsLayout||4),[lineBreaks,setLineBreaks]=useState([...track.lineBreaks??[]].map(n=>n+1).join(','));
  useEffect(()=>{setSettings(readSettings(staff,bar.clef));setTuning(formatTuning(staff.tuning));setTuningError(null);setDestination(target.voice===0&&bar.voices.length>1?1:0);setStart(1);setEnd(score.masterBars.length);setBarsPerSystem(track.defaultSystemsLayout||4);setLineBreaks([...track.lineBreaks??[]].map(n=>n+1).join(','));},[score,staff,bar,track,target.voice]);
  const applyStaff=(add=false)=>{try{const current={...settings,tuning:staff.isPercussion?[...staff.tuning]:parseTuning(tuning)};setTuningError(null);onEdit(add?{type:'addStaff',track:target.track,settings:current}:{type:'setStaffSettings',track:target.track,staff:target.staff,settings:current});}catch(error){setTuningError(error instanceof Error?error.message:String(error));}};
  return <details><summary>Staff, voices & layout</summary><fieldset disabled={busy}><h3>Staff {target.staff+1}</h3>
    <TuningInput label="Staff tuning (notes, high to low)" presetLabel="Staff tuning preset" disabled={staff.isPercussion} placeholder="E4 B3 G3 D3 A2 E2" value={tuning} revision={staff} onChange={notes=>{setTuning(notes);setTuningError(null);}}/>
    <div className="pair"><label>Capo<input type="number" min={0} value={settings.capo} onChange={e=>setSettings({...settings,capo:Number(e.target.value)})}/></label><EnumInput label="Staff clef" value={settings.clef} enumeration={model.Clef} onValue={clef=>setSettings({...settings,clef})}/></div>
    <div className="pair"><label>Sounding transposition<input type="number" value={settings.transposition} onChange={e=>setSettings({...settings,transposition:Number(e.target.value)})}/></label><label>Display transposition<input type="number" value={settings.displayTransposition} onChange={e=>setSettings({...settings,displayTransposition:Number(e.target.value)})}/></label></div>
    <div className="pair"><label className="check"><input type="checkbox" checked={settings.showTab} onChange={e=>setSettings({...settings,showTab:e.target.checked})}/>Show tablature</label><label className="check"><input type="checkbox" checked={settings.showNotation} onChange={e=>setSettings({...settings,showNotation:e.target.checked})}/>Show notation</label></div>
    <button onClick={()=>applyStaff()}>Apply staff settings</button>
    {tuningError&&<p role="alert">{tuningError}</p>}
    <div className="pair"><button disabled={staff.isPercussion} onClick={()=>applyStaff(true)}>Add staff</button><button disabled={track.staves.length===1} onClick={()=>onEdit({type:'removeStaff',track:target.track,staff:target.staff})}>Remove staff</button></div>
    <h3>Voices</h3><div className="pair"><button disabled={bar.voices.length>=4} onClick={()=>onEdit({type:'addVoice',track:target.track,staff:target.staff})}>Add voice</button><button disabled={bar.voices.length===1} onClick={()=>onEdit({type:'removeVoice',track:target.track,staff:target.staff,voice:target.voice})}>Remove voice</button></div>
    <label>Copy selected voice to<select value={destination} onChange={e=>setDestination(Number(e.target.value))}>{bar.voices.map(v=><option value={v.index} key={v.index}>Voice {v.index+1}</option>)}</select></label>
    <div className="pair"><IndexInput label="Copy from measure" value={start} min={1} max={score.masterBars.length} onValue={setStart}/><IndexInput label="Copy through measure" value={end} min={1} max={score.masterBars.length} onValue={setEnd}/></div>
    <button disabled={destination===target.voice} onClick={()=>onEdit({type:'copyVoice',track:target.track,staff:target.staff,sourceVoice:target.voice,destinationVoice:destination,startBar:start-1,endBar:end-1})}>Copy voice range</button>
    <button onClick={()=>onSelect({...target,voice:destination,beat:0})}>Select destination voice</button>
    <h3>Track system layout</h3><label>Bars per system<input type="number" min={1} value={barsPerSystem} onChange={e=>setBarsPerSystem(Number(e.target.value))}/></label><label>Break after measures<input placeholder="e.g. 4,8" value={lineBreaks} onChange={e=>setLineBreaks(e.target.value)}/></label><button onClick={()=>onEdit({type:'setTrackLayout',track:target.track,barsPerSystem,lineBreaks:lineBreaks.trim()?lineBreaks.split(',').map(n=>Number(n)-1):[]})}>Apply system layout</button>
  </fieldset></details>;
}
