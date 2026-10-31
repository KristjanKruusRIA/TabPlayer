import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { StaffSettings } from '../edit-types';
import { describeSelection, trackIdentity } from '../engine';
import type { EditorProps } from './TechniquePanel';
import { EnumInput } from './controls';
import { IndexInput } from './IndexInput';
import { formatTuning, parseTuning } from '../tuning';
import { TuningInput } from '../TuningInput';
import type { TuningAudition } from '../audio/audition';
import { PartialCapoControls } from './PartialCapoControls';
import { BanjoDroneControls } from './BanjoDroneControls';
import { getBanjoDrone } from './banjo-drone';
import { getPartialCapo, noPartialCapo } from './partial-capo';

const readSettings=(staff:model.Staff,clef:number):StaffSettings=>({tuning:[...staff.tuning],capo:staff.capo,transposition:staff.transpositionPitch,displayTransposition:staff.displayTranspositionPitch,clef,showTab:staff.showTablature,showNotation:staff.showStandardNotation});
export function StructurePanel({score,target,busy,locked=false,onEdit,onSelect,onAudition}:EditorProps&{onSelect:(target:BeatTarget)=>void;onAudition?:TuningAudition;/** Finalized: edits are disabled, tuning audition is not. */locked?:boolean}) {
  const {staff,bar}=describeSelection(score,target),track=score.tracks[target.track];
  const [settings,setSettings]=useState(readSettings(staff,bar.clef)),[tuning,setTuning]=useState(formatTuning(staff.tuning)),[tuningName,setTuningName]=useState(staff.stringTuning.name),[tuningError,setTuningError]=useState<string|null>(null),[destination,setDestination]=useState(0),[start,setStart]=useState(1),[end,setEnd]=useState(score.masterBars.length),[barsPerSystem,setBarsPerSystem]=useState(track.defaultSystemsLayout||4),[lineBreaks,setLineBreaks]=useState([...track.lineBreaks??[]].map(n=>n+1).join(','));
  const [partialInvalid,setPartialInvalid]=useState(false),[droneInvalid,setDroneInvalid]=useState(false),[controlsReset,setControlsReset]=useState(0);
  useEffect(()=>{setSettings(readSettings(staff,bar.clef));setPartialInvalid(false);setDroneInvalid(false);setControlsReset(count=>count+1);setTuning(formatTuning(staff.tuning));setTuningName(staff.stringTuning.name);setTuningError(null);setDestination(target.voice===0&&bar.voices.length>1?1:0);setStart(1);setEnd(score.masterBars.length);setBarsPerSystem(track.defaultSystemsLayout||4);setLineBreaks([...track.lineBreaks??[]].map(n=>n+1).join(','));},[score,staff,bar,track,target.voice]);
  const applyStaff=(add=false)=>{if(busy||locked||partialInvalid||droneInvalid)return;try{const editable=!staff.isPercussion&&!!staff.tuning.length,current={...settings,tuning:editable?parseTuning(tuning):[...staff.tuning],...(editable?{tuningName}:{})};setTuningError(null);onEdit(add?{type:'addStaff',track:target.track,settings:current}:{type:'setStaffSettings',track:target.track,staff:target.staff,settings:current});}catch(error){setTuningError(error instanceof Error?error.message:String(error));}};
  return <details><summary>Staff, voices & layout</summary><h3>Staff {target.staff+1}</h3>
    <TuningInput label="Staff tuning (notes, high to low)" presetLabel="Staff tuning preset" busy={busy} disabled={locked||staff.isPercussion||!staff.tuning.length} stringCount={staff.tuning.length} placeholder="E4 B3 G3 D3 A2 E2" value={tuning} tuningName={tuningName} onTuningNameChange={setTuningName} revision={staff} onAudition={onAudition&&((pitches,strum)=>onAudition({trackId:trackIdentity(track)},pitches,strum))} onChange={notes=>{setTuning(notes);setTuningError(null);}} onCommit={(notes,changed)=>{if(locked||staff.isPercussion||!staff.tuning.length)return;if(partialInvalid||droneInvalid){setTuningError(partialInvalid?'Fix the partial capo before tuning strings.':'Fix the banjo drone before tuning strings.');setTuning(formatTuning(staff.tuning));return;}const nextTuning=staff.tuning.map((p,i)=>changed.includes(i)?notes[i]:p);const same=nextTuning.length===staff.tuning.length&&nextTuning.every((p,i)=>p===staff.tuning[i]);if(same)return;setTuningError(null);setTuning(formatTuning(nextTuning));const saved=readSettings(staff,bar.clef);onEdit({type:'setStaffSettings',track:target.track,staff:target.staff,settings:{...saved,tuning:nextTuning,tuningName:''}});}}/>
    <fieldset disabled={busy}>
    <div className="pair"><label>Capo<input type="number" min={0} disabled={staff.isPercussion||!staff.tuning.length} value={settings.capo} onChange={e=>setSettings({...settings,capo:Number(e.target.value)})}/></label><EnumInput label="Staff clef" value={settings.clef} enumeration={model.Clef} onValue={clef=>setSettings({...settings,clef})}/></div>
    <PartialCapoControls key={JSON.stringify([controlsReset,target.track,target.staff,staff.tuning,getPartialCapo(staff)])} onInvalid={setPartialInvalid} staff={staff} value={settings.partialCapo??getPartialCapo(staff)??noPartialCapo} onChange={partialCapo=>setSettings({...settings,partialCapo})}/>
    <BanjoDroneControls key={JSON.stringify([controlsReset,target.track,target.staff,staff.tuning.length,getBanjoDrone(staff)])} onInvalid={setDroneInvalid} staff={staff} value={settings.droneFret??getBanjoDrone(staff)} onChange={droneFret=>setSettings({...settings,droneFret})}/>
    <div className="pair"><label>Sounding transposition<input type="number" value={settings.transposition} onChange={e=>setSettings({...settings,transposition:Number(e.target.value)})}/></label><label>Display transposition<input type="number" value={settings.displayTransposition} onChange={e=>setSettings({...settings,displayTransposition:Number(e.target.value)})}/></label></div>
    <div className="pair"><label className="check"><input type="checkbox" disabled={!staff.isPercussion&&!staff.tuning.length} checked={settings.showTab} onChange={e=>setSettings({...settings,showTab:e.target.checked})}/>Show tablature</label><label className="check"><input type="checkbox" checked={settings.showNotation} onChange={e=>setSettings({...settings,showNotation:e.target.checked})}/>Show notation</label></div>
    <button disabled={locked||partialInvalid||droneInvalid} onClick={()=>applyStaff()}>Apply staff settings</button>
    {tuningError&&<p role="alert">{tuningError}</p>}
    <div className="pair"><button disabled={locked||partialInvalid||droneInvalid||staff.isPercussion} onClick={()=>applyStaff(true)}>Add staff</button><button disabled={locked||track.staves.length===1} onClick={()=>onEdit({type:'removeStaff',track:target.track,staff:target.staff})}>Remove staff</button></div>
    <h3>Voices</h3><div className="pair"><button disabled={locked||bar.voices.length>=4} onClick={()=>{if(busy||locked)return;onEdit({type:'addVoice',track:target.track,staff:target.staff});}}>Add voice</button><button disabled={locked||bar.voices.length===1} onClick={()=>onEdit({type:'removeVoice',track:target.track,staff:target.staff,voice:target.voice})}>Remove voice</button></div>
    <label>Copy selected voice to<select value={destination} onChange={e=>setDestination(Number(e.target.value))}>{bar.voices.map(v=><option value={v.index} key={v.index}>Voice {v.index+1}</option>)}</select></label>
    <div className="pair"><IndexInput label="Copy from measure" value={start} min={1} max={score.masterBars.length} onValue={setStart}/><IndexInput label="Copy through measure" value={end} min={1} max={score.masterBars.length} onValue={setEnd}/></div>
    <button disabled={locked||destination===target.voice} onClick={()=>onEdit({type:'copyVoice',track:target.track,staff:target.staff,sourceVoice:target.voice,destinationVoice:destination,startBar:start-1,endBar:end-1})}>Copy voice range</button>
    <button onClick={()=>onSelect({...target,voice:destination,beat:0})}>Select destination voice</button>
    <h3>Track system layout</h3><label>Bars per system<input type="number" min={1} value={barsPerSystem} onChange={e=>setBarsPerSystem(Number(e.target.value))}/></label><label>Break after measures<input placeholder="e.g. 4,8" value={lineBreaks} onChange={e=>setLineBreaks(e.target.value)}/></label><button disabled={locked} onClick={()=>onEdit({type:'setTrackLayout',track:target.track,barsPerSystem,lineBreaks:lineBreaks.trim()?lineBreaks.split(',').map(n=>Number(n)-1):[]})}>Apply system layout</button>
  </fieldset></details>;
}
