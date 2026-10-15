import { useEffect, useState } from 'react';
import { model } from '@coderline/alphatab';
import { describeSelection } from './engine';
import type { BeatTarget, EditCommand } from './project';
import { IndexInput } from './editor/IndexInput';
import { TechniquePanel } from './editor/TechniquePanel';
import { StructurePanel } from './editor/StructurePanel';
import { MeasurePanel } from './editor/MeasurePanel';
import { ChordDialog } from './editor/ChordDialog';
import { EnumInput } from './editor/controls';
import type { ChordDefinition } from './edit-types';
import { formatPitch } from './tuning';
import { NonTabPanel } from './editor/NonTabPanel';
import { SongPanel } from './editor/SongPanel';
import { DirectionsPanel } from './editor/DirectionsPanel';
import { SpellingControl } from './editor/SpellingControl';
import { LyricsPanel } from './editor/LyricsPanel';
import { GesturePanel } from './editor/GesturePanel';
import { BarGesturePanel } from './editor/BarGesturePanel';
import { RangePanel } from './editor/RangePanel';
import { MeasureTransformPanel } from './editor/MeasureTransformPanel';
import type { MusicSelection } from './editor/range-types';

export function EditorPanel({score,target,string,fret,noteIndex,onSelectNote,busy,onSelect,onString,onFret,onEdit,musicSelection,onMusicSelection}: {
  score:model.Score;target:BeatTarget;string:number;fret:number;busy:boolean;
  noteIndex:number|null;onSelectNote:(index:number|null)=>void;
  onSelect:(target:BeatTarget)=>void;onString:(string:number)=>void;onFret:(fret:number)=>void;onEdit:(edit:EditCommand)=>void;
  musicSelection:MusicSelection|null;onMusicSelection:(selection:MusicSelection|null)=>void;
}) {
  const {staff,bar,voice,beat,master}=describeSelection(score,target);
  const indexed=staff.isPercussion||!staff.tuning.length;
  const [duration,setDuration]=useState(4);const [dots,setDots]=useState(0);
  const [tupletNumerator,setTupletNumerator]=useState(1),[tupletDenominator,setTupletDenominator]=useState(1),[graceType,setGraceType]=useState(0),[text,setText]=useState(beat?.text??''),[chordOpen,setChordOpen]=useState(false);
  useEffect(()=>{setDuration(beat?.duration ?? 4);setDots(beat?.dots ?? 0);setTupletNumerator(beat?.tupletNumerator&&beat.tupletNumerator>0?beat.tupletNumerator:1);setTupletDenominator(beat?.tupletDenominator&&beat.tupletDenominator>0?beat.tupletDenominator:1);setGraceType(beat?.graceType??0);setText(beat?.text??'');setChordOpen(false);},[score,beat,target.bar,target.beat,target.track,target.staff,target.voice]);
  const remaining=master.calculateDuration(false)-voice.beats.reduce((total,b)=>total+(b.isEmpty || b.graceType!==0?0:b.playbackDuration),0);
  const [title,setTitle]=useState(score.title);const [artist,setArtist]=useState(score.artist);const [tempo,setTempo]=useState(score.tempo);
  useEffect(()=>{setTitle(score.title);setArtist(score.artist);setTempo(score.tempo);},[score.title,score.artist,score.tempo]);
  return <aside className="inspector"><h2>Beat inspector</h2><fieldset disabled={busy}>
    <div className="pair"><IndexInput label="Measure" value={target.bar+1} min={1} max={score.masterBars.length} onValue={value=>onSelect({...target,bar:value-1,beat:0})}/>
    <IndexInput label="Beat" value={target.beat+1} min={1} max={Math.max(1,voice.beats.length)} onValue={value=>onSelect({...target,beat:value-1})}/></div>
    <div className="pair"><label>Staff<select value={target.staff} onChange={e=>onSelect({...target,staff:Number(e.target.value),voice:0,beat:0})}>{score.tracks[target.track].staves.map((s,i)=><option key={s.index} value={i}>{i+1}</option>)}</select></label>
    <label>Voice<select value={target.voice} onChange={e=>onSelect({...target,voice:Number(e.target.value),beat:0})}>{bar.voices.map(v=><option key={v.index} value={v.index}>{v.index+1}</option>)}</select></label></div>
    {indexed?<NonTabPanel score={score} target={target} noteIndex={noteIndex} onSelectNote={onSelectNote} busy={busy} onEdit={onEdit}/>:<><div className="pair"><label>String<select value={string} disabled={!staff.tuning.length} onChange={e=>onString(Number(e.target.value))}>{staff.tuning.map((pitch,i)=><option key={i} value={staff.tuning.length-i}>{staff.tuning.length-i} · {formatPitch(pitch)}</option>)}</select></label>
    <label>Fret<input type="number" min={0} max={127} value={fret} onChange={e=>onFret(Number(e.target.value))}/></label></div>
    <button className="primary" disabled={!beat || staff.isPercussion || !staff.tuning.length} onClick={()=>onEdit({type:'setNote',target,string,fret})}>Set note</button>
    <button disabled={!beat || !staff.tuning.length} onClick={()=>onEdit({type:'removeNote',target,string})}>Remove note</button>
    <p className="muted">Add notes on different strings of this beat to make a chord.</p></>}
    <div className="pair"><label>Duration<select value={duration} onChange={e=>setDuration(Number(e.target.value))}>{[-4,-2,1,2,4,8,16,32,64,128,256].map(d=><option key={d} value={d}>{d===-4?'Quadruple whole':d===-2?'Double whole':`1/${d}`}</option>)}</select></label>
    <label>Dots<input type="number" min={0} max={3} value={dots} onChange={e=>setDots(Number(e.target.value))}/></label></div>
    <div className="pair"><label>Tuplet numerator<input type="number" min={1} value={tupletNumerator} onChange={e=>setTupletNumerator(Number(e.target.value))}/></label><label>Tuplet denominator<input type="number" min={1} value={tupletDenominator} onChange={e=>setTupletDenominator(Number(e.target.value))}/></label></div>
    <EnumInput label="Grace type" value={graceType} enumeration={model.GraceType} onValue={setGraceType}/>
    <button disabled={!beat} onClick={()=>onEdit({type:'setBeatRhythm',target,duration,dots,tupletNumerator,tupletDenominator,graceType})}>Apply rhythm</button>
    <button disabled={!beat} onClick={()=>onEdit({type:'setRest',target})}>Make rest</button>
    <p className="muted">{!beat?'Empty voice insertion':beat.isFullBarRest?'Full-measure rest':beat.isRest?'Explicit rest':'Pitched beat'}{beat?.isRest&&!beat.isFullBarRest?' · Use a single whole rest for a full-measure rest.':''}</p>
    <p className="muted">{master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {remaining/960} quarter notes remaining</p>
    <div className="pair"><button onClick={()=>onEdit({type:'insertBeat',target,duration,dots})}>Insert beat</button><button disabled={!beat} onClick={()=>onEdit({type:'deleteBeat',target})}>Delete beat</button></div>
    <div className="pair"><button onClick={()=>onEdit({type:'appendMeasure'})}>Append measure</button><button disabled={score.masterBars.length===1} onClick={()=>onEdit({type:'removeMeasure',bar:target.bar})}>Remove measure</button></div>
  </fieldset><SpellingControl score={score} target={target} noteIndex={indexed?noteIndex??-1:beat?.notes.findIndex(n=>n.string===string)??-1} busy={busy} onEdit={onEdit}/><TechniquePanel score={score} target={target} string={string} noteIndex={noteIndex} busy={busy} onEdit={onEdit}/>
  <GesturePanel score={score} target={target} busy={busy} onEdit={onEdit}/>
  <RangePanel score={score} target={target} selection={musicSelection} busy={busy} onSelection={onMusicSelection} onEdit={onEdit}/>
  <details><summary>Beat text & chord</summary><fieldset disabled={busy||!beat}><label>Beat text<input value={text} onChange={e=>setText(e.target.value)}/></label><button onClick={()=>onEdit({type:'setBeatAnnotation',target,text,chord:beat?.chord?{name:beat.chord.name,firstFret:beat.chord.firstFret,frets:[...beat.chord.strings]}:null})}>Apply beat text</button><p className="muted">{beat?.chord?.name||'No chord diagram'}</p><button onClick={()=>setChordOpen(true)}>Edit chord diagram</button></fieldset></details>
  {chordOpen&&<ChordDialog strings={staff.tuning.length} disabled={busy} value={beat?.chord?{name:beat.chord.name,firstFret:beat.chord.firstFret,frets:[...beat.chord.strings]}:null} onChange={(chord:ChordDefinition|null)=>onEdit({type:'setBeatAnnotation',target,text,chord})} onClose={()=>setChordOpen(false)}/>}
  <MeasurePanel score={score} target={target} string={string} busy={busy} onEdit={onEdit}/><DirectionsPanel score={score} target={target} busy={busy} onEdit={onEdit}/><StructurePanel score={score} target={target} string={string} busy={busy} onEdit={onEdit} onSelect={onSelect}/>
  <BarGesturePanel score={score} track={target.track} staff={target.staff} bar={target.bar} busy={busy} onEdit={onEdit}/><LyricsPanel score={score} track={target.track} busy={busy} onEdit={onEdit}/>
  <MeasureTransformPanel score={score} bar={target.bar} busy={busy} onEdit={onEdit}/>
  <details><summary>Score information</summary><fieldset disabled={busy}>
    <label>Title<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Artist<input value={artist} onChange={e=>setArtist(e.target.value)}/></label>
    <label>Initial tempo<input type="number" min={1} value={tempo} onChange={e=>setTempo(Number(e.target.value))}/></label>
    <button onClick={()=>onEdit({type:'setScoreInfo',title,artist,tempo})}>Apply score info</button>
  </fieldset></details><SongPanel score={score} busy={busy} onEdit={onEdit}/></aside>;
}
