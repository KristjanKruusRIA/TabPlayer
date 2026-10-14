import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import { IndexInput } from './editor/IndexInput';
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${Math.floor(ms/1000)%60<10?'0':''}${Math.floor(ms/1000)%60}`;
export function Transport({player,measures,busy}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setMetronome'>;measures:number;busy:boolean}) {
  const state=useSyncExternalStore(player.subscribe,player.getState);
  const [seek,setSeek]=useState(1);const [start,setStart]=useState(1);const [end,setEnd]=useState(1);
  const [error,setError]=useState<string|null>(null);const [loop,setLoop]=useState(false);
  useEffect(()=>{setSeek(value=>Math.min(value,measures));setStart(value=>Math.min(value,measures));setEnd(value=>Math.min(value,measures));},[measures]);
  useEffect(()=>{if(!state.ready)setLoop(false);},[state.ready]);
  const act=(action:()=>void)=>{try{action();setError(null);}catch(e){setError(String(e));}};
  return <div className="transport"><fieldset disabled={!state.ready || busy}>
    <button className="primary" onClick={()=>state.playing?player.pause():player.play()}>{state.playing?'Pause':'Play'}</button>
    <button onClick={()=>player.stop()}>Stop</button><output aria-live="off">{clock(state.time)} / {clock(state.endTime)} · M{state.measure+1}</output>
    <label>Speed<select value={state.speed} onChange={e=>player.setSpeed(Number(e.target.value))}>{[25,50,75,100,125,150,200].map(speed=><option key={speed} value={speed}>{speed}%</option>)}</select></label>
    <IndexInput label="Seek measure" min={1} max={measures} value={seek} onValue={setSeek}/><button onClick={()=>act(()=>player.seekToMeasure(seek-1))}>Seek</button>
    <IndexInput label="Loop start" min={1} max={measures} value={start} onValue={setStart}/>
    <IndexInput label="Loop end" min={1} max={measures} value={end} onValue={setEnd}/>
    <button aria-pressed={loop} onClick={()=>act(()=>{if(loop){player.clearLoop();setLoop(false);}else{player.setLoop(start-1,end-1);setLoop(true);}})}>{loop?'Clear loop':'Loop'}</button>
    <label className="check"><input type="checkbox" checked={state.metronome} onChange={e=>player.setMetronome(e.target.checked?.4:0)}/>Metronome</label>
  </fieldset>{(error||state.error) && <p role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="muted">Loading local audio…</span>}</div>;
}
