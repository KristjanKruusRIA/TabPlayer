import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from '../project';
import { midiPrograms } from '../midi-programs';
import { formatTuning, parseTuning } from '../tuning';
import { TuningRow } from '../tuning/TuningRow';
import { TuningDialog, type TuningChoice } from '../tuning/TuningDialog';
import { busyGuard } from '../ui/useBusyGuard';
import { ArrowDownGlyph, ArrowUpGlyph, DuplicateGlyph, TrashGlyph } from '../shell/glyphs';
import { trackIdentity } from '../engine';
import type { TuningAudition } from '../audio/audition';
import { NotationTrackControls } from '../editor/NonTabPanel';
import { trackColorHex } from '../track-color';
import './track-panels.css';

export function TrackSettingsPanel({score,selected,busy,locked=false,refusal=null,onEdit,onAudition}: {
  score:model.Score;selected:number;busy:boolean;/** Finalized: edits are disabled, but tuning audition is not. */locked?:boolean;/** The app's message for the edit it last refused, shown in the Tuning dialog. */refusal?:string|null;onEdit:(command:EditCommand)=>unknown;onAudition?:TuningAudition;
}):React.JSX.Element {
  const { t } = useI18n();
  const current=score.tracks[selected];const pitches=formatTuning(current.staves[0].tuning);
  const savedName=current.staves[0].stringTuning.name;
  // The dialog belongs to the track it was opened for, by identity: moving or removing tracks while it is open must not retarget it.
  const [tuningFor,setTuningFor]=useState<string|null>(null);
  const dialogIndex=tuningFor===null?-1:score.tracks.findIndex(track=>trackIdentity(track)===tuningFor),dialogTrack=dialogIndex>=0?score.tracks[dialogIndex]:null;
  useEffect(()=>{if(tuningFor!==null&&dialogIndex<0)setTuningFor(null);},[tuningFor,dialogIndex]);
  const [trackName,setTrackName]=useState(current.name),[shortName,setShortName]=useState(current.shortName),[program,setProgram]=useState(current.playbackInfo.program);
  const [color,setColor]=useState(trackColorHex(current.color));
  const strings=current.staves[0].tuning.length;
  useEffect(()=>{setTrackName(current.name);setShortName(current.shortName);setProgram(current.playbackInfo.program);setColor(trackColorHex(current.color));},[score,current]);
  const [name,setName]=useState('Bass');const [instrument,setInstrument]=useState(33);const [newTuning,setNewTuning]=useState('G2 D2 A1 E1');
  const [newTuningName,setNewTuningName]=useState(''),[newTuningOpen,setNewTuningOpen]=useState(false);
  const applyNewTrack=()=>{if(locked)return;onEdit({type:'addTrack',name,tuning:parseTuning(newTuning),program:instrument,tuningName:newTuningName});};
  /** Records nothing when the tuning, its name and the string count are the ones the track already has. Targets the track the dialog was opened for, and does nothing if that track is gone. */
  const applyTuning=({pitches:notes,name:tuningName,keepPitch,keep}:TuningChoice)=>{if(locked||!dialogTrack||dialogIndex<0)return;const count=dialogTrack.staves[0].tuning.length;if(notes.length===count&&dialogTrack.staves.every(staff=>staff.tuning.every((pitch,index)=>pitch===notes[index])&&staff.stringTuning.name===tuningName))return;return onEdit(notes.length!==count?{type:'setStringCount',track:dialogIndex,tuning:notes,keep,tuningName,crossVoice:true}:{type:'setTuning',track:dialogIndex,tuning:notes,tuningName,...(keepPitch?{keepPitch:true}:{})});};
  const tuningUnavailable=current.isPercussion||!strings;
  const audition=(list:number[],strum:boolean)=>onAudition?.({trackId:trackIdentity(current)},list,strum);
  const action=(label:string,glyph:React.JSX.Element,disabled:boolean,onClick:()=>void,className?:string)=><button type="button" title={label} aria-label={label} {...busyGuard({busy,disabled,className,onClick})}>{glyph}</button>;
  return <aside className="track-settings" aria-label={t('track_settings.aria_label')}><h2 title={current.name}>{current.name || `Track ${selected+1}`}</h2>
    <div className="track-actions" role="group" aria-label={t('track_settings.track_actions')}>
      {action(t('track_settings.move_track_up'),<ArrowUpGlyph/>,locked||selected===0,()=>onEdit({type:'moveTrack',track:selected,to:selected-1}))}
      {action(t('track_settings.move_track_down'),<ArrowDownGlyph/>,locked||selected===score.tracks.length-1,()=>onEdit({type:'moveTrack',track:selected,to:selected+1}))}
      {action(t('track_settings.duplicate_track'),<DuplicateGlyph/>,locked,()=>onEdit({type:'duplicateTrack',track:selected}))}
      <span className="track-actions-gap" aria-hidden="true"/>
      {action(t('track_settings.remove_track'),<TrashGlyph/>,locked||score.tracks.length===1,()=>onEdit({type:'removeTrack',track:selected}),'track-remove')}
    </div>
    <fieldset disabled={busy}>
      <details><summary>{t('track_settings.selected_instrument')}</summary><label>{t('track_settings.track_name')}<input value={trackName} onChange={e=>setTrackName(e.target.value)}/></label><label>{t('track_settings.track_short_name')}<input value={shortName} onChange={e=>setShortName(e.target.value)}/></label>{!current.isPercussion&&<label>{t('track_settings.track_midi_instrument')}<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,index)=><option key={index} value={index}>{index+1}. {name}</option>)}</select></label>}<button disabled={locked} onClick={()=>onEdit({type:'setTrackInfo',track:selected,name:trackName,shortName,program})}>{t('track_settings.apply_instrument_settings')}</button><label>{t('track_settings.track_color')}<input type="color" value={color} onChange={e=>setColor(e.target.value)}/></label><button disabled={locked||color===trackColorHex(current.color)} onClick={()=>onEdit({type:'setTrackColor',track:selected,color})}>{t('track_settings.apply_track_color')}</button></details>
    </fieldset>
    <TuningRow label={t('track_settings.tuning_row')} notes={pitches} title={savedName?`${savedName}: ${pitches}`:pitches} unavailable={tuningUnavailable} busy={busy} locked={locked} onOpen={()=>setTuningFor(trackIdentity(current))} onPlay={onAudition&&(()=>audition([...current.staves[0].tuning],true))} playDisabled={strings>12}/>
    {dialogTrack&&<TuningDialog pitches={dialogTrack.staves[0].tuning} name={dialogTrack.staves[0].stringTuning.name} busy={busy} locked={locked} refusal={refusal} onApply={applyTuning} onClose={()=>setTuningFor(null)} onAudition={onAudition&&((list,strum)=>onAudition({trackId:trackIdentity(dialogTrack)},list,strum))}/>}
    <fieldset disabled={busy}>
      <details className="track-add"><summary>{t('track_settings.add_instrument')}</summary><label>{t('track_settings.new_track_name')}<input value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>{t('track_settings.midi_instrument')}<select value={instrument} onChange={e=>setInstrument(Number(e.target.value))}>{midiPrograms.map((label,value)=><option key={value} value={value}>{value+1}. {label}</option>)}</select></label>
        <TuningRow label={t('track_settings.tuning_row')} editKey="track_settings.new_track_tuning_edit" notes={newTuning} unavailable={false} busy={busy} onOpen={()=>setNewTuningOpen(true)} onPlay={onAudition&&(()=>onAudition({program:instrument},parseTuning(newTuning),true))}/>
        {newTuningOpen&&<TuningDialog mode="draft" pitches={parseTuning(newTuning)} name={newTuningName} onApply={choice=>{setNewTuning(formatTuning(choice.pitches));setNewTuningName(choice.name);}} onClose={()=>setNewTuningOpen(false)} onAudition={onAudition&&((list,strum)=>onAudition({program:instrument},list,strum))}/>}
        <button disabled={locked} onClick={applyNewTrack}>{t('track_settings.add_track')}</button>
      </details>
    </fieldset>
    <NotationTrackControls busy={busy||locked} onEdit={onEdit}/></aside>;
}
