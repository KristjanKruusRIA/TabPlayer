import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import { midiPrograms } from './midi-programs';
import { formatTuning, parseTuning } from './tuning';
import { TuningInput } from './TuningInput';
import { NotationTrackControls } from './editor/NonTabPanel';
const noSubscribe=()=>()=>{};const noState=()=>null;

export function TrackPanel({score,selected,busy,onSelect,onEdit,player,children}: {
  score:model.Score;selected:number;busy:boolean;onSelect:(index:number)=>void;onEdit:(edit:EditCommand)=>void;
  player:Pick<NativePlaybackController,'subscribe'|'getState'|'mix'|'setMute'|'setSolo'|'setTrackVolume'|'setPan'>|null;children?:ReactNode;
}) {
  useSyncExternalStore(player?.subscribe ?? noSubscribe,player?.getState ?? noState);
  const current=score.tracks[selected];const pitches=formatTuning(current.staves[0].tuning);
  const [tuning,setTuning]=useState(pitches),[tuningError,setTuningError]=useState<string|null>(null);useEffect(()=>{setTuning(pitches);setTuningError(null);},[score,pitches,selected]);
  const [trackName,setTrackName]=useState(current.name),[shortName,setShortName]=useState(current.shortName),[program,setProgram]=useState(current.playbackInfo.program);
  useEffect(()=>{setTrackName(current.name);setShortName(current.shortName);setProgram(current.playbackInfo.program);},[score,current]);
  const [name,setName]=useState('Bass');const [instrument,setInstrument]=useState(33);const [newTuning,setNewTuning]=useState('G2 D2 A1 E1');
  const applyTuning=(add=false)=>{try{const notes=parseTuning(add?newTuning:tuning);setTuningError(null);onEdit(add?{type:'addTrack',name,tuning:notes,program:instrument}:{type:'setTuning',track:selected,tuning:notes});}catch(error){setTuningError(error instanceof Error?error.message:String(error));}};
  return <aside className="tracks"><h2>Tracks</h2><div className="track-list">{score.tracks.map(track=><div className={`track-card ${track.index===selected?'selected':''}`} key={track.index}>
    <button aria-label={`Track ${track.index+1}: ${track.name}`} aria-pressed={track.index===selected} onClick={()=>onSelect(track.index)}>{track.name || `Track ${track.index+1}`}</button>
    <span className="muted">{track.isPercussion?'Percussion':`${track.staves[0].tuning.length?`${track.staves[0].tuning.length} strings`:'Notation'} · MIDI ${track.playbackInfo.program}`}</span>
    <div className="mixer" key={`${score.title}/${score.masterBars.length}/${track.index}`}>
      <label className="check"><input type="checkbox" checked={player?.mix(track)?.mute ?? track.playbackInfo.isMute} disabled={busy||!player} onChange={e=>player?.setMute(track.index,e.target.checked)}/>Mute</label>
      <label className="check"><input type="checkbox" checked={player?.mix(track)?.solo ?? track.playbackInfo.isSolo} disabled={busy||!player} onChange={e=>player?.setSolo(track.index,e.target.checked)}/>Solo</label>
      <label className="volume">Volume<input type="range" min={0} max={1} step={.05} value={player?.mix(track)?.volume ?? 1} disabled={busy||!player} aria-label={`Volume ${track.name}`} onChange={e=>player?.setTrackVolume(track.index,Number(e.target.value))}/></label>
      <label className="volume">Pan<input type="range" min={-1} max={1} step={.05} value={player?.mix(track)?.pan ?? 0} disabled={busy||!player} aria-label={`Pan ${track.name}`} onChange={e=>player?.setPan(track.index,Number(e.target.value))}/></label>
    </div>
  </div>)}</div><fieldset disabled={busy}>
    <button disabled={score.tracks.length===1} onClick={()=>onEdit({type:'removeTrack',track:selected})}>Remove track</button>
    <details><summary>Selected instrument</summary><label>Track name<input value={trackName} onChange={e=>setTrackName(e.target.value)}/></label><label>Track short name<input value={shortName} onChange={e=>setShortName(e.target.value)}/></label><label>Track MIDI instrument<select value={program} onChange={e=>setProgram(Number(e.target.value))}>{midiPrograms.map((name,index)=><option key={index} value={index}>{index+1}. {name}</option>)}</select></label><button onClick={()=>onEdit({type:'setTrackInfo',track:selected,name:trackName,shortName,program})}>Apply instrument settings</button></details>
    <TuningInput label="Tuning (notes, high to low)" presetLabel="Tuning preset" disabled={current.isPercussion||!current.staves[0].tuning.length} placeholder="E4 B3 G3 D3 A2 E2" value={tuning} revision={current} onChange={notes=>{setTuning(notes);setTuningError(null);}}/>
    <button disabled={current.isPercussion||!current.staves[0].tuning.length} onClick={()=>applyTuning()}>Apply tuning</button>
    <details open><summary>Add instrument</summary><label>New track name<input value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>MIDI instrument<select value={instrument} onChange={e=>setInstrument(Number(e.target.value))}>{midiPrograms.map((label,value)=><option key={value} value={value}>{value+1}. {label}</option>)}</select></label>
      <TuningInput label="New track tuning" presetLabel="New track tuning preset" placeholder="G2 D2 A1 E1" value={newTuning} onChange={notes=>{setNewTuning(notes);setTuningError(null);}}/>
      <button onClick={()=>applyTuning(true)}>Add track</button>
    </details>
  </fieldset><NotationTrackControls busy={busy} onEdit={onEdit}/>{tuningError&&<p role="alert">{tuningError}</p>}{children}</aside>;
}
