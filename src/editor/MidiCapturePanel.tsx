import './midi-capture-panel.css';
import { useEffect,useRef,useState } from 'react';
import { nativeMidiIn,type MidiChord,type MidiInBridge } from '../audio/midi-in';
import { useI18n,type MessageKey } from '../i18n';
import { formatPitch } from '../tuning';
import { busyGuard,busySelect } from '../ui/useBusyGuard';
import { CHORD_WINDOW_MAX,CHORD_WINDOW_MIN,VELOCITY_MAX,VELOCITY_MIN,readMidiCapturePreferences,saveMidiCapturePreferences,type MidiCapturePreferences } from './midi-capture-preferences';
import { midiCaptureSession,useMidiCaptureBadge,useMidiCaptureState } from './midi-capture-session';

/** The toolbar's sign that MIDI input is on, and that it was lost: the dot changes and a live region says so, with the View menu closed. */
export function MidiCaptureIndicator({bridge=nativeMidiIn}:MidiCapturePanelProps):React.JSX.Element {
  const {t}=useI18n();
  const badge=useMidiCaptureBadge(midiCaptureSession(bridge));
  const label=badge==='lost'?t('midi_in.indicator_lost'):t('midi_in.indicator');
  return <>
    {badge!=='off'&&<span className={badge==='lost'?'midi-in-badge is-lost':'midi-in-badge'} role="img" aria-label={label} title={label}/>}
    <span className="tp-sr" aria-live="polite">{badge==='lost'?t('midi_in.indicator_lost'):''}</span>
  </>;
}
export interface MidiCapturePanelProps {
  bridge?:MidiInBridge;
}
/** The pitches, velocities and channels (counted from 1) of a chord, each in the order they were played. */
export function describeChord(chord:MidiChord):{notes:string;velocity:string;channel:string} {
  return {
    notes:chord.notes.map(note=>formatPitch(note.key)).join(' '),
    velocity:chord.notes.map(note=>note.velocity).join(', '),
    channel:[...new Set(chord.notes.map(note=>note.channel+1))].sort((a,b)=>a-b).join(', '),
  };
}

/** The native side words a refused Start with a code before the English text, so the page can say it in the player's language. */
function startError(message:string,port:string,t:(key:MessageKey,params?:Record<string,string|number>)=>string):string {
  const code=/^(open_pending|open_stuck|open_busy_stuck|open_busy):/.exec(message)?.[1];
  if(code==='open_pending')return t('midi_in.open_pending',{port});
  if(code==='open_stuck')return t('midi_in.open_stuck',{port});
  if(code==='open_busy_stuck')return t('midi_in.open_busy_stuck');
  if(code==='open_busy')return t('midi_in.open_busy');
  return t('midi_in.failed',{error:message});
}
/**
 * Listens to a MIDI keyboard or MIDI guitar and shows the last chord it played (THE-70). Choosing an input opens nothing:
 * the port is opened only when Start is pressed, never at launch and never because an input is remembered. The session
 * lives outside the panel, so listening carries on while the View menu is closed.
 */
