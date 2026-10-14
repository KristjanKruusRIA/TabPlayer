import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import type { EditCommand } from './project';
import type { PlaybackController } from './playback';

export function TrackPanel({score,selected,busy,onSelect,onEdit,player}: {
  score:model.Score;selected:number;busy:boolean;onSelect:(index:number)=>void;onEdit:(edit:EditCommand)=>void;
  player:PlaybackController|null;
}) {
  const current=score.tracks[selected];const pitches=current.staves[0].tuning.join(',');
  const [tuning,setTuning]=useState(pitches);useEffect(()=>setTuning(pitches),[pitches,selected]);
  const [name,setName]=useState('Bass');const [instrument,setInstrument]=useState(33);const [newTuning,setNewTuning]=useState('43,38,33,28');
  const parse=(text:string)=>text.split(',').map(n=>n.trim()===''?NaN:Number(n));
  return <aside className="tracks"><h2>Tracks</h2><div className="track-list">{score.tracks.map(track=><div className={`track-card ${track.index===selected?'selected':''}`} key={track.index}>
    <button aria-label={`Track ${track.index+1}: ${track.name}`} aria-pressed={track.index===selected} onClick={()=>onSelect(track.index)}>{track.name || `Track ${track.index+1}`}</button>
    <span className="muted">{track.isPercussion?'Percussion':`${track.staves[0].tuning.length} strings · MIDI ${track.playbackInfo.program}`}</span>
    <div className="mixer" key={`${score.title}/${score.masterBars.length}/${track.index}`}>
      <label className="check"><input type="checkbox" defaultChecked={player?.mix(track.index)?.mute ?? track.playbackInfo.isMute} disabled={!player} onChange={e=>player?.setMute(track.index,e.target.checked)}/>Mute</label>
      <label className="check"><input type="checkbox" defaultChecked={player?.mix(track.index)?.solo ?? track.playbackInfo.isSolo} disabled={!player} onChange={e=>player?.setSolo(track.index,e.target.checked)}/>Solo</label>
      <label className="volume">Volume<input type="range" min={0} max={1} step={.05} defaultValue={player?.mix(track.index)?.volume ?? 1} disabled={!player} aria-label={`Volume ${track.name}`} onChange={e=>player?.setTrackVolume(track.index,Number(e.target.value))}/></label>
    </div>
  </div>)}</div><fieldset disabled={busy}>
    <button disabled={score.tracks.length===1} onClick={()=>onEdit({type:'removeTrack',track:selected})}>Remove track</button>
    <label>Tuning (MIDI, high to low)<input disabled={current.isPercussion} value={tuning} onChange={e=>setTuning(e.target.value)}/></label>
    <button disabled={current.isPercussion} onClick={()=>onEdit({type:'setTuning',track:selected,tuning:parse(tuning)})}>Apply tuning</button>
    <details open><summary>Add instrument</summary><label>New track name<input value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>MIDI instrument<select value={instrument} onChange={e=>setInstrument(Number(e.target.value))}>{[[25,'Acoustic guitar'],[27,'Clean guitar'],[30,'Distorted guitar'],[33,'Electric bass']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>New track tuning<input value={newTuning} onChange={e=>setNewTuning(e.target.value)}/></label>
      <button onClick={()=>onEdit({type:'addTrack',name,tuning:parse(newTuning),program:instrument})}>Add track</button>
    </details>
  </fieldset></aside>;
}
