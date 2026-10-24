import { useEffect, useRef, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../project';
import type { StringCountKeep } from '../edit-types';
import { midiPrograms } from '../midi-programs';
import { formatTuning, parseTuning } from '../tuning';
import { TuningInput } from '../TuningInput';
import { trackIdentity } from '../engine';
import type { TuningAudition } from '../audio/audition';
import { NotationTrackControls } from '../editor/NonTabPanel';
import { trackColorHex } from '../track-color';
import './track-panels.css';

export function TrackSettingsPanel({score,selected,busy,onEdit,onAudition}: {
  score:model.Score;selected:number;busy:boolean;onEdit:(command:EditCommand)=>void;onAudition?:TuningAudition;
}):React.JSX.Element {
  const current=score.tracks[selected];const pitches=formatTuning(current.staves[0].tuning);
  const savedName=current.staves[0].stringTuning.name;
  const [tuning,setTuning]=useState(pitches),[tuningName,setTuningName]=useState(savedName),[tuningError,setTuningError]=useState<string|null>(null);useEffect(()=>{setTuning(pitches);setTuningName(savedName);setTuningError(null);},[score,pitches,savedName,selected]);
  const [trackName,setTrackName]=useState(current.name),[shortName,setShortName]=useState(current.shortName),[program,setProgram]=useState(current.playbackInfo.program);
  const [color,setColor]=useState(trackColorHex(current.color)),[keep,setKeep]=useState<StringCountKeep>('high');useEffect(()=>setKeep('high'),[selected]);
  const strings=current.staves[0].tuning.length,typed=(()=>{try{return parseTuning(tuning).length;}catch{return null;}})(),recount=!!strings&&typed!==null&&typed!==strings;
  useEffect(()=>{setTrackName(current.name);setShortName(current.shortName);setProgram(current.playbackInfo.program);setColor(trackColorHex(current.color));},[score,current]);
  const [name,setName]=useState('Bass');const [instrument,setInstrument]=useState(33);const [newTuning,setNewTuning]=useState('G2 D2 A1 E1');
  const [newTuningName,setNewTuningName]=useState('');
  const [newTuningError,setNewTuningError]=useState<string|null>(null),tuningInput=useRef<HTMLInputElement>(null),newTuningInput=useRef<HTMLInputElement>(null);
  const applyTuning=(add=false)=>{const setError=add?setNewTuningError:setTuningError;try{const notes=parseTuning(add?newTuning:tuning);setError(null);onEdit(add?{type:'addTrack',name,tuning:notes,program:instrument,tuningName:newTuningName}:notes.length!==strings?{type:'setStringCount',track:selected,tuning:notes,keep,tuningName}:{type:'setTuning',track:selected,tuning:notes,tuningName});}catch(error){setError(error instanceof Error?error.message:String(error));const input=(add?newTuningInput:tuningInput).current;input?.focus();input?.closest('.tuning-field')?.scrollIntoView?.({block:'nearest'});}};
  return <aside className="track-settings" aria-label="Track settings"><h2 title={current.name}>{current.name || `Track ${selected+1}`}</h2><fieldset disabled={busy}>
    <button disabled={score.tracks.length===1} onClick={()=>onEdit({type:'removeTrack',track:selected})}>Remove track</button>
    <button disabled={selected===0} onClick={()=>onEdit({type:'moveTrack',track:selected,to:selected-1})}>Move track up</button>
    <button disabled={selected===score.tracks.length-1} onClick={()=>onEdit({type:'moveTrack',track:selected,to:selected+1})}>Move track down</button>
    <button onClick={()=>onEdit({type:'duplicateTrack',track:selected})}>Duplicate track</button>
    <details><summary>Selected instrument</summary><label>Track name<input value={trackName} onChange={e=>setTrackName(e.target.value)}/></label><label>Track short name<input value={shortName} onChange={e=>setShortName(e.target.value)}/></label><label>Track MIDI instrument<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,index)=><option key={index} value={index}>{index+1}. {name}</option>)}</select></label><button onClick={()=>onEdit({type:'setTrackInfo',track:selected,name:trackName,shortName,program})}>Apply instrument settings</button><label>Track color<input type="color" value={color} onChange={e=>setColor(e.target.value)}/></label><button disabled={color===trackColorHex(current.color)} onClick={()=>onEdit({type:'setTrackColor',track:selected,color})}>Apply track color</button></details>
    <TuningInput label="Tuning (notes, high to low)" presetLabel="Tuning preset" disabled={current.isPercussion||!current.staves[0].tuning.length} placeholder="E4 B3 G3 D3 A2 E2" value={tuning} tuningName={tuningName} onTuningNameChange={setTuningName} revision={current} error={tuningError} inputRef={tuningInput} onAudition={onAudition&&((pitches,strum)=>onAudition({trackId:trackIdentity(current)},pitches,strum))} onChange={notes=>{setTuning(notes);setTuningError(null);}}/>
    {recount&&<fieldset className="string-count"><legend>{strings} to {typed} strings</legend>
      <label>Strings kept in place<select value={keep} aria-describedby="string-count-help" onChange={e=>setKeep(e.target.value as StringCountKeep)}><option value="high">High strings (change the low end)</option><option value="low">Low strings (change the high end)</option></select></label>
      <p className="muted" id="string-count-help">Notes keep their pitch. Notes on a removed or unplayable string move to a free string in the same beat; chord diagrams follow the kept strings.</p>
    </fieldset>}
    <button disabled={current.isPercussion||!current.staves[0].tuning.length} onClick={()=>applyTuning()}>{recount?'Change string count':'Apply tuning'}</button>
    <details><summary>Add instrument</summary><label>New track name<input value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>MIDI instrument<select value={instrument} onChange={e=>setInstrument(Number(e.target.value))}>{midiPrograms.map((label,value)=><option key={value} value={value}>{value+1}. {label}</option>)}</select></label>
      <TuningInput label="New track tuning" presetLabel="New track tuning preset" placeholder="G2 D2 A1 E1" value={newTuning} tuningName={newTuningName} onTuningNameChange={setNewTuningName} error={newTuningError} inputRef={newTuningInput} onAudition={onAudition&&((pitches,strum)=>onAudition({program:instrument},pitches,strum))} onChange={notes=>{setNewTuning(notes);setNewTuningError(null);}}/>
      <button onClick={()=>applyTuning(true)}>Add track</button>
    </details>
  </fieldset><NotationTrackControls busy={busy} onEdit={onEdit}/></aside>;
}
