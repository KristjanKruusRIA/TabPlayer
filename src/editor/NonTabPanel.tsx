import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  const [name,setName]=useState('Instrument'),[program,setProgram]=useState(0);
  return <fieldset disabled={busy}><h3>{t('editor.new_notation_track')}</h3><div className="pair"><label>{t('editor.new_notation_track_name')}<input value={name} onChange={e=>setName(e.target.value)}/></label><label>{t('editor.new_notation_track_program')}<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,value)=><option key={value} value={value}>{value+1}. {name}</option>)}</select></label></div><div className="pair"><button onClick={()=>onEdit({type:'addPitchedTrack',name,program})}>{t('editor.add_pitched_track')}</button><button onClick={()=>onEdit({type:'addPercussionTrack',name,program})}>{t('editor.add_percussion_track')}</button></div></fieldset>;
}
export function NonTabPanel({score,target,noteIndex,busy,locked=false,onEdit,onSelectNote}:NonTabPanelProps) {
  const { t } = useI18n();
  const {staff,beat}=describeSelection(score,target),track=staff.track,note=noteIndex===null?undefined:beat?.notes[noteIndex],choices=percussionChoices(track),nonTab=staff.isPercussion||!staff.tuning.length;
  const [pitch,setPitch]=useState('C4'),[articulation,setArticulation]=useState(choices[0]?.id??38),[error,setError]=useState<string|null>(null);
  useEffect(()=>{setPitch(note?.isPiano?formatPitch(note.octave*12+note.tone):'C4');setArticulation(note?.isPercussion?note.percussionArticulation:choices[0]?.id??38);setError(null);},[score,target.track,target.staff,target.bar,target.voice,target.beat,noteIndex,note]);
  const pitched=(update=false)=>{try{const notes=parseTuning(pitch);if(notes.length!==1)throw new Error('Enter one note name with an octave, such as C4.');setError(null);if(update&&noteIndex!==null)onEdit({type:'setPitchedNote',target,noteIndex,pitch:notes[0]});else onEdit({type:'addPitchedNote',target,pitch:notes[0]});}catch(value){setError(value instanceof Error?value.message:String(value));}};
  const noteLabel=(current:model.Note)=>current.isPercussion?choices.find(c=>c.id===current.percussionArticulation)?.label??`Articulation ${current.percussionArticulation}`:formatPitch(current.octave*12+current.tone);
  if(!nonTab)return null;
  return <details open><summary>{t('editor.pitched_percussion_entry')}</summary>
    <fieldset disabled={busy||!beat}><label>{t('editor.chord_note')}<select value={noteIndex??-1} onChange={e=>onSelectNote(Number(e.target.value)<0?null:Number(e.target.value))}><option value={-1}>{t('editor.choose_a_note')}</option>{beat?.notes.map((current,index)=><option key={current.id} value={index}>{index+1}: {noteLabel(current)}</option>)}</select></label>
      <fieldset className="inspector-edit-locked" disabled={locked}>{staff.isPercussion?<><label>{t('editor.percussion_articulation')}<select value={articulation} onChange={e=>setArticulation(Number(e.target.value))}>{choices.map((choice,index)=><option key={`${choice.id}/${index}`} value={choice.id}>{choice.label} — MIDI {choice.outputMidiNumber}</option>)}</select></label><div className="pair"><button disabled={!choices.length} onClick={()=>onEdit({type:'addPercussionNote',target,articulation})}>{t('editor.add_percussion_note')}</button><button disabled={!note} onClick={()=>noteIndex!==null&&onEdit({type:'setPercussionNote',target,noteIndex,articulation})}>{t('editor.update_percussion_note')}</button></div></>:<><label>{t('editor.written_pitch')}<input value={pitch} placeholder="C4" onChange={e=>{setPitch(e.target.value);setError(null);}}/></label><p className="muted">{t('editor.written_pitch_help')}{note?.isPiano?` Written ${formatPitch(note.octave*12+note.tone)}; sounds ${formatPitch(note.realValue)}.`:''}</p><div className="pair"><button onClick={()=>pitched()}>{t('editor.add_pitched_note')}</button><button disabled={!note} onClick={()=>pitched(true)}>{t('editor.update_pitched_note')}</button></div></>}
      <button disabled={!note} onClick={()=>{if(noteIndex!==null){onEdit({type:'removeNoteByIndex',target,noteIndex});onSelectNote(null);}}}>{t('editor.remove_selected_note')}</button>{error&&<p role="alert">{error}</p>}
    </fieldset></fieldset>
  </details>;
}