export function MidiCapturePanel({bridge=nativeMidiIn}:MidiCapturePanelProps):React.JSX.Element {
  const {t}=useI18n();
  const session=midiCaptureSession(bridge);
  const state=useMidiCaptureState(session);
  const [preferences,setPreferences]=useState(()=>readMidiCapturePreferences());
  const root=useRef<HTMLDetailsElement>(null);
  // Listing creates a system MIDI client, so it waits until the player opens this section (or presses Refresh).
  useEffect(()=>{
    void session.attach();
    const details=root.current;
    const list=()=>{const {ports,listError}=session.get();if(ports===null||listError)void session.refresh();};
    if(!details){list();return;}
    if(details.open)list();
    const toggled=()=>{if(details.open)list();};
    details.addEventListener('toggle',toggled);
    return ()=>details.removeEventListener('toggle',toggled);
  },[session]);
  const change=(next:Partial<MidiCapturePreferences>)=>setPreferences(old=>{const merged={...old,...next};saveMidiCapturePreferences(merged);return merged;});
  const sensitivity=(next:Partial<MidiCapturePreferences>)=>{
    const merged={...preferences,...next};
    change(next);
    session.configure({chordWindowMs:merged.chordWindowMs,minVelocity:merged.minVelocity});
  };
  const running=state.phase==='running',starting=state.phase==='starting';
  const known=state.ports?.some(port=>port.name===preferences.port)??false;
  const toggle=()=>{
    if(running)void session.stop();
    else void session.start(preferences.port,{chordWindowMs:preferences.chordWindowMs,minVelocity:preferences.minVelocity});
  };
  const chord=state.last?describeChord(state.last):null;
  const port=state.port||preferences.port;
  const status=state.phase==='running'?t('midi_in.running',{port})
    :state.phase==='starting'?t('midi_in.starting')
    :state.phase==='lost'?t('midi_in.lost',{port})
    :state.phase==='stopped'?t('midi_in.idle'):'';
  return <details ref={root} className="input-preferences midi-capture-panel" data-menu-keep=""><summary>{t('midi_in.title')}</summary>
    <label>{t('midi_in.input')}<select value={preferences.port} {...busySelect(running||starting)} onChange={event=>{if(!running&&!starting)change({port:event.target.value});}}>
      <option value="">{t('midi_in.choose')}</option>
      {state.ports?.map(entry=><option key={entry.id} value={entry.name}>{entry.name}</option>)}
      {preferences.port&&!known&&<option value={preferences.port}>{state.ports?t('midi_out.missing',{name:preferences.port}):preferences.port}</option>}
    </select></label>
    <button type="button" {...busyGuard({busy:false,onClick:()=>{void session.refresh(true);}})}>{t('midi_out.refresh')}</button>
    <button type="button" {...busyGuard({busy:starting,unavailable:!running&&!preferences.port,onClick:toggle})}>{running?t('midi_in.stop'):t('midi_in.start')}</button>
    <label>{t('midi_in.window')}<input type="range" min={CHORD_WINDOW_MIN} max={CHORD_WINDOW_MAX} step={5} value={preferences.chordWindowMs} aria-valuetext={t('midi_in.window_ms',{ms:preferences.chordWindowMs})} onChange={event=>sensitivity({chordWindowMs:Number(event.target.value)})}/><output>{t('midi_in.window_ms',{ms:preferences.chordWindowMs})}</output></label>
    <p className="hint">{t('midi_in.window_hint')}</p>
    <label>{t('midi_in.velocity')}<input type="range" min={VELOCITY_MIN} max={VELOCITY_MAX} step={1} value={preferences.minVelocity} onChange={event=>sensitivity({minVelocity:Number(event.target.value)})}/><output>{preferences.minVelocity}</output></label>
    <p className="hint">{t('midi_in.velocity_hint')}</p>
    {status&&<p className="hint" role="status">{status}</p>}
    {state.phase==='error'&&<p role="alert">{startError(state.message,port,t)}</p>}
    {running&&<p className="midi-capture-last">{chord?t('midi_in.last_chord',chord):t('midi_in.no_chord')}</p>}
    {state.blocked&&<p className="hint">{t('midi_in.blocked_menu')}</p>}
    {/* The number changes with every lost chord, so it is not live; the fixed line is announced once, when the first chord is lost. */}
    {state.notWritten>0&&<p className="hint">{t(`midi_in.not_written_${state.notWritten===1?'one':'other'}` as MessageKey,{count:state.notWritten})}</p>}
    <span className="tp-sr" aria-live="polite">{state.notWritten>0?t('midi_in.not_written_alert'):''}</span>
    {state.dropped>0&&<p className="hint">{t('midi_in.dropped',{count:state.dropped})}</p>}
    {state.unavailable&&<p className="hint" role="status">{t('midi_in.unavailable',{error:state.unavailable})}</p>}
    {state.listError&&<p className="hint" role={state.listAlert?'alert':'status'}>{t('midi_out.ports_failed',{error:state.listError})}</p>}
    {state.problem&&<p role="alert">{t('midi_in.problem',{error:state.problem})}</p>}
    <p className="hint">{t('midi_in.hint')}</p>
  </details>;
}
