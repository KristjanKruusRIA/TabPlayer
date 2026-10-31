import { useEffect, useMemo, useState } from 'react';
import { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { EditCommand, NoteTechniques, BeatTechniques, PitchCurve, LinkKind, NoteTarget, IndexedNoteTarget } from '../edit-types';
import { describeSelection } from '../engine';
import { EnumInput } from './controls';
import { CurveEditor } from './CurveEditor';
import { IndexInput } from './IndexInput';
import { durationLabel, durationValues, tremoloMarks, tremoloSpeed } from './common';
import { nextLinkedNote } from './techniques';
import { NoteAudioControls } from './NoteAudioControls';
import { BusyFieldset } from '../ui/BusyFieldset';
import { busyGuard } from '../ui/useBusyGuard';

export type EditorProps={score:model.Score;target:BeatTarget;string:number;noteIndex?:number|null;busy:boolean;onEdit:(command:EditCommand)=>void|Promise<boolean>};
const pianoFingers={Unspecified:-2,None:-1,'1 (thumb)':0,'2 (index)':1,'3 (middle)':2,'4 (ring)':3,'5 (little)':4};
function curveOf(type:number,style:number,points:model.BendPoint[]|null):PitchCurve|null {return type&&points?{type,style,points:points.map(p=>({offset:p.offset,value:p.value}))}:null;}
export function TechniquePanel({score,target,string,noteIndex=0,busy,onEdit}:EditorProps) {
  const edit=(command:EditCommand)=>busy?Promise.resolve(false):onEdit(command);
  const {staff,beat}=describeSelection(score,target),indexed=staff.isPercussion||!staff.tuning.length,note=indexed?(noteIndex===null?undefined:beat?.notes[noteIndex]):beat?.notes.find(n=>n.string===string),stringed=!indexed;
  const patch=(patch:NoteTechniques)=>{if(indexed){if(noteIndex!==null)return edit({type:'setNoteTechniquesByIndex',target,noteIndex,patch});}else return edit({type:'setNoteTechniques',target,string,patch});};
  const beatPatch=(patch:BeatTechniques)=>edit({type:'setBeatTechniques',target,patch});
  const [slurBar,setSlurBar]=useState(target.bar+1),[slurBeat,setSlurBeat]=useState(target.beat+2),[slurString,setSlurString]=useState(string),[slurNote,setSlurNote]=useState(1);
  useEffect(()=>{setSlurBar(target.bar+1);setSlurBeat(Math.min(target.beat+2,staff.bars[target.bar].voices[target.voice].beats.length));setSlurString(string);setSlurNote(1);},[score,target.bar,target.beat,target.voice,target.staff,target.track,string,staff,noteIndex]);
  const address=(current:model.Note):NoteTarget|IndexedNoteTarget=>{const location={track:target.track,staff:target.staff,voice:target.voice,bar:current.beat.voice.bar.index,beat:current.beat.index};return indexed?{target:location,noteIndex:current.beat.notes.indexOf(current)}:{target:location,string:current.string};};
  const link=(kind:LinkKind,to:NoteTarget|IndexedNoteTarget|null)=>{if(indexed){if(noteIndex!==null)edit({type:'setNoteLinkByIndex',from:{target,noteIndex},to:to as IndexedNoteTarget|null,kind});}else edit({type:'setNoteLink',from:{target,string},to:to as NoteTarget|null,kind});};
  const breakIncoming=(kind:LinkKind)=>{const origin=kind==='tie'?note?.tieOrigin:kind==='slur'?note?.slurOrigin:note?.hammerPullOrigin;if(origin){const from=address(origin);if('noteIndex' in from)edit({type:'setNoteLinkByIndex',from,to:null,kind});else edit({type:'setNoteLink',from,to:null,kind});}};
  const next=()=>{
    const destination=note?nextLinkedNote(note):null;return destination?address(destination):null;
  };
  const bend=useMemo(()=>curveOf(note?.bendType??0,note?.bendStyle??0,note?.bendPoints??null),[score,note]),whammy=useMemo(()=>curveOf(beat?.whammyBarType??0,beat?.whammyStyle??0,beat?.whammyBarPoints??null),[score,beat]);
  const availableTremolo=durationValues.filter(speed=>tremoloMarks(beat?.duration??4,speed)!==null),defaultTremolo=availableTremolo.includes(16)?16:availableTremolo[0];
  return <details><summary>Notes & techniques</summary><p className="muted">Note controls apply to {indexed?noteIndex===null?'the selected chord note':`chord note ${noteIndex+1}`:`string ${string}`}. Beat controls apply to every note in the beat.</p>
    <BusyFieldset busy={busy} disabled={!note}><div className="technique-grid">{([
      ['Let ring','letRing',note?.isLetRing],['Palm mute','palmMute',note?.isPalmMute],['Dead note','dead',note?.isDead],['Ghost note','ghost',note?.isGhost],['Staccato','staccato',note?.isStaccato],['Left-hand tapping','leftHandTapped',note?.isLeftHandTapped],
    ] as const).map(([label,key,value])=><label className="check" key={key}><input type="checkbox" disabled={!stringed&&['letRing','palmMute','dead','leftHandTapped'].includes(key)} checked={value??false} onChange={e=>patch({[key]:e.target.checked})}/>{label}</label>)}</div>
      <div className="pair"><EnumInput label="Accent" value={note?.accentuated??0} enumeration={model.AccentuationType} onValue={accent=>patch({accent})}/><EnumInput label="Dynamics" value={note?.dynamics??4} enumeration={model.DynamicValue} onValue={dynamics=>patch({dynamics})}/></div>
      <NoteAudioControls note={note} score={score} busy={busy} onApply={audio=>patch({audio})}/>
      <div className="pair"><EnumInput label="Left-hand finger" disabled={staff.isPercussion} value={note?.leftHandFinger??-2} enumeration={indexed?pianoFingers:model.Fingers} onValue={leftFinger=>patch({leftFinger})}/><EnumInput label="Right-hand finger" disabled={staff.isPercussion} value={note?.rightHandFinger??-2} enumeration={indexed?pianoFingers:model.Fingers} onValue={rightFinger=>patch({rightFinger})}/></div>
      <div className="pair"><EnumInput label="Slide in" disabled={!stringed} value={note?.slideInType??0} enumeration={model.SlideInType} onValue={slideIn=>patch({slideIn})}/><EnumInput label="Slide out" disabled={!stringed} value={note?.slideOutType??0} enumeration={model.SlideOutType} onValue={slideOut=>patch({slideOut})}/></div>
      <div className="pair"><EnumInput label="Vibrato" disabled={staff.isPercussion} value={note?.vibrato??0} enumeration={model.VibratoType} onValue={vibrato=>patch({vibrato})}/><EnumInput label="Ornament" disabled={staff.isPercussion} value={note?.ornament??0} enumeration={model.NoteOrnament} onValue={ornament=>patch({ornament})}/></div>
      <div className="pair"><EnumInput label="Harmonic type" disabled={!stringed} value={note?.harmonicType??0} enumeration={model.HarmonicType} onValue={type=>patch({harmonic:type?{type,value:note?.harmonicValue||12}:null})}/><label>Harmonic value<input disabled={!stringed} type="number" min={0} step={.5} value={note?.harmonicValue??0} onChange={e=>patch({harmonic:{type:note?.harmonicType||model.HarmonicType.Natural,value:Number(e.target.value)}})}/></label></div>
      <label className="check"><input type="checkbox" disabled={staff.isPercussion} checked={note?.isTrill??false} onChange={e=>patch({trill:e.target.checked?{pitch:Math.min(127,(note?.realValue??60)+2),speed:16}:null})}/>Trill</label>
      <div className="pair"><label>Trill pitch<input disabled={staff.isPercussion} type="number" min={0} max={127} value={note?.isTrill?note.trillValue:Math.min(127,(note?.realValue??60)+2)} onChange={e=>patch({trill:{pitch:Number(e.target.value),speed:note?.trillSpeed??16}})}/></label><label>Trill speed<select disabled={staff.isPercussion} value={note?.trillSpeed??16} onChange={e=>patch({trill:{pitch:note?.isTrill?note.trillValue:Math.min(127,(note?.realValue??60)+2),speed:Number(e.target.value)}})}>{durationValues.map(n=><option key={n} value={n}>{durationLabel(n)}</option>)}</select></label></div>
    </BusyFieldset>
    <CurveEditor label="Bend" value={bend} disabled={busy||!note||!stringed} onChange={bend=>patch({bend})}/>
    <BusyFieldset busy={busy} disabled={!note}>
      <div className="pair"><button {...busyGuard({busy,disabled:!next(),onClick:()=>link('tie',next())})}>Tie to next note</button><button {...busyGuard({busy,onClick:()=>link('tie',null)})}>Break tie</button></div>
      <button {...busyGuard({busy,disabled:!note?.tieOrigin,onClick:()=>breakIncoming('tie')})}>Break incoming tie</button>
      <div className="pair"><button {...busyGuard({busy,disabled:!stringed||!next(),onClick:()=>link('hammerPull',next())})}>Hammer/pull to next</button><button {...busyGuard({busy,disabled:!stringed,onClick:()=>link('hammerPull',null)})}>Break hammer/pull</button></div>
      <button {...busyGuard({busy,disabled:!stringed||!note?.hammerPullOrigin,onClick:()=>breakIncoming('hammerPull')})}>Break incoming hammer/pull</button>
      <details><summary>Explicit slur destination</summary><div className="pair"><IndexInput label="Slur measure" value={slurBar} min={1} max={staff.bars.length} onValue={value=>{setSlurBar(value);setSlurBeat(1);}}/><IndexInput label="Slur beat" value={slurBeat} min={1} max={Math.max(1,staff.bars[slurBar-1]?.voices[target.voice]?.beats.length??1)} onValue={setSlurBeat}/></div>{indexed?<IndexInput label="Slur note" value={slurNote} min={1} max={Math.max(1,staff.bars[slurBar-1]?.voices[target.voice]?.beats[slurBeat-1]?.notes.length??1)} onValue={setSlurNote}/>:<IndexInput label="Slur string" value={slurString} min={1} max={staff.tuning.length} onValue={setSlurString}/>}<div className="pair"><button {...busyGuard({busy,onClick:()=>link('slur',indexed?{target:{...target,bar:slurBar-1,beat:slurBeat-1},noteIndex:slurNote-1}:{target:{...target,bar:slurBar-1,beat:slurBeat-1},string:slurString})})}>Create slur</button><button {...busyGuard({busy,onClick:()=>link('slur',null)})}>Break slur</button></div><button {...busyGuard({busy,disabled:!note?.slurOrigin,onClick:()=>breakIncoming('slur')})}>Break incoming slur</button></details>
    </BusyFieldset>
    <BusyFieldset busy={busy} disabled={!beat}><h3>Beat techniques</h3><div className="pair"><EnumInput label="Pick stroke" disabled={!stringed} value={beat?.pickStroke??0} enumeration={model.PickStroke} onValue={pickStroke=>beatPatch({pickStroke})}/><EnumInput label="Brush direction" disabled={!stringed} value={beat?.brushType??0} enumeration={model.BrushType} onValue={brushType=>beatPatch({brushType})}/></div>
      <label>Brush duration (ticks)<input disabled={!stringed} type="number" min={0} value={beat?.brushDuration??0} onChange={e=>beatPatch({brushDuration:Number(e.target.value)})}/></label>
      <label className="check"><input type="checkbox" checked={beat?.isTremolo??false} disabled={!availableTremolo.length} onChange={e=>beatPatch({tremolo:e.target.checked?{speed:defaultTremolo,style:0}:null})}/>Tremolo picking</label>
      <div className="pair"><label>Tremolo speed<select disabled={!availableTremolo.length} value={tremoloSpeed(beat)??defaultTremolo??16} onChange={e=>beatPatch({tremolo:{speed:Number(e.target.value),style:beat?.tremoloPicking?.style??0}})}>{durationValues.map(n=><option key={n} value={n} disabled={!availableTremolo.includes(n)}>{durationLabel(n)}</option>)}</select></label><EnumInput label="Tremolo style" disabled={!availableTremolo.length} value={beat?.tremoloPicking?.style??0} enumeration={model.TremoloPickingStyle} onValue={style=>beatPatch({tremolo:{speed:tremoloSpeed(beat)??defaultTremolo,style}})}/></div>
    </BusyFieldset>
    <CurveEditor label="Whammy" value={whammy} whammy disabled={busy||!beat||!stringed} onChange={whammy=>beatPatch({whammy})}/>
  </details>;
}
