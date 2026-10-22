import { useEffect, useRef, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../project';
import { midiPrograms } from '../midi-programs';
import { formatTuning, parseTuning } from '../tuning';
import { TuningInput } from '../TuningInput';
import { NotationTrackControls } from '../editor/NonTabPanel';
import './track-panels.css';

export function TrackSettingsPanel({score,selected,busy,onEdit}: {
  score:model.Score;selected:number;busy:boolean;onEdit:(command:EditCommand)=>void;
}):React.JSX.Element {
  const current=score.tracks[selected];const pitches=formatTuning(current.staves[0].tuning);
  const [tuning,setTuning]=useState(pitches),[tuningError,setTuningError]=useState<string|null>(null);useEffect(()=>{setTuning(pitches);setTuningError(null);},[score,pitches,selected]);
  const [trackName,setTrackName]=useState(current.name),[shortName,setShortName]=useState(current.shortName),[program,setProgram]=useState(current.playbackInfo.program);
  useEffect(()=>{setTrackName(current.name);setShortName(current.shortName);setProgram(current.playbackInfo.program);},[score,current]);
  const [name,setName]=useState('Bass');const [instrument,setInstrument]=useState(33);const [newTuning,setNewTuning]=useState('G2 D2 A1 E1');
  const [newTuningError,setNewTuningError]=useState<string|null>(null),tuningInput=useRef<HTMLInputElement>(null),newTuningInput=useRef<HTMLInputElement>(null);
  const applyTuning=(add=false)=>{const setError=add?setNewTuningError:setTuningError;try{const notes=parseTuning(add?newTuning:tuning);setError(null);onEdit(add?{type:'addTrack',name,tuning:notes,program:instrument}:{type:'setTuning',track:selected,tuning:notes});}catch(error){setError(error instanceof Error?error.message:String(error));const input=(add?newTuningInput:tuningInput).current;input?.focus();input?.closest('.tuning-field')?.scrollIntoView?.({block:'nearest'});}};
  return <aside className="track-settings" aria-label="Track settings"><h2 title={current.name}>{current.name || `Track ${selected+1}`}</h2><fieldset disabled={busy}>
    <button disabled={score.tracks.length===1} onClick={()=>onEdit({type:'removeTrack',track:selected})}>Remove track</button>
    <button disabled={selected===0} onClick={()=>onEdit({type:'moveTrack',track:selected,to:selected-1})}>Move track up</button>
    <button disabled={selected===score.tracks.length-1} onClick={()=>onEdit({type:'moveTrack',track:selected,to:selected+1})}>Move track down</button>
    <button onClick={()=>onEdit({type:'duplicateTrack',track:selected})}>Duplicate track</button>
    <details><summary>Selected instrument</summary><label>Track name<input value={trackName} onChange={e=>setTrackName(e.target.value)}/></label><label>Track short name<input value={shortName} onChange={e=>setShortName(e.target.value)}/></label><label>Track MIDI instrument<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,index)=><option key={index} value={index}>{index+1}. {name}</option>)}</select></label><button onClick={()=>onEdit({type:'setTrackInfo',track:selected,name:trackName,shortName,program})}>Apply instrument settings</button></details>
    <TuningInput label="Tuning (notes, high to low)" presetLabel="Tuning preset" disabled={current.isPercussion||!current.staves[0].tuning.length} placeholder="E4 B3 G3 D3 A2 E2" value={tuning} revision={current} error={tuningError} inputRef={tuningInput} onChange={notes=>{setTuning(notes);setTuningError(null);}}/>
    <button disabled={current.isPercussion||!current.staves[0].tuning.length} onClick={()=>applyTuning()}>Apply tuning</button>
    <details><summary>Add instrument</summary><label>New track name<input value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>MIDI instrument<select value={instrument} onChange={e=>setInstrument(Number(e.target.value))}>{midiPrograms.map((label,value)=><option key={value} value={value}>{value+1}. {label}</option>)}</select></label>
      <TuningInput label="New track tuning" presetLabel="New track tuning preset" placeholder="G2 D2 A1 E1" value={newTuning} error={newTuningError} inputRef={newTuningInput} onChange={notes=>{setNewTuning(notes);setNewTuningError(null);}}/>
      <button onClick={()=>applyTuning(true)}>Add track</button>
    </details>
  </fieldset><NotationTrackControls busy={busy} onEdit={onEdit}/></aside>;
}
