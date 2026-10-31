import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { BeatTarget } from './project';
import type { MusicSelection } from './editor/range-types';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './audio/selection-playback-types';
import { requireCursorChoice,requirePassageChoice } from './audio/selection-playback';
import { SelectionPlaybackControls } from './audio/SelectionPlaybackControls';
import { busyGuard } from './ui/useBusyGuard';
import { LoopGlyph,MetronomeGlyph,MinusGlyph,MoreGlyph,PauseGlyph,PlayGlyph,PlusGlyph,StopGlyph } from './shell/glyphs';
import './shell/transport.css';
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${Math.floor(ms/1000)%60<10?'0':''}${Math.floor(ms/1000)%60}`;
const display=(value:number)=>Number(value.toFixed(2));
/** A whole-number field. The label is for assistive technology and the dialogs' tests; the transport's caption says what the pair is. */
function BarField({label,value,min,max,onValue}:{label:string;value:number;min:number;max:number;onValue:(value:number)=>void}) {
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  return <label className="transport-bar-field"><span className="tp-sr">{label}</span><input type="number" min={min} max={max} step={1} value={draft} onChange={event=>{
    const text=event.target.value;setDraft(text);
    const next=Number(text);
    if(text.trim()!==''&&Number.isInteger(next)&&next>=min&&next<=max)onValue(next);
  }}/></label>;
}
/** Play, loop, speed and the click are one row of captioned groups, so each is found by its caption without opening anything.
 * Seeking and the occurrence-aware "selected passage" controls sit behind More playback, which opens upward from the bar. */
export function Transport({player,measures,busy,cursor,selection}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setPractice'|'generation'|'cursorPlaybackChoices'|'selectionPlaybackChoices'|'playbackOccurrences'|'playFromCursor'|'playSelection'|'loopSelection'>;measures:number;busy:boolean;cursor:BeatTarget;selection:MusicSelection|null}) {
  const state=useSyncExternalStore(player.subscribe,player.getState);
  const occurrences=player.playbackOccurrences(),selectionAvailable=occurrences.length>0;
  const [seek,setSeek]=useState(1);const [start,setStart]=useState(1);const [end,setEnd]=useState(1);
  const [error,setError]=useState<string|null>(null);
  const [cursorChoice,setCursorChoice]=useState<CursorPlaybackChoice|null>(null),[passageChoice,setPassageChoice]=useState<PassagePlaybackChoice|null>(null),[nextStart,setNextStart]=useState<'cursor'|'position'>('cursor');
  const loop=state.loop!==null,practice=state.practice,fixed=practice.settings.tempo.kind==='fixed';
  const speeds=[...new Set([10,25,50,75,100,125,150,200,250,300,state.speed])].sort((a,b)=>a-b),speedIndex=speeds.indexOf(state.speed);
  const counting=practice.countInRemaining>0&&(practice.phase==='countIn'||practice.phase==='paused');
  const {choices:cursorChoices,error:cursorError}=useMemo(()=>{
    if(!state.ready)return {choices:[],error:null};
    try{return {choices:player.cursorPlaybackChoices(cursor),error:null};}catch(e){return {choices:[],error:e instanceof Error?e.message:String(e)};}
  },[player,player.generation,state.ready,selectionAvailable,cursor.track,cursor.staff,cursor.bar,cursor.voice,cursor.beat]);
  const {choices:passageChoices,error:passageError}=useMemo(()=>{
    if(!state.ready||!selection)return {choices:[],error:null};
    try{return {choices:player.selectionPlaybackChoices(selection),error:null};}catch(e){return {choices:[],error:e instanceof Error?e.message:String(e)};}
  },[player,player.generation,state.ready,selectionAvailable,selection]);
  let currentCursor:CursorPlaybackChoice|null=null,currentPassage:PassagePlaybackChoice|null=null;
  try{if(cursorChoice)currentCursor=requireCursorChoice(cursorChoices,cursorChoice);}catch{/* A changed cursor or plan retires its controlled choice. */}
  try{if(passageChoice)currentPassage=requirePassageChoice(passageChoices,passageChoice);}catch{/* Native playback is unchanged while a new passage is chosen. */}
  const fresh=practice.phase==='idle'||practice.phase==='ended',fromCursor=fresh&&!loop&&nextStart==='cursor',startDisabled=busy||state.practicePending;
  useEffect(()=>{setCursorChoice(cursorChoices.length===1?{...cursorChoices[0]}:null);setPassageChoice(passageChoices.length===1?{...passageChoices[0]}:null);},[player.generation,cursor.track,cursor.staff,cursor.bar,cursor.voice,cursor.beat,selection]);
  useEffect(()=>{setNextStart('cursor');},[player.generation,cursor.track,cursor.staff,cursor.bar,cursor.voice,cursor.beat]);
  useEffect(()=>{if(state.error)setNextStart('cursor');},[state.error]);
  useEffect(()=>{setSeek(value=>Math.min(value,measures));setStart(value=>Math.min(value,measures));setEnd(value=>Math.min(value,measures));},[measures]);
  const act=(action:()=>void)=>{try{action();setError(null);return true;}catch(e){setError(String(e));setNextStart('cursor');return false;}};
  const [scrub,setScrub]=useState<number|null>(null),dragging=useRef(false);
  const commitScrub=(value=scrub)=>{setScrub(null);if(value!==null&&!busy&&act(()=>player.seekToMeasure(value-1)))setNextStart('position');};
  const stepSpeed=(direction:-1|1)=>{const next=speeds[speedIndex+direction];if(next!==undefined)act(()=>player.setSpeed(next));};
  const settingsBusy=busy||state.practicePending;
  return <div className="transport" role="group" aria-label="Transport"><input type="range" className="transport-scrub" aria-label="Playback position" min={1} max={Math.max(1,measures)} step={1} value={scrub??Math.min(Math.max(1,measures),Math.max(1,state.measure+1))} disabled={!state.ready} aria-disabled={busy||undefined} aria-valuetext={`Bar ${scrub??state.measure+1} of ${measures}`} style={{'--progress':state.endTime>0?Math.min(1,Math.max(0,state.time/state.endTime)):0} as React.CSSProperties} onPointerDown={()=>{dragging.current=true;}} onPointerUp={()=>{dragging.current=false;commitScrub();}} onPointerCancel={()=>{dragging.current=false;setScrub(null);}} onBlur={()=>{if(!dragging.current)setScrub(null);}} onChange={event=>{if(busy)return;const value=Number(event.target.value);setScrub(value);if(!dragging.current)commitScrub(value);}}/><fieldset className="transport-primary" disabled={!state.ready}>
    <div className="transport-group transport-play">
      <button {...busyGuard({busy:!state.playing&&(busy||fromCursor&&state.practicePending),disabled:!state.playing&&fromCursor&&!currentCursor,className:'primary transport-playbutton',onClick:()=>act(()=>state.playing?player.pause():fromCursor?player.play(cursor,currentCursor!):player.play())})} aria-keyshortcuts="Space" title={fromCursor?'Play from score cursor':nextStart==='position'?'Play from transport position':undefined}>{state.playing?<PauseGlyph/>:<PlayGlyph/>}{state.playing?'Pause':'Play'}</button>
      <button className="transport-stopbutton" title="Stop" onClick={()=>{setNextStart('cursor');act(()=>player.stop());}}><StopGlyph/><span className="transport-label">Stop</span></button>
    </div>
    <div className="transport-group transport-position"><span className="transport-caption transport-bar-number"><span>Bar {scrub??state.measure+1}</span><span className="transport-dim transport-of">of {measures}</span></span>
      <output aria-live="off" className="transport-time"><span>{clock(state.time)}</span><span className="transport-dim"> / {clock(state.endTime)}</span></output>
    </div>
    <div className="transport-group transport-loop" role="group" aria-label="Loop"><span className="transport-caption">Loop bars</span>
      <div className="transport-row"><BarField label="Loop start" min={1} max={measures} value={start} onValue={setStart}/><span className="transport-dash" aria-hidden="true"/><BarField label="Loop end" min={1} max={measures} value={end} onValue={setEnd}/>
        <button {...busyGuard({busy,unavailable:state.practicePending,className:'transport-toggle transport-loopbutton',onClick:()=>act(()=>loop?player.clearLoop():player.setLoop(start-1,end-1))})} aria-pressed={loop}><LoopGlyph/>{loop?'Clear loop':'Loop'}</button></div>
    </div>
    <div className="transport-group transport-click"><span className="transport-caption">Click</span>
      <label className="transport-toggle transport-metronome" title="Metronome" data-on={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined}><input type="checkbox" checked={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined} onChange={e=>{if(settingsBusy)return;act(()=>{const settings=structuredClone(practice.settings);settings.metronome.enabled=e.target.checked;player.setPractice(settings);});}}/><MetronomeGlyph/><span className="transport-label">Metronome</span></label>
    </div>
    <div className="transport-group transport-speed" role="group" aria-label="Speed"><span className="transport-caption">Speed<span className="transport-tempo" role="status" aria-label="Practice playback" aria-live="off">{practice.currentBpm>0?`${display(practice.currentBpm)} BPM`:'Tempo unavailable'}<span className="tp-sr"> · {display(practice.effectiveRatio*100)}%</span></span></span>
      <div className="transport-row"><button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex<=0,className:'transport-step',onClick:()=>stepSpeed(-1)})} title={fixed?'Fixed tempo controls playback speed.':'Slower'}><MinusGlyph/><span className="tp-sr">Slower</span></button>
        <output className="transport-speedvalue" aria-live="off">{display(state.speed)}%</output>
        <button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex>=speeds.length-1,className:'transport-step',onClick:()=>stepSpeed(1)})} title={fixed?'Fixed tempo controls playback speed.':'Faster'}><PlusGlyph/><span className="tp-sr">Faster</span></button></div>
    </div>
    <details className="transport-more" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>More playback{(error||state.error||cursorError||passageError)?' · Error':''}<MoreGlyph/></summary><div className="transport-more-content"><fieldset disabled={!state.ready}>
      <BarField label="Seek measure" min={1} max={measures} value={seek} onValue={setSeek}/><button {...busyGuard({busy,onClick:()=>{if(act(()=>player.seekToMeasure(seek-1)))setNextStart('position');}})}>Seek</button>
      <span role="status" aria-label="Practice passes" aria-live="off">Completed passes {practice.completedPasses}</span>
    {practice.pulse&&<span role="status" aria-label="Metronome pulse" aria-live="off" data-pulse-serial={practice.pulse.serial}>{practice.pulse.counting?'Count-in beat':'Beat'} {practice.pulse.beat+1} of {practice.pulse.beatsPerBar}{practice.pulse.accent?' · Accent':''}</span>}
    </fieldset><SelectionPlaybackControls cursorChoices={cursorChoices} passageChoices={passageChoices} occurrences={occurrences} cursorChoice={currentCursor} passageChoice={currentPassage} disabled={!state.ready||startDisabled} onCursorChoice={setCursorChoice} onPassageChoice={setPassageChoice} onPlayCursor={()=>{setNextStart('cursor');if(currentCursor)act(()=>player.playFromCursor(cursor,currentCursor));}} onPlaySelection={()=>{setNextStart('cursor');if(selection&&currentPassage)act(()=>player.playSelection(selection,currentPassage));}} onLoopSelection={()=>{if(selection&&currentPassage)act(()=>player.loopSelection(selection,currentPassage));}}/>
    {(cursorError||passageError)&&<p role="status">{cursorError||passageError}</p>}{state.range&&<p role="status" aria-label="Selected playback range" data-start-tick={state.range.startTick} data-end-tick={state.range.endTick}>Selected passage · {practice.phase==='ended'?'finished':practice.phase==='countIn'?'counting in':state.playing?'playing':'paused'}</p>}{counting&&<p role="status" aria-label="Count-in">{practice.phase==='paused'?'Count-in paused':'Count-in'} · {practice.countInRemaining} pulses remaining</p>}
    </div></details></fieldset>
    {(state.practicePending||state.practiceNotice||error||state.error||!state.ready&&!state.error)&&<div className="transport-messages">{state.practicePending&&<span className="transport-feedback">Applying practice settings…</span>}{state.practiceNotice&&<p className="transport-feedback">{state.practiceNotice}</p>}{(error||state.error) && <p className="transport-feedback" role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="transport-feedback">Loading local audio…</span>}</div>}</div>;
}
