import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { EditCommand } from '../edit-types';
import { describeSelection } from '../engine';
import { formatPitch, parseTuning } from '../tuning';
import { percussionChoices } from './percussion-catalog';
import { midiPrograms } from '../midi-programs';
export type NonTabPanelProps={score:model.Score;target:BeatTarget;noteIndex:number|null;busy:boolean;locked?:boolean;onEdit:(command:EditCommand)=>void;onSelectNote:(index:number|null)=>void};
export function NotationTrackControls({busy,onEdit}:{busy:boolean;onEdit:(command:EditCommand)=>void}) {
  const [name,setName]=useState('Instrument'),[program,setProgram]=useState(0);
  return <fieldset disabled={busy}><h3>New notation track</h3><div className="pair"><label>New notation track name<input value={name} onChange={e=>setName(e.target.value)}/></label><label>New notation track program<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,value)=><option key={value} value={value}>{value+1}. {name}</option>)}</select></label></div><div className="pair"><button onClick={()=>onEdit({type:'addPitchedTrack',name,program})}>Add pitched track</button><button onClick={()=>onEdit({type:'addPercussionTrack',name,program})}>Add percussion track</button></div></fieldset>;
}
export function NonTabPanel({score,target,noteIndex,busy,locked=false,onEdit,onSelectNote}:NonTabPanelProps) {
  const {staff,beat}=describeSelection(score,target),track=staff.track,note=noteIndex===null?undefined:beat?.notes[noteIndex],choices=percussionChoices(track),nonTab=staff.isPercussion||!staff.tuning.length;
  const [pitch,setPitch]=useState('C4'),[articulation,setArticulation]=useState(choices[0]?.id??38),[error,setError]=useState<string|null>(null);
  useEffect(()=>{setPitch(note?.isPiano?formatPitch(note.octave*12+note.tone):'C4');setArticulation(note?.isPercussion?note.percussionArticulation:choices[0]?.id??38);setError(null);},[score,target.track,target.staff,target.bar,target.voice,target.beat,noteIndex,note]);
  const pitched=(update=false)=>{try{const notes=parseTuning(pitch);if(notes.length!==1)throw new Error('Enter one note name with an octave, such as C4.');setError(null);if(update&&noteIndex!==null)onEdit({type:'setPitchedNote',target,noteIndex,pitch:notes[0]});else onEdit({type:'addPitchedNote',target,pitch:notes[0]});}catch(value){setError(value instanceof Error?value.message:String(value));}};
  const noteLabel=(current:model.Note)=>current.isPercussion?choices.find(c=>c.id===current.percussionArticulation)?.label??`Articulation ${current.percussionArticulation}`:formatPitch(current.octave*12+current.tone);
  if(!nonTab)return null;
  return <details open><summary>Pitched & percussion entry</summary>
    <fieldset disabled={busy||!beat}><label>Chord note<select value={noteIndex??-1} onChange={e=>onSelectNote(Number(e.target.value)<0?null:Number(e.target.value))}><option value={-1}>Choose a note</option>{beat?.notes.map((current,index)=><option key={current.id} value={index}>{index+1}: {noteLabel(current)}</option>)}</select></label>
      <fieldset className="inspector-edit-locked" disabled={locked}>{staff.isPercussion?<><label>Percussion articulation<select value={articulation} onChange={e=>setArticulation(Number(e.target.value))}>{choices.map((choice,index)=><option key={`${choice.id}/${index}`} value={choice.id}>{choice.label} — MIDI {choice.outputMidiNumber}</option>)}</select></label><div className="pair"><button disabled={!choices.length} onClick={()=>onEdit({type:'addPercussionNote',target,articulation})}>Add percussion note</button><button disabled={!note} onClick={()=>noteIndex!==null&&onEdit({type:'setPercussionNote',target,noteIndex,articulation})}>Update percussion note</button></div></>:<><label>Written pitch<input value={pitch} placeholder="C4" onChange={e=>{setPitch(e.target.value);setError(null);}}/></label><p className="muted">Use a note name and octave, C-1 through G9.{note?.isPiano?` Written ${formatPitch(note.octave*12+note.tone)}; sounds ${formatPitch(note.realValue)}.`:''}</p><div className="pair"><button onClick={()=>pitched()}>Add pitched note</button><button disabled={!note} onClick={()=>pitched(true)}>Update pitched note</button></div></>}
      <button disabled={!note} onClick={()=>{if(noteIndex!==null){onEdit({type:'removeNoteByIndex',target,noteIndex});onSelectNote(null);}}}>Remove selected note</button>{error&&<p role="alert">{error}</p>}
    </fieldset></fieldset>
  </details>;
}
