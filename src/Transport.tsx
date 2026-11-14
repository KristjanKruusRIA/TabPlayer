import { keyFoldQuery } from './shell/toolbar-fit';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import type { BeatTarget } from './project';
import type { MusicSelection } from './editor/range-types';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './audio/selection-playback-types';
import { requireCursorChoice,requirePassageChoice } from './audio/selection-playback';
import { SelectionPlaybackControls } from './audio/SelectionPlaybackControls';
import { busyGuard } from './ui/useBusyGuard';
import { tonalityOf } from './audio/practice-types';
import type { BarCompletion } from './editor/bar-completion';
import { FirstBarGlyph,LastBarGlyph,LoopGlyph,MetronomeGlyph,MinusGlyph,MoreGlyph,NextBarGlyph,PauseGlyph,PlayGlyph,PlusGlyph,PreviousBarGlyph,StopGlyph } from './shell/glyphs';
import { useI18n } from './i18n';
import { useLoopPassage } from './audio/useLoopPassage';
import { loopFractions,loopText } from './audio/loop-passage';
import './shell/transport.css';
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${Math.floor(ms/1000)%60<10?'0':''}${Math.floor(ms/1000)%60}`;
const display=(value:number)=>Number(value.toFixed(2));
/** How long the loop must stay gone before the status line says it is off. */
const loopOffDelayMs=500;
/** A whole-number field. The label is for assistive technology and the dialogs' tests; the transport's caption says what the pair is. */
function BarField({label,value,min,max,onValue}:{label:string;value:number;min:number;max:number;onValue:(value:number)=>void}) {
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  return <label className="transport-bar-field"><span className="tp-sr">{label}</span><input type="number" title={label} min={min} max={max} step={1} value={draft} onChange={event=>{
    const text=event.target.value;setDraft(text);
    const next=Number(text);
    if(text.trim()!==''&&Number.isInteger(next)&&next>=min&&next<=max)onValue(next);
  }}/></label>;
}
/** A numeric speed field (10% to 300%). Enter or blur commits; Escape restores the shown value.
 * Values out of range or not a number show an inline error. */
function SpeedField({label,value,busy,unavailable,fixed,message,messageId,onValue,onMessage}:{label:string;value:number;busy:boolean;unavailable:boolean;fixed:boolean;message:string|null;messageId:string;onValue:(value:number)=>void;onMessage:(message:string|null)=>void}) {
  const {t}=useI18n();
  const [draft,setDraft]=useState(String(display(value)));
  const invalid=message!==null;
  useEffect(()=>{
    setDraft(String(display(value)));
    onMessage(null);
  },[value]);
  const commit=(text:string)=>{
    if(busy||unavailable||fixed)return;
    const shown=String(display(value));
    if(text.trim()===shown){onMessage(null);return;}
    // A decimal comma is a dot; anything else that is not plain digits (0x1F, 1e2, +50) is refused.
    const clean=text.trim().replace(/%$/,'').trim().replace(',','.');
    const num=/^\d+(\.\d+)?$/.test(clean)?Number(clean):NaN;
    if(!Number.isFinite(num)||num<10||num>300){
      onMessage(t('transport.speed_range_error'));
      return;
    }
    onMessage(null);
    if(num===value){
      setDraft(shown);
      return;
    }
    onValue(num);
  };
  const handleKeyDown=(event:React.KeyboardEvent<HTMLInputElement>)=>{
    if(event.key==='Enter'){
      event.preventDefault();
      commit(draft);
    }else if(event.key==='Escape'){
      event.preventDefault();
      event.stopPropagation();
      setDraft(String(display(value)));
      onMessage(null);
    }
  };
  const guard=busyGuard<HTMLInputElement>({
    busy,
    unavailable:unavailable||fixed,
    className:'transport-speed-input transport-speedvalue',
    onKeyDown:handleKeyDown,
  });
  return <label className="transport-speed-field"><span className="tp-sr">{label}</span>
    <input
      type="text"
      inputMode="decimal"
      title={fixed?t('transport.fixed_tempo_hint'):label}
      aria-label={label}
      readOnly={busy||unavailable||fixed}
      aria-invalid={invalid?'true':undefined}
      aria-describedby={invalid?messageId:undefined}
      {...guard}
      value={draft}
      onChange={event=>{
        if(busy||unavailable||fixed)return;
        setDraft(event.target.value);
      }}
      onBlur={()=>{
        if(busy||unavailable||fixed)return;
        commit(draft);
      }}
    /><span className="transport-speed-unit" aria-hidden="true">%</span></label>;
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
  /** Every track as "number. name", offered by the track name; picking one makes it current. */
  tracks?:readonly string[];
  trackIndex?:number;
  onTrack?:(index:number)=>void;
  /** Moves the cursor to a zero-based bar. */
  onGoTo?:(bar:number)=>void;
  /** Opens the editor for a zero-based bar's time signature and tempo. */
  onMeasure?:(bar:number)=>void;
  /** Whether the selected track's voices fill a bar. */
  completionAt?:(bar:number)=>BarCompletion;
}
/** Whether the window is too narrow for the transport row to hold every group beside the toolbar's other groups: the Key group then lives in More playback. The widths are measured per language (src/shell/toolbar-fit.ts). */
function useNarrowWindow(query:string,beforeChange:()=>void):boolean {
  const [narrow,setNarrow]=useState(()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia(query).matches);
  const before=useRef(beforeChange);before.current=beforeChange;
  useEffect(()=>{
    if(typeof window.matchMedia!=='function')return;
    const list=window.matchMedia(query),update=()=>{if(list.matches!==narrow)before.current();setNarrow(list.matches);};update();
    list.addEventListener?.('change',update);return()=>list.removeEventListener?.('change',update);
  },[narrow,query]);
  return narrow;
}
export function Transport({player,measures,busy,cursor,selection,display:lcd}: {player:Pick<NativePlaybackController,'subscribe'|'getState'|'play'|'pause'|'stop'|'setSpeed'|'setLoop'|'clearLoop'|'seekToMeasure'|'setPractice'|'stepKeyShift'|'setKeyShift'|'generation'|'cursorPlaybackChoices'|'selectionPlaybackChoices'|'playbackOccurrences'|'playFromCursor'|'playSelection'|'loopSelection'>;measures:number;busy:boolean;cursor:BeatTarget;selection:MusicSelection|null;display?:TransportDisplay}) {
  const { t,lang } = useI18n();
  const state=useSyncExternalStore(player.subscribe,player.getState);
  const occurrences=player.playbackOccurrences(),selectionAvailable=occurrences.length>0;
  const [seek,setSeek]=useState(1);const [start,setStart]=useState(1);const [end,setEnd]=useState(1);
  const [error,setError]=useState<string|null>(null);
  // The typed-speed field's own message, apart from the shared transport error so it neither clears nor is cleared by it.
  const [speedError,setSpeedError]=useState<string|null>(null),speedErrorId=useId(),keyHintId=useId();
  const [cursorChoice,setCursorChoice]=useState<CursorPlaybackChoice|null>(null),[passageChoice,setPassageChoice]=useState<PassagePlaybackChoice|null>(null),[nextStart,setNextStart]=useState<'cursor'|'position'>('cursor');
  const loop=state.loop!==null,practice=state.practice,fixed=practice.settings.tempo.kind==='fixed';
  // The two bar fields show the loop that is actually running; with none running they follow the selected bars (or the cursor's bar), so Loop repeats what the player is looking at.
  const passage=useLoopPassage(player,state),loopBars=passage?{first:passage.first,last:passage.last}:null;
  // The loop along the piece's own clock, for the strip under the position display; changes only with the loop or the plan, not per tick.
  const loopEdges=useMemo(()=>loopFractions(passage&&state.loop,occurrences),[passage,occurrences]);
  const loopNumbers=passage?loopText(passage):null;
  const [loopSaid,setLoopSaid]=useState('');
  const loopStatus=loopNumbers?t(loopNumbers.first===loopNumbers.last?'transport.loop_status_one':'transport.loop_status',{first:String(loopNumbers.first),last:String(loopNumbers.last)}):null;
  // A status line a screen reader speaks when the loop starts, changes or ends.
  // An edit rebuilds the plan: the controller says ready with no loop for a moment before it sends the loop again. "Off" is therefore said only after the loop has stayed gone for a moment (or at once when the loop notice says an edit ended it), and not at all while the plan is not ready.
  const loopEnded=state.loopNotice==='cleared';
  useEffect(()=>{
    if(!state.ready)return;
    if(loopStatus){setLoopSaid(loopStatus);return;}
    if(loopEnded){setLoopSaid(previous=>previous?t('transport.loop_status_off'):'');return;}
    const timer=setTimeout(()=>setLoopSaid(previous=>previous?t('transport.loop_status_off'):''),loopOffDelayMs);
    return()=>clearTimeout(timer);
  },[loopStatus,state.ready,loopEnded]);
  const selectedBars=useMemo(()=>{
    const bars=selection?.kind==='range'?[selection.range.start.bar,selection.range.end.bar]:selection?.kind==='bars'?[selection.firstBar,selection.lastBar]:selection?.kind==='notes'?selection.notes.map(note=>note.target.bar):[];
    if(!bars.length)bars.push(cursor.bar);
    return {first:Math.min(...bars),last:Math.max(...bars)};
  },[selection,cursor.bar]);
  useEffect(()=>{if(!loopBars)return;setStart(loopBars.first+1);setEnd(loopBars.last+1);},[loopBars?.first,loopBars?.last]);
  useEffect(()=>{if(state.loop)return;setStart(Math.min(selectedBars.first+1,Math.max(1,measures)));setEnd(Math.min(selectedBars.last+1,Math.max(1,measures)));},[selectedBars.first,selectedBars.last]);
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
  const stepSpeed=(direction:-1|1)=>{const next=speeds[speedIndex+direction];if(next!==undefined){setSpeedError(null);act(()=>player.setSpeed(next));}};
  const settingsBusy=busy||state.practicePending;
  // The key shift is a session practice setting like speed: the value shown is the acknowledged one, a click sends one whole settings object, and nothing is shown or sent while a change is pending.
  const keyShift=tonalityOf(practice.settings),keyFormat=new Intl.NumberFormat(lang,{signDisplay:'exceptZero'}),keyTarget=state.keyTarget??keyShift;
  // A key step is the player's to coalesce: while a change is pending, further steps add up into one request, so the buttons stay available (focus is kept) and the limits follow the key asked for.
  const keyBefore=useRef(keyShift),serialBefore=useRef(state.documentSerial),keyNoticeCount=useRef(0),[keySaid,setKeySaid]=useState('');
  // Every acknowledged change of the key is announced, whether or not a request was in view (a late echo or a key carried over an edit lands without one); a key that resets because the document changed is not. A repeated identical message is made different, or a screen reader would not say it again.
  const say=(text:string)=>setKeySaid(text+(keyNoticeCount.current++%2?'\u200b':''));
  useEffect(()=>{if(keyBefore.current!==keyShift){keyBefore.current=keyShift;const switched=serialBefore.current!==state.documentSerial;serialBefore.current=state.documentSerial;if(!switched)say(t('transport.key_announced',{value:keyFormat.format(keyShift)}));}else serialBefore.current=state.documentSerial;},[keyShift,state.documentSerial]);
  useEffect(()=>{if(state.practiceNotice==='key_shift_refused')say(t('transport.key_refused',{value:keyFormat.format(keyShift)}));},[state.practiceNotice]);
  // Crossing the breakpoint moves the Key group (it remounts); a key button that held focus gets it back, in More playback if that is where the group now is.
  const refocus=useRef<string|null>(null);
  const compactRow=useNarrowWindow(keyFoldQuery(lang),()=>{const held=root.current?.querySelector('.transport-key')?.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.action:undefined;refocus.current=held??null;});
  useLayoutEffect(()=>{
    const action=refocus.current;if(!action)return;refocus.current=null;
    const details=root.current?.querySelector<HTMLDetailsElement>('.transport-more');if(compactRow&&details)details.open=true;
    const target=root.current?.querySelector<HTMLElement>(`.transport-key [data-action="${action}"]`)??details?.querySelector<HTMLElement>('summary');target?.focus();
  },[compactRow]);
  const shownBar=Math.min(Math.max(0,measures-1),Math.max(0,scrub!==null?scrub-1:state.measure));
  const stepBar=(bar:number)=>{if(busy)return;const next=Math.min(Math.max(0,bar),Math.max(0,measures-1));if(act(()=>player.seekToMeasure(next)))setNextStart('position');};
  const [goToOpen,setGoToOpen]=useState(false),[goToValue,setGoToValue]=useState(1),goToButton=useRef<HTMLButtonElement>(null),goToForm=useRef<HTMLFormElement>(null),moreRef=useRef<HTMLDetailsElement>(null);
  const closeGoTo=()=>{setGoToOpen(false);goToButton.current?.focus();};
  useEffect(()=>{if(!goToOpen)return;const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!goToForm.current?.contains(target)&&!goToButton.current?.contains(target))setGoToOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[goToOpen]);
  // In the toolbar the feedback line hangs under the transport, where the More playback panel also opens. The panel starts below it.
  const root=useRef<HTMLDivElement>(null),messages=useRef<HTMLDivElement>(null),keyPendingOnly=state.practicePending&&state.keyTarget!==undefined&&state.keyTarget!==keyShift,hasMessages=!!(state.practicePending&&!keyPendingOnly||state.practiceNotice||state.loopNotice||speedError||error||state.error||!state.ready&&!state.error);
  useLayoutEffect(()=>{const host=root.current,line=messages.current;if(!host)return;const place=()=>{const height=line&&getComputedStyle(line).position==='absolute'?Math.ceil(line.getBoundingClientRect().height):0;host.style.setProperty('--transport-messages-h',`${height}px`);};place();if(!line||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(place);observer.observe(line);return()=>observer.disconnect();},[hasMessages]);
  const completion=lcd?.completionAt?.(shownBar)??null;
  const completionText=!completion?'':completion.kind==='complete'?t('transport.bar_complete'):completion.kind==='empty'?t('transport.bar_empty'):t(completion.kind==='short'?'transport.voice_short':'transport.voice_long',{voice:completion.voice});
  const meta=(text:string,hint:string)=>lcd?.onMeasure?<button type="button" title={hint} aria-label={hint} {...busyGuard({busy,className:'transport-lcd-link',onClick:()=>lcd.onMeasure!(shownBar)})}>{text}</button>:<span aria-label={hint}>{text}</span>;
  const barButton=(label:string,bar:number,glyph:React.JSX.Element,unavailable:boolean)=><button {...busyGuard({busy,unavailable,className:'transport-barstep',onClick:()=>stepBar(bar)})} title={label} aria-label={label}>{glyph}</button>;
  const keyGroup=<div className="transport-group transport-key" role="group" aria-label={t('transport.key')} aria-describedby={keyHintId} data-pending={state.practicePending||undefined}><span className="transport-caption">{t('transport.key')}</span><span id={keyHintId} className="tp-sr">{t('transport.key_hint')}</span>{keyPendingOnly&&<span className="tp-sr">{t('transport.applying_practice')}</span>}
      <div className="transport-row"><button {...busyGuard({busy,unavailable:!state.ready||keyTarget<=-12,className:'transport-step',onClick:()=>act(()=>player.stepKeyShift(-1))})} title={t('transport.key_lower')} data-action="key-lower"><MinusGlyph/><span className="tp-sr">{t('transport.key_lower')}</span></button>
        <output className="transport-keyvalue" role="status" aria-label={t('transport.key_value')} aria-live="off" title={t('transport.key_hint')}>{keyFormat.format(keyShift)}</output>
        <button {...busyGuard({busy,unavailable:!state.ready||keyTarget>=12,className:'transport-step',onClick:()=>act(()=>player.stepKeyShift(1))})} title={t('transport.key_raise')} data-action="key-raise"><PlusGlyph/><span className="tp-sr">{t('transport.key_raise')}</span></button>
        <button {...busyGuard({busy,unavailable:!state.ready||keyTarget===0,className:'transport-step transport-keyreset',onClick:()=>act(()=>player.setKeyShift(0))})} title={t('transport.key_reset')} data-action="key-reset"><span aria-hidden="true">♮</span><span className="tp-sr">{t('transport.key_reset')}</span></button></div>
    </div>;
  return <div ref={root} className="transport" role="group" aria-label={t('transport.aria_label')}><input type="range" className="transport-scrub" aria-label={t('transport.playback_position')} min={1} max={Math.max(1,measures)} step={1} value={scrub??Math.min(Math.max(1,measures),Math.max(1,state.measure+1))} disabled={!state.ready} aria-disabled={busy||undefined} aria-valuetext={t('transport.bar_x_of_y', { current: scrub ?? state.measure + 1, total: measures })} style={{'--progress':state.endTime>0?Math.min(1,Math.max(0,state.time/state.endTime)):0} as React.CSSProperties} onPointerDown={()=>{dragging.current=true;}} onPointerUp={()=>{dragging.current=false;commitScrub();}} onPointerCancel={()=>{dragging.current=false;setScrub(null);}} onBlur={()=>{if(!dragging.current)setScrub(null);}} onChange={event=>{if(busy)return;const value=Number(event.target.value);setScrub(value);if(!dragging.current)commitScrub(value);}}/><span className="tp-sr transport-key-said" role="status" aria-live="polite">{keySaid}</span><div className="transport-primary"><fieldset className="transport-fields" disabled={!state.ready}>
    <div className="transport-group transport-play">
      <span className="transport-barnav" role="group" aria-label={t('transport.bar_navigation')}>{barButton(t('transport.first_bar'),0,<FirstBarGlyph/>,shownBar<=0)}{barButton(t('transport.previous_bar'),shownBar-1,<PreviousBarGlyph/>,shownBar<=0)}</span>
      <button {...busyGuard({busy:!state.playing&&(busy||fromCursor&&state.practicePending),disabled:!state.playing&&fromCursor&&!currentCursor,className:'primary transport-playbutton',onClick:()=>act(()=>state.playing?player.pause():fromCursor?player.play(cursor,currentCursor!):player.play())})} aria-keyshortcuts="Space" title={fromCursor?t('transport.play_from_cursor'):nextStart==='position'?t('transport.play_from_position'):undefined}>{state.playing?<PauseGlyph/>:<PlayGlyph/>}{state.playing?t('transport.pause'):t('transport.play')}</button>
      <button className="transport-stopbutton" title={t('transport.stop')} onClick={()=>{setNextStart('cursor');act(()=>player.stop());}}><StopGlyph/><span className="transport-label">{t('transport.stop')}</span></button>
      <span className="transport-barnav" role="group" aria-label={t('transport.bar_navigation')}>{barButton(t('transport.next_bar'),shownBar+1,<NextBarGlyph/>,shownBar>=measures-1)}{barButton(t('transport.last_bar'),measures-1,<LastBarGlyph/>,shownBar>=measures-1)}</span>
    </div>
    <div className={`transport-group transport-position${lcd?' transport-lcd':''}`} role={lcd?'group':undefined} aria-label={lcd?t('transport.position_display'):undefined} data-loop={lcd&&loopNumbers?'true':undefined} style={lcd?{'--lcd-track':lcd.color??'transparent','--lcd-progress':`${state.endTime>0?Math.min(100,Math.max(0,state.time/state.endTime*100)):0}%`,...(loopNumbers&&loopEdges?{'--lcd-loop-from':`${loopEdges.from*100}%`,'--lcd-loop-size':`${(loopEdges.to-loopEdges.from)*100}%`}:{})} as CSSProperties:undefined}>
      {lcd&&(lcd.tracks&&lcd.onTrack?<select className="transport-lcd-track" aria-label={t('transport.current_track')} title={t('transport.current_track_hint')} value={lcd.trackIndex??0} aria-disabled={busy||undefined} onChange={event=>{if(!busy)lcd.onTrack!(Number(event.target.value));}}>{lcd.tracks.map((label,index)=><option key={index} value={index}>{label}</option>)}</select>:<span className="transport-lcd-track" title={lcd.track}>{lcd.track}</span>)}
      {lcd?.onGoTo?<span className="transport-lcd-bar"><button ref={goToButton} type="button" data-action="go-to-bar" title={t('transport.bar_position_hint')} aria-expanded={goToOpen} aria-haspopup="dialog" {...busyGuard({busy,className:'transport-caption transport-bar-number transport-lcd-link',onClick:()=>{setGoToValue(shownBar+1);setGoToOpen(open=>!open);}})}><span>{t('transport.bar_n', { number: scrub ?? state.measure + 1 })}</span><span className="transport-dim transport-of">{t('transport.of_n', { total: measures })}</span></button>
        {goToOpen&&<form ref={goToForm} className="transport-goto" role="dialog" aria-label={t('transport.go_to_bar')} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();closeGoTo();}}} onSubmit={event=>{event.preventDefault();if(busy)return;const bar=Math.min(Math.max(1,Math.round(goToValue)||1),measures)-1;stepBar(bar);lcd.onGoTo!(bar);closeGoTo();}}>
          <label>{t('transport.go_to_bar')}<input type="number" autoFocus min={1} max={measures} value={goToValue} onChange={event=>setGoToValue(Number(event.target.value))}/></label>
          <button type="submit" className="primary" aria-disabled={busy||undefined}>{t('transport.go')}</button></form>}</span>
      :<span className="transport-caption transport-bar-number"><span>{t('transport.bar_n', { number: scrub ?? state.measure + 1 })}</span><span className="transport-dim transport-of">{t('transport.of_n', { total: measures })}</span></span>}
      {lcd&&loopNumbers&&<span className="transport-lcd-loop" title={t('transport.loop_position_hint',{first:String(loopNumbers.first),last:String(loopNumbers.last)})}><LoopGlyph/>{loopNumbers.first===loopNumbers.last?t('transport.loop_chip_one',{first:String(loopNumbers.first)}):t('transport.loop_chip',{first:String(loopNumbers.first),last:String(loopNumbers.last)})}</span>}
      <output aria-live="off" className="transport-time"><span>{clock(state.time)}</span><span className="transport-dim"> / {clock(state.endTime)}</span></output>
      {lcd&&<span className="transport-lcd-meta">{completion&&<span className="transport-lcd-completion" data-kind={completion.kind} role="img" aria-label={completionText} title={completionText}>{completion.kind==='complete'?'✓':'!'}</span>}
        {meta(lcd.signatureAt(shownBar),t('transport.signature_hint',{value:lcd.signatureAt(shownBar)}))}
        {meta(practice.currentBpm>0?`♩ = ${Math.round(practice.currentBpm)}`:'♩ = –',t('transport.tempo_hint',{value:practice.currentBpm>0?String(Math.round(practice.currentBpm)):'–'}))}</span>}
    </div>
    <div className="transport-group transport-loop" role="group" aria-label={t('transport.loop')}><span className="transport-caption">{t('transport.loop_bars')}</span><span className="tp-sr" role="status" aria-live="polite">{loopSaid}</span>
      <div className="transport-row"><BarField label={t('transport.loop_start')} min={1} max={measures} value={start} onValue={setStart}/><span className="transport-dash" aria-hidden="true"/><BarField label={t('transport.loop_end')} min={1} max={measures} value={end} onValue={setEnd}/>
        <button {...busyGuard({busy,unavailable:state.practicePending,className:'transport-toggle transport-loopbutton',onClick:()=>act(()=>loop?player.clearLoop():player.setLoop(start-1,end-1))})} title={loop?t('transport.clear_loop'):t('transport.loop_range_hint',{start:String(start),end:String(end)})} aria-pressed={loop} data-action="loop" aria-keyshortcuts="Shift+L"><LoopGlyph/>{loop?t('transport.clear_loop'):t('transport.loop')}</button>
        {selection&&passageChoices.length>0&&<button {...busyGuard({busy,unavailable:state.practicePending||!selectionAvailable,className:'transport-toggle transport-loopbutton transport-loopselection',onClick:()=>act(()=>{const choice=currentPassage??passageChoices[0];if(selection&&choice)player.loopSelection(selection,choice);})})} title={t('transport.loop_selection')} aria-label={t('transport.loop_selection')} data-action="loop-selection"><LoopGlyph/>{t('transport.loop_selection')}</button>}
      </div>
    </div>
    <div className="transport-group transport-click"><span className="transport-caption">{t('transport.click')}</span>
      <label className="transport-toggle transport-metronome" title={t('transport.metronome')} data-on={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined}><input type="checkbox" checked={practice.settings.metronome.enabled} aria-disabled={settingsBusy||undefined} onChange={e=>{if(settingsBusy)return;act(()=>{const settings=structuredClone(practice.settings);settings.metronome.enabled=e.target.checked;player.setPractice(settings);});}}/><MetronomeGlyph/><span className="transport-label">{t('transport.metronome')}</span></label>
    </div>
    <div className="transport-group transport-speed" role="group" aria-label={t('transport.speed')}><span className="transport-caption">{t('transport.speed')}<span className="transport-tempo" role="status" aria-label={t('transport.practice_playback')} aria-live="off">{practice.currentBpm>0?`${display(practice.currentBpm)} BPM`:t('transport.tempo_unavailable')}<span className="tp-sr"> · {display(practice.effectiveRatio*100)}%</span></span></span>
      <div className="transport-row"><button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex<=0,className:'transport-step',onClick:()=>stepSpeed(-1)})} title={fixed?t('transport.fixed_tempo_hint'):t('transport.slower')} data-action="slower" aria-keyshortcuts="["><MinusGlyph/><span className="tp-sr">{t('transport.slower')}</span></button>
        <SpeedField label={t('transport.speed_field')} value={state.speed} busy={busy} unavailable={state.practicePending} fixed={fixed} message={speedError} messageId={speedErrorId} onValue={speed=>act(()=>player.setSpeed(speed))} onMessage={setSpeedError}/>
        <button {...busyGuard({busy,unavailable:state.practicePending||fixed||speedIndex>=speeds.length-1,className:'transport-step',onClick:()=>stepSpeed(1)})} title={fixed?t('transport.fixed_tempo_hint'):t('transport.faster')} data-action="faster" aria-keyshortcuts="]"><PlusGlyph/><span className="tp-sr">{t('transport.faster')}</span></button></div>
    </div>
    </fieldset>
    {!compactRow&&keyGroup}
    <details ref={moreRef} className="transport-more" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary className={compactRow&&keyShift!==0?'has-key':undefined}>{t('transport.more_playback')}{(error||state.error||cursorError||passageError)?t('transport.error_suffix'):''}<MoreGlyph/>{compactRow&&keyShift!==0&&' '}{compactRow&&keyShift!==0&&<span className="transport-keymark" role="img" aria-label={t('transport.key_announced',{value:keyFormat.format(keyShift)})}>♮ {keyFormat.format(keyShift)}</span>}</summary><div className="transport-more-content">{compactRow&&keyGroup}<fieldset disabled={!state.ready}>
      <BarField label={t('transport.seek_measure')} min={1} max={measures} value={seek} onValue={setSeek}/><button {...busyGuard({busy,onClick:()=>{if(act(()=>player.seekToMeasure(seek-1)))setNextStart('position');}})}>{t('transport.seek')}</button>
      <span role="status" aria-label={t('transport.practice_passes')} aria-live="off">{t('transport.completed_passes', { count: practice.completedPasses })}</span>
    {practice.pulse&&<span role="status" aria-label={t('transport.metronome_pulse')} aria-live="off" data-pulse-serial={practice.pulse.serial}>{practice.pulse.counting?t('transport.count_in_beat'):t('transport.beat')} {practice.pulse.beat+1} {t('transport.of')} {practice.pulse.beatsPerBar}{practice.pulse.accent?t('transport.accent'):''}</span>}
    </fieldset><SelectionPlaybackControls cursorChoices={cursorChoices} passageChoices={passageChoices} occurrences={occurrences} cursorChoice={currentCursor} passageChoice={currentPassage} disabled={!state.ready||startDisabled} onCursorChoice={setCursorChoice} onPassageChoice={setPassageChoice} onPlayCursor={()=>{setNextStart('cursor');if(currentCursor)act(()=>player.playFromCursor(cursor,currentCursor));}} onPlaySelection={()=>{setNextStart('cursor');if(selection&&currentPassage)act(()=>player.playSelection(selection,currentPassage));}} onLoopSelection={()=>{if(selection&&currentPassage){act(()=>player.loopSelection(selection,currentPassage));if(moreRef.current)moreRef.current.open=false;}}}/>
    {(cursorError||passageError)&&<p role="status">{cursorError||passageError}</p>}{state.range&&<p role="status" aria-label={t('transport.selected_range')} data-start-tick={state.range.startTick} data-end-tick={state.range.endTick}>{t('transport.selected_passage')} · {practice.phase==='ended'?t('transport.finished'):practice.phase==='countIn'?t('transport.counting_in'):state.playing?t('transport.playing'):t('transport.paused')}</p>}{counting&&<p role="status" aria-label={t('transport.count_in')}>{practice.phase==='paused'?t('transport.count_in_paused'):t('transport.count_in')} · {t('transport.pulses_remaining', { count: practice.countInRemaining })}</p>}
    </div></details></div>
    {(state.practicePending&&!keyPendingOnly||state.practiceNotice||state.loopNotice||speedError||error||state.error||!state.ready&&!state.error)&&<div ref={messages} className="transport-messages">{state.practicePending&&!keyPendingOnly&&<span className="transport-feedback">{t('transport.applying_practice')}</span>}{state.practiceNotice==='fixed_tempo_backing_range'&&<p className="transport-feedback">{t('transport.fixed_tempo_backing_range')}</p>}{state.practiceNotice==='key_shift_refused'&&<p className="transport-feedback">{t('transport.key_refused',{value:keyFormat.format(keyShift)})}</p>}{state.practiceNotice==='practice_unconfirmed'&&<p className="transport-feedback" role="status">{t('transport.practice_unconfirmed')}</p>}{state.loopNotice&&<p className="transport-feedback" role="status">{t('transport.loop_cleared_by_edit')}</p>}{speedError&&<p id={speedErrorId} className="transport-feedback" role="alert">{speedError}</p>}{(error||state.error) && <p className="transport-feedback" role="alert">{error||state.error}</p>}{!state.ready && !state.error && <span className="transport-feedback">{t('transport.loading_audio')}</span>}</div>}</div>;
}
