import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import { describeSelection } from './engine';
import type { BeatTarget, EditCommand } from './project';

export function EditorPanel({score,target,string,fret,busy,onSelect,onString,onFret,onEdit}: {
  score:model.Score;target:BeatTarget;string:number;fret:number;busy:boolean;
  onSelect:(target:BeatTarget)=>void;onString:(string:number)=>void;onFret:(fret:number)=>void;onEdit:(edit:EditCommand)=>void;
}) {
  const {staff,bar,voice,beat,master}=describeSelection(score,target);
  const [duration,setDuration]=useState(4);const [dots,setDots]=useState(0);
  useEffect(()=>{setDuration(beat?.duration ?? 4);setDots(beat?.dots ?? 0);},[beat?.duration,beat?.dots,target.bar,target.beat,target.track,target.voice]);
  const remaining=master.calculateDuration(false)-voice.beats.reduce((total,b)=>total+(b.isEmpty || b.graceType!==0?0:b.playbackDuration),0);
  const [title,setTitle]=useState(score.title);const [artist,setArtist]=useState(score.artist);const [tempo,setTempo]=useState(score.tempo);
  useEffect(()=>{setTitle(score.title);setArtist(score.artist);setTempo(score.tempo);},[score.title,score.artist,score.tempo]);
  return <aside className="inspector"><h2>Beat inspector</h2><fieldset disabled={busy}>
    <div className="pair"><label>Measure<input type="number" min={1} max={score.masterBars.length} value={target.bar+1} onChange={e=>onSelect({...target,bar:Math.max(0,Math.min(score.masterBars.length-1,Number(e.target.value)-1)),beat:0})}/></label>
    <label>Beat<input type="number" min={1} max={Math.max(1,voice.beats.length)} value={target.beat+1} onChange={e=>onSelect({...target,beat:Math.max(0,Math.min(Math.max(0,voice.beats.length-1),Number(e.target.value)-1))})}/></label></div>
    <div className="pair"><label>Staff<select value={target.staff} onChange={e=>onSelect({...target,staff:Number(e.target.value),voice:0,beat:0})}>{score.tracks[target.track].staves.map((s,i)=><option key={s.index} value={i}>{i+1}</option>)}</select></label>
    <label>Voice<select value={target.voice} onChange={e=>onSelect({...target,voice:Number(e.target.value),beat:0})}>{bar.voices.map(v=><option key={v.index} value={v.index}>{v.index+1}</option>)}</select></label></div>
    <div className="pair"><label>String<select value={string} disabled={!staff.tuning.length} onChange={e=>onString(Number(e.target.value))}>{staff.tuning.map((pitch,i)=><option key={i} value={staff.tuning.length-i}>{staff.tuning.length-i} · MIDI {pitch}</option>)}</select></label>
    <label>Fret<input type="number" min={0} max={127} value={fret} onChange={e=>onFret(Number(e.target.value))}/></label></div>
    <button className="primary" disabled={!beat || staff.isPercussion || !staff.tuning.length} onClick={()=>onEdit({type:'setNote',target,string,fret})}>Set note</button>
    <button disabled={!beat || !staff.tuning.length} onClick={()=>onEdit({type:'removeNote',target,string})}>Remove note</button>
    <p className="muted">Add notes on different strings of this beat to make a chord.</p>
    <div className="pair"><label>Duration<select value={duration} onChange={e=>setDuration(Number(e.target.value))}>{[1,2,4,8,16,32,64].map(d=><option key={d} value={d}>1/{d}</option>)}</select></label>
    <label>Dots<input type="number" min={0} max={3} value={dots} onChange={e=>setDots(Number(e.target.value))}/></label></div>
    <button disabled={!beat} onClick={()=>onEdit({type:'setDuration',target,duration,dots})}>Apply rhythm</button>
    <button disabled={!beat} onClick={()=>onEdit({type:'setRest',target})}>Make rest</button>
    <p className="muted">{master.timeSignatureNumerator}/{master.timeSignatureDenominator} · {remaining/960} quarter notes remaining</p>
    <div className="pair"><button onClick={()=>onEdit({type:'insertBeat',target,duration,dots})}>Insert beat</button><button disabled={!beat} onClick={()=>onEdit({type:'deleteBeat',target})}>Delete beat</button></div>
    <div className="pair"><button onClick={()=>onEdit({type:'appendMeasure'})}>Append measure</button><button disabled={score.masterBars.length===1} onClick={()=>onEdit({type:'removeMeasure',bar:target.bar})}>Remove measure</button></div>
  </fieldset><details><summary>Score information</summary><fieldset disabled={busy}>
    <label>Title<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Artist<input value={artist} onChange={e=>setArtist(e.target.value)}/></label>
    <label>Initial tempo<input type="number" min={1} value={tempo} onChange={e=>setTempo(Number(e.target.value))}/></label>
    <button onClick={()=>onEdit({type:'setScoreInfo',title,artist,tempo})}>Apply score info</button>
  </fieldset></details></aside>;
}
