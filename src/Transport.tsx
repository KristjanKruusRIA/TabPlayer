import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import { IndexInput } from './editor/IndexInput';
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${Math.floor(ms/1000)%60<10?'0':''}${Math.floor(ms/1000)%60}`;
const display=(value:number)=>Number(value.toFixed(2));
export function Transport({player,measures,busy}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setPractice'>;measures:number;busy:boolean}) {
  const state=useSyncExternalStore(player.subscribe,player.getState);
  const [seek,setSeek]=useState(1);const [start,setStart]=useState(1);const [end,setEnd]=useState(1);
  const [error,setError]=useState<string|null>(null);
  const loop=state.loop!==null,practice=state.practice,fixed=practice.settings.tempo.kind==='fixed';
  const speeds=[...new Set([10,25,50,75,100,125,150,200,250,300,state.speed])].sort((a,b)=>a-b);
  const counting=practice.countInRemaining>0&&(practice.phase==='countIn'||practice.phase==='paused');
  useEffect(()=>{setSeek(value=>Math.min(value,measures));setStart(value=>Math.min(value,measures));setEnd(value=>Math.min(value,measures));},[measures]);
  const act=(action:()=>void)=>{try{action();setError(null);}catch(e){setError(String(e));}};
  return <div className="transport"><fieldset disabled={!state.ready || busy}>
    <button className="primary" aria-keyshortcuts="Space" onClick={()=>act(()=>state.playing?player.pause():player.play())}>{state.playing?'Pause':'Play'}</button>
    <button onClick={()=>act(()=>player.stop())}>Stop</button><output aria-live="off">{clock(state.time)} / {clock(state.endTime)} · M{state.measure+1}</output>
    <label>Speed<select value={state.speed} disabled={state.practicePending||fixed} title={fixed?'Fixed tempo controls playback speed.':undefined} onChange={e=>act(()=>player.setSpeed(Number(e.target.value)))}>{speeds.map(speed=><option key={speed} value={speed}>{display(speed)}%</option>)}</select></label>
    <IndexInput label="Seek measure" min={1} max={measures} value={seek} onValue={setSeek}/><button onClick={()=>act(()=>player.seekToMeasure(seek-1))}>Seek</button>
    <IndexInput label="Loop start" min={1} max={measures} value={start} onValue={setStart}/>
    <IndexInput label="Loop end" min={1} max={measures} value={end} onValue={setEnd}/>
    <button aria-pressed={loop} onClick={()=>act(()=>loop?player.clearLoop():player.setLoop(start-1,end-1))}>{loop?'Clear loop':'Loop'}</button>
    <label className="check"><input type="checkbox" checked={practice.settings.metronome.enabled} disabled={state.practicePending} onChange={e=>act(()=>{const settings=structuredClone(practice.settings);settings.metronome.enabled=e.target.checked;player.setPractice(settings);})}/>Metronome</label>
    <span role="status" aria-label="Practice playback" aria-live="off">{practice.currentBpm>0?`${display(practice.currentBpm)} BPM`:'Tempo unavailable'} · {display(practice.effectiveRatio*100)}% · Completed passes {practice.completedPasses}</span>
    {practice.pulse&&<span role="status" aria-label="Metronome pulse" aria-live="off" data-pulse-serial={practice.pulse.serial}>{practice.pulse.counting?'Count-in beat':'Beat'} {practice.pulse.beat+1} of {practice.pulse.beatsPerBar}{practice.pulse.accent?' · Accent':''}</span>}
  </fieldset>{counting&&<p role="status" aria-label="Count-in">{practice.phase==='paused'?'Count-in paused':'Count-in'} · {practice.countInRemaining} pulses remaining</p>}{state.practicePending&&<span className="muted">Applying practice settings…</span>}{state.practiceNotice&&<p>{state.practiceNotice}</p>}{(error||state.error) && <p role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="muted">Loading local audio…</span>}</div>;
}
