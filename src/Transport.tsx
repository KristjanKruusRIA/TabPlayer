import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { BeatTarget } from './project';
import type { MusicSelection } from './editor/range-types';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './audio/selection-playback-types';
import { requireCursorChoice,requirePassageChoice } from './audio/selection-playback';
import { SelectionPlaybackControls } from './audio/SelectionPlaybackControls';
import { busyGuard } from './ui/useBusyGuard';
import { FirstBarGlyph,LastBarGlyph,LoopGlyph,MetronomeGlyph,MinusGlyph,MoreGlyph,NextBarGlyph,PauseGlyph,PlayGlyph,PlusGlyph,PreviousBarGlyph,StopGlyph } from './shell/glyphs';
import { useI18n } from './i18n';
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
export interface TransportDisplay {
  /** The selected track, as "number. name". */
  track:string;
  /** The selected track's colour as #rrggbb, drawn as a strip at the display's edge. */
  color?:string;
  /** The time signature written at a bar, such as "4/4". */
  signatureAt:(bar:number)=>string;
}
export function Transport({player,measures,busy,cursor,selection,display:lcd}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setPractice'|'generation'|'cursorPlaybackChoices'|'selectionPlaybackChoices'|'playbackOccurrences'|'playFromCursor'|'playSelection'|'loopSelection'>;measures:number;busy:boolean;cursor:BeatTarget;selection:MusicSelection|null;display?:TransportDisplay}) {
  const { t } = useI18n();
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
  const shownBar=Math.min(Math.max(0,measures-1),Math.max(0,scrub!==null?scrub-1:state.measure));
  const stepBar=(bar:number)=>{if(busy)return;const next=Math.min(Math.max(0,bar),Math.max(0,measures-1));if(act(()=>player.seekToMeasure(next)))setNextStart('position');};
  const barButton=(label:string,bar:number,glyph:React.JSX.Element,unavailable:boolean)=><button {...busyGuard({busy,unavailable,className:'transport-barstep',onClick:()=>stepBar(bar)})} title={label} aria-label={label}>{glyph}</button>;
  return <div className="transport" role="group" aria-label={t('transport.aria_label')}><input type="range" className="transport-scrub" aria-label={t('transport.playback_position')} min={1} max={Math.max(1,measures)} step={1} value={scrub??Math.min(Math.max(1,measures),Math.max(1,state.measure+1))} disabled={!state.ready} aria-disabled={busy||undefined} aria-valuetext={t('transport.bar_x_of_y', { current: scrub ?? state.measure + 1, total: measures })} style={{'--progress':state.endTime>0?Math.min(1,Math.max(0,state.time/state.endTime)):0} as React.CSSProperties} onPointerDown={()=>{dragging.current=true;}} onPointerUp={()=>{dragging.current=false;commitScrub();}} onPointerCancel={()=>{dragging.current=false;setScrub(null);}} onBlur={()=>{if(!dragging.current)setScrub(null);}} onChange={event=>{if(busy)return;const value=Number(event.target.value);setScrub(value);if(!dragging.current)commitScrub(value);}}/><fieldset className="transport-primary" disabled={!state.ready}>
    <div className="transport-group transport-play">
      <span className="transport-barnav" role="group" aria-label={t('transport.bar_navigation')}>{barButton(t('transport.first_bar'),0,<FirstBarGlyph/>,shownBar<=0)}{barButton(t('transport.previous_bar'),shownBar-1,<PreviousBarGlyph/>,shownBar<=0)}</span>
      <button {...busyGuard({busy:!state.playing&&(busy||fromCursor&&state.practicePending),disabled:!state.playing&&fromCursor&&!currentCursor,className:'primary transport-playbutton',onClick:()=>act(()=>state.playing?player.pause():fromCursor?player.play(cursor,currentCursor!):player.play())})} aria-keyshortcuts="Space" title={fromCursor?t('transport.play_from_cursor'):nextStart==='position'?t('transport.play_from_position'):undefined}>{state.playing?<PauseGlyph/>:<PlayGlyph/>}{state.playing?t('transport.pause'):t('transport.play')}</button>
      <button className="transport-stopbutton" title={t('transport.stop')} onClick={()=>{setNextStart('cursor');act(()=>player.stop());}}><StopGlyph/><span className="transport-label">{t('transport.stop')}</span></button>
      <span className="transport-barnav" role="group" aria-label={t('transport.bar_navigation')}>{barButton(t('transport.next_bar'),shownBar+1,<NextBarGlyph/>,shownBar>=measures-1)}{barButton(t('transport.last_bar'),measures-1,<LastBarGlyph/>,shownBar>=measures-1)}</span>
    </div>
    <div className={`transport-group transport-position${lcd?' transport-lcd':''}`} role={lcd?'group':undefined} aria-label={lcd?t('transport.position_display'):undefined} style={lcd?{'--lcd-track':lcd.color??'transparent','--lcd-progress':`${state.endTime>0?Math.min(100,Math.max(0,state.time/state.endTime*100)):0}%`} as CSSProperties:undefined}>
      {lcd&&<span className="transport-lcd-track" title={lcd.track}>{lcd.track}</span>}
      <span className="transport-caption transport-bar-number"><span>{t('transport.bar_n', { number: scrub ?? state.measure + 1 })}</span><span className="transport-dim transport-of">{t('transport.of_n', { total: measures })}</span></span>
      <output aria-live="off" className="transport-time"><span>{clock(state.time)}</span><span className="transport-dim"> / {clock(state.endTime)}</span></output>
      {lcd&&<span className="transport-lcd-meta" aria-hidden="true"><span>{lcd.signatureAt(shownBar)}</span><span>{practice.currentBpm>0?`♩ = ${Math.round(practice.currentBpm)}`:'♩ = –'}</span></span>}
    </div>
    <div className="transport-group transport-loop" role="group" aria-label={t('transport.loop')}><span className="transport-caption">{t('transport.loop_bars')}</span>
      <div className="transport-row"><BarField label={t('transport.loop_start')} min={1} max={measures} value={start} onValue={setStart}/><span className="transport-dash" aria-hidden="true"/><BarField label={t('transport.loop_end')} min={1} max={measures} value={end} onValue={setEnd}/>
        <button {...busyGuard({busy,unavailable:state.practicePending,className:'transport-toggle transport-loopbutton',onClick:()=>act(()=>loop?player.clearLoop():player.setLoop(start-1,end-1))})} aria-pressed={loop}><LoopGlyph/>{loop?t('transport.clear_loop'):t('transport.loop')}</button></div>
    </div>
    <div className="transport-group transport-click"><span className="transport-caption">{t('transport.click')}</span>
      <label className="transport-toggle transport-metronome" title={t('transport.metronome')} data-on={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined}><input type="checkbox" checked={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined} onChange={e=>{if(settingsBusy)return;act(()=>{const settings=structuredClone(practice.settings);settings.metronome.enabled=e.target.checked;player.setPractice(settings);});}}/><MetronomeGlyph/><span className="transport-label">{t('transport.metronome')}</span></label>
    </div>
    <div className="transport-group transport-speed" role="group" aria-label={t('transport.speed')}><span className="transport-caption">{t('transport.speed')}<span className="transport-tempo" role="status" aria-label={t('transport.practice_playback')} aria-live="off">{practice.currentBpm>0?`${display(practice.currentBpm)} BPM`:t('transport.tempo_unavailable')}<span className="tp-sr"> · {display(practice.effectiveRatio*100)}%</span></span></span>
      <div className="transport-row"><button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex<=0,className:'transport-step',onClick:()=>stepSpeed(-1)})} title={fixed?t('transport.fixed_tempo_hint'):t('transport.slower')}><MinusGlyph/><span className="tp-sr">{t('transport.slower')}</span></button>
        <output className="transport-speedvalue" aria-live="off">{display(state.speed)}%</output>
        <button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex>=speeds.length-1,className:'transport-step',onClick:()=>stepSpeed(1)})} title={fixed?t('transport.fixed_tempo_hint'):t('transport.faster')}><PlusGlyph/><span className="tp-sr">{t('transport.faster')}</span></button></div>
    </div>
    <details className="transport-more" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>{t('transport.more_playback')}{(error||state.error||cursorError||passageError)?t('transport.error_suffix'):''}<MoreGlyph/></summary><div className="transport-more-content"><fieldset disabled={!state.ready}>
      <BarField label={t('transport.seek_measure')} min={1} max={measures} value={seek} onValue={setSeek}/><button {...busyGuard({busy,onClick:()=>{if(act(()=>player.seekToMeasure(seek-1)))setNextStart('position');}})}>{t('transport.seek')}</button>
      <span role="status" aria-label={t('transport.practice_passes')} aria-live="off">{t('transport.completed_passes', { count: practice.completedPasses })}</span>
    {practice.pulse&&<span role="status" aria-label={t('transport.metronome_pulse')} aria-live="off" data-pulse-serial={practice.pulse.serial}>{practice.pulse.counting?t('transport.count_in_beat'):t('transport.beat')} {practice.pulse.beat+1} {t('transport.of')} {practice.pulse.beatsPerBar}{practice.pulse.accent?t('transport.accent'):''}</span>}
    </fieldset><SelectionPlaybackControls cursorChoices={cursorChoices} passageChoices={passageChoices} occurrences={occurrences} cursorChoice={currentCursor} passageChoice={currentPassage} disabled={!state.ready||startDisabled} onCursorChoice={setCursorChoice} onPassageChoice={setPassageChoice} onPlayCursor={()=>{setNextStart('cursor');if(currentCursor)act(()=>player.playFromCursor(cursor,currentCursor));}} onPlaySelection={()=>{setNextStart('cursor');if(selection&&currentPassage)act(()=>player.playSelection(selection,currentPassage));}} onLoopSelection={()=>{if(selection&&currentPassage)act(()=>player.loopSelection(selection,currentPassage));}}/>
    {(cursorError||passageError)&&<p role="status">{cursorError||passageError}</p>}{state.range&&<p role="status" aria-label={t('transport.selected_range')} data-start-tick={state.range.startTick} data-end-tick={state.range.endTick}>{t('transport.selected_passage')} · {practice.phase==='ended'?t('transport.finished'):practice.phase==='countIn'?t('transport.counting_in'):state.playing?t('transport.playing'):t('transport.paused')}</p>}{counting&&<p role="status" aria-label={t('transport.count_in')}>{practice.phase==='paused'?t('transport.count_in_paused'):t('transport.count_in')} · {t('transport.pulses_remaining', { count: practice.countInRemaining })}</p>}
    </div></details></fieldset>
    {(state.practicePending||state.practiceNotice||error||state.error||!state.ready&&!state.error)&&<div className="transport-messages">{state.practicePending&&<span className="transport-feedback">{t('transport.applying_practice')}</span>}{state.practiceNotice&&<p className="transport-feedback">{state.practiceNotice}</p>}{(error||state.error) && <p className="transport-feedback" role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="transport-feedback">{t('transport.loading_audio')}</span>}</div>}</div>;
}
