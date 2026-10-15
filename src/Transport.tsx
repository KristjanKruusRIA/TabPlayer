import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import { IndexInput } from './editor/IndexInput';
import type { BeatTarget } from './project';
import type { MusicSelection } from './editor/range-types';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './audio/selection-playback-types';
import { requireCursorChoice,requirePassageChoice } from './audio/selection-playback';
import { SelectionPlaybackControls } from './audio/SelectionPlaybackControls';
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${Math.floor(ms/1000)%60<10?'0':''}${Math.floor(ms/1000)%60}`;
const display=(value:number)=>Number(value.toFixed(2));
export function Transport({player,measures,busy,cursor,selection}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setPractice'|'generation'|'cursorPlaybackChoices'|'selectionPlaybackChoices'|'playbackOccurrences'|'playFromCursor'|'playSelection'|'loopSelection'>;measures:number;busy:boolean;cursor:BeatTarget;selection:MusicSelection|null}) {
  const state=useSyncExternalStore(player.subscribe,player.getState);
  const [seek,setSeek]=useState(1);const [start,setStart]=useState(1);const [end,setEnd]=useState(1);
  const [error,setError]=useState<string|null>(null);
  const [cursorChoice,setCursorChoice]=useState<CursorPlaybackChoice|null>(null),[passageChoice,setPassageChoice]=useState<PassagePlaybackChoice|null>(null),[nextStart,setNextStart]=useState<'cursor'|'position'>('cursor');
  const loop=state.loop!==null,practice=state.practice,fixed=practice.settings.tempo.kind==='fixed';
  const speeds=[...new Set([10,25,50,75,100,125,150,200,250,300,state.speed])].sort((a,b)=>a-b);
  const counting=practice.countInRemaining>0&&(practice.phase==='countIn'||practice.phase==='paused');
  let cursorChoices:CursorPlaybackChoice[]=[],passageChoices:PassagePlaybackChoice[]=[],cursorError:string|null=null,passageError:string|null=null;
  if(state.ready){try{cursorChoices=player.cursorPlaybackChoices(cursor);}catch(e){cursorError=e instanceof Error?e.message:String(e);}if(selection)try{passageChoices=player.selectionPlaybackChoices(selection);}catch(e){passageError=e instanceof Error?e.message:String(e);}}
  let currentCursor:CursorPlaybackChoice|null=null,currentPassage:PassagePlaybackChoice|null=null;
  try{if(cursorChoice)currentCursor=requireCursorChoice(cursorChoices,cursorChoice);}catch{/* A changed cursor or plan retires its controlled choice. */}
  try{if(passageChoice)currentPassage=requirePassageChoice(passageChoices,passageChoice);}catch{/* Native playback is unchanged while a new passage is chosen. */}
  const fresh=practice.phase==='idle'||practice.phase==='ended',fromCursor=fresh&&!loop&&nextStart==='cursor',startDisabled=busy||state.practicePending;
  useEffect(()=>{setCursorChoice(cursorChoices.length===1?{...cursorChoices[0]}:null);setPassageChoice(passageChoices.length===1?{...passageChoices[0]}:null);},[player.generation,cursor.track,cursor.staff,cursor.bar,cursor.voice,cursor.beat,selection]);
  useEffect(()=>{setNextStart('cursor');},[player.generation,cursor.track,cursor.staff,cursor.bar,cursor.voice,cursor.beat]);
  useEffect(()=>{if(state.error)setNextStart('cursor');},[state.error]);
  useEffect(()=>{setSeek(value=>Math.min(value,measures));setStart(value=>Math.min(value,measures));setEnd(value=>Math.min(value,measures));},[measures]);
  const act=(action:()=>void)=>{try{action();setError(null);return true;}catch(e){setError(String(e));setNextStart('cursor');return false;}};
  return <div className="transport"><fieldset disabled={!state.ready}>
    <button className="primary" aria-keyshortcuts="Space" disabled={!state.playing&&(busy||fromCursor&&(startDisabled||!currentCursor))} title={fromCursor?'Play from score cursor':nextStart==='position'?'Play from transport position':undefined} onClick={()=>act(()=>state.playing?player.pause():fromCursor?player.play(cursor,currentCursor!):player.play())}>{state.playing?'Pause':'Play'}</button>
    <button onClick={()=>{setNextStart('cursor');act(()=>player.stop());}}>Stop</button><output aria-live="off">{clock(state.time)} / {clock(state.endTime)} · M{state.measure+1}</output>
    <label>Speed<select value={state.speed} disabled={busy||state.practicePending||fixed} title={fixed?'Fixed tempo controls playback speed.':undefined} onChange={e=>act(()=>player.setSpeed(Number(e.target.value)))}>{speeds.map(speed=><option key={speed} value={speed}>{display(speed)}%</option>)}</select></label>
    <IndexInput label="Seek measure" min={1} max={measures} value={seek} onValue={setSeek}/><button disabled={busy} onClick={()=>{if(act(()=>player.seekToMeasure(seek-1)))setNextStart('position');}}>Seek</button>
    <IndexInput label="Loop start" min={1} max={measures} value={start} onValue={setStart}/>
    <IndexInput label="Loop end" min={1} max={measures} value={end} onValue={setEnd}/>
    <button disabled={startDisabled} aria-pressed={loop} onClick={()=>act(()=>loop?player.clearLoop():player.setLoop(start-1,end-1))}>{loop?'Clear loop':'Loop'}</button>
    <label className="check"><input type="checkbox" checked={practice.settings.metronome.enabled} disabled={busy||state.practicePending} onChange={e=>act(()=>{const settings=structuredClone(practice.settings);settings.metronome.enabled=e.target.checked;player.setPractice(settings);})}/>Metronome</label>
    <span role="status" aria-label="Practice playback" aria-live="off">{practice.currentBpm>0?`${display(practice.currentBpm)} BPM`:'Tempo unavailable'} · {display(practice.effectiveRatio*100)}% · Completed passes {practice.completedPasses}</span>
    {practice.pulse&&<span role="status" aria-label="Metronome pulse" aria-live="off" data-pulse-serial={practice.pulse.serial}>{practice.pulse.counting?'Count-in beat':'Beat'} {practice.pulse.beat+1} of {practice.pulse.beatsPerBar}{practice.pulse.accent?' · Accent':''}</span>}
  </fieldset><SelectionPlaybackControls cursorChoices={cursorChoices} passageChoices={passageChoices} occurrences={player.playbackOccurrences()} cursorChoice={currentCursor} passageChoice={currentPassage} disabled={!state.ready||startDisabled} onCursorChoice={setCursorChoice} onPassageChoice={setPassageChoice} onPlayCursor={()=>{setNextStart('cursor');if(currentCursor)act(()=>player.playFromCursor(cursor,currentCursor));}} onPlaySelection={()=>{setNextStart('cursor');if(selection&&currentPassage)act(()=>player.playSelection(selection,currentPassage));}} onLoopSelection={()=>{if(selection&&currentPassage)act(()=>player.loopSelection(selection,currentPassage));}}/>
    {(cursorError||passageError)&&<p role="status">{cursorError||passageError}</p>}{state.range&&<p role="status" aria-label="Selected playback range" data-start-tick={state.range.startTick} data-end-tick={state.range.endTick}>Selected passage · {practice.phase==='ended'?'finished':practice.phase==='countIn'?'counting in':state.playing?'playing':'paused'}</p>}{counting&&<p role="status" aria-label="Count-in">{practice.phase==='paused'?'Count-in paused':'Count-in'} · {practice.countInRemaining} pulses remaining</p>}{state.practicePending&&<span className="muted">Applying practice settings…</span>}{state.practiceNotice&&<p>{state.practiceNotice}</p>}{(error||state.error) && <p role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="muted">Loading local audio…</span>}</div>;
}
