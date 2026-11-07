import { useEffect,useRef,useState } from 'react';
import './tuner-panel.css';
import { useI18n } from '../i18n';
import { busyGuard } from '../ui/useBusyGuard';
import { IN_TUNE_CENTS,REFERENCE_RANGE,centsBetween,frequencyOf,nativeTuner,nearestNote,noteName,type TunerBridge,type TunerInput,type TunerReading } from './tuner';

export interface TunerPanelProps {
  /** The selected staff's open strings as MIDI notes, highest string first; empty for percussion. */
  tuning:readonly number[];
  bridge?:TunerBridge;
  /** How often the reading is refreshed while listening, in milliseconds. */
  interval?:number;
}
type Mode='chromatic'|'strings';
/** Below this level, in dBFS, the input is treated as silent; after `SILENT_MS` of it the panel says so. */
const SILENT_DB=-90,SILENT_MS=1000;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** A chromatic tuner, and a polyphonic one that checks every open string of the selected track at once. */
export function TunerPanel({tuning,bridge=nativeTuner,interval=100}:TunerPanelProps):React.JSX.Element {
  const {t,lang}=useI18n(),[inputs,setInputs]=useState<TunerInput[]|null>(null),[input,setInput]=useState(''),[mode,setMode]=useState<Mode>('chromatic');
  const [reference,setReference]=useState('440'),[running,setRunning]=useState(false),[pending,setPending]=useState(false),[reading,setReading]=useState<TunerReading|null>(null),[error,setError]=useState('');
  const a4=Number(reference),validReference=Number.isFinite(a4)&&a4>=REFERENCE_RANGE[0]&&a4<=REFERENCE_RANGE[1],concert=validReference?a4:440;
  const shownMode:Mode=tuning.length?mode:'chromatic';
  const targets=shownMode==='strings'?tuning.map(midi=>frequencyOf(midi,concert)):[];
  const targetsRef=useRef(targets);targetsRef.current=targets;
  // What native capture is doing, kept outside render so async steps and the unmount see the latest.
  const readFailed=useRef(false);
  const live=useRef({mounted:true,running:false,starting:0,active:'',wanted:'',session:null as number|null,stopWanted:false,silentSince:null as number|null});
  const details=useRef<HTMLDetailsElement>(null),[silent,setSilent]=useState(false);
  const cents=new Intl.NumberFormat(lang,{minimumFractionDigits:1,maximumFractionDigits:1,signDisplay:'exceptZero'});
  const stopCapture=()=>{const state=live.current;state.running=false;state.stopWanted=false;setRunning(false);setReading(null);setSilent(false);const session=state.session;state.session=null;return bridge.stop(session);};
  // Stop listening when the panel goes away, including while a start is still on its way.
  useEffect(()=>{const state=live.current;state.mounted=true;return ()=>{state.mounted=false;if(state.running&&state.session!==null){state.running=false;void bridge.stop(state.session).catch(()=>{});}};},[bridge]);
  useEffect(()=>{
    if(!running)return;
    let active=true,timer:ReturnType<typeof setTimeout>|null=null;
    const poll=async()=>{
      try{
        const next=await bridge.read(targetsRef.current);if(!active)return;
        // A restart in progress briefly reads as stopped; only a settled stop ends listening.
        if(!next.running&&live.current.starting===0){live.current.running=false;live.current.session=null;setRunning(false);setReading(null);setSilent(false);if(next.error)setError(t('tuner.stopped',{error:next.error}));return;}
        // A start or a pause between notes is briefly quiet; only lasting silence earns the hint.
        const state=live.current,now=Date.now();
        if(next.level<=SILENT_DB)state.silentSince??=now;else state.silentSince=null;
        setSilent(state.silentSince!==null&&now-state.silentSince>=SILENT_MS);
        setReading(next);
        if(readFailed.current){readFailed.current=false;setError('');}
      }catch(reason){if(!active)return;readFailed.current=true;setError(t('tuner.failed',{error:message(reason)}));}
      if(active)timer=setTimeout(()=>{void poll();},interval);
    };
    void poll();
    return ()=>{active=false;if(timer!==null)clearTimeout(timer);};
  },[running,bridge,interval,t]);
  /** Lists the inputs each time the section opens, so a newly plugged-in interface appears. The current choice is kept while it is still there, and always while listening. */
  const loadInputs=()=>{bridge.inputs().then(list=>{if(!live.current.mounted)return;setInputs(list);setInput(current=>{const kept=live.current.running||list.some(entry=>entry.id===current);const chosen=kept?current:(list.find(entry=>entry.default)??list[0])?.id||'';live.current.wanted=chosen;return chosen;});}).catch(reason=>{if(!live.current.mounted)return;setInputs(current=>current??[]);setError(t('tuner.failed',{error:message(reason)}));});};
  /** Starts capture on the wanted input, and again while the wanted input changed during a start. */
  const startCapture=async()=>{
    const state=live.current;
    do{
      const id=state.wanted;state.starting++;let session:number;
      try{session=await bridge.start(id||null);}finally{state.starting--;}
      state.active=id;state.session=session;state.silentSince=null;
      // Gone, collapsed or hidden while starting: end this capture.
      if(!state.mounted||state.stopWanted){state.stopWanted=false;state.session=null;state.running=false;await bridge.stop(session);if(state.mounted){setRunning(false);setReading(null);}return;}
      state.running=true;setRunning(true);
    }while(state.wanted!==state.active);
  };
  const run=async(step:()=>Promise<void>)=>{
    setPending(true);setError('');
    try{await step();}
    catch(reason){live.current.stopWanted=false;if(!live.current.mounted)return;const session=live.current.session;live.current.running=false;live.current.session=null;setRunning(false);setReading(null);setError(t('tuner.failed',{error:message(reason)}));if(session!==null)void bridge.stop(session).catch(()=>{});}
    finally{if(live.current.mounted)setPending(false);}
  };
  const toggle=()=>{if(pending)return;void run(()=>{if(live.current.running)return stopCapture();live.current.stopWanted=false;return startCapture();});};
  const chooseInput=(id:string)=>{
    setInput(id);live.current.wanted=id;
    // A start in progress picks the new choice up when it finishes.
    if(pending||!live.current.running)return;
    void run(startCapture);
  };
  /** Stops listening once nothing on screen shows the tuner: its section, or any section around it, collapsed. */
  const hidden=()=>{const state=live.current;if(state.starting>0){state.stopWanted=true;return;}if(state.running&&!pending)void run(stopCapture);};
  const hiddenRef=useRef(hidden);hiddenRef.current=hidden;
  useEffect(()=>{
    const own=details.current;if(!own)return;
    const around:HTMLDetailsElement[]=[];for(let at:HTMLElement|null=own.parentElement;at;at=at.parentElement)if(at instanceof HTMLDetailsElement)around.push(at);
    const check=()=>{if(!own.open||around.some(entry=>!entry.open))hiddenRef.current();};
    for(const entry of around)entry.addEventListener('toggle',check);
    return ()=>{for(const entry of around)entry.removeEventListener('toggle',check);};
  },[]);
  const pitch=running?reading?.pitch??null:null,note=pitch?nearestNote(pitch.frequency,concert):null;
  const inTune=note!==null&&Math.abs(note.cents)<=IN_TUNE_CENTS;
  const shown=(value:number)=>Math.abs(value)<=IN_TUNE_CENTS?t('tuner.in_tune'):t('tuner.cents',{cents:cents.format(value)});
  return <details ref={details} onToggle={event=>{if((event.currentTarget as HTMLDetailsElement).open)loadInputs();else hidden();}}><summary>{t('tuner.title')}</summary>
    <div className="tuner">
      <label>{t('tuner.input')}<select value={input} onChange={event=>chooseInput(event.target.value)}>
        {inputs===null&&<option value="">{t('tuner.input_loading')}</option>}
        {inputs?.length===0&&<option value="">{t('tuner.input_none')}</option>}
        {inputs?.map(entry=><option key={entry.id} value={entry.id}>{entry.default?t('tuner.input_default',{name:entry.name}):entry.name}</option>)}
      </select></label>
      <label>{t('tuner.mode')}<select value={shownMode} onChange={event=>setMode(event.target.value as Mode)}>
        <option value="chromatic">{t('tuner.mode.chromatic')}</option>
        <option value="strings" disabled={!tuning.length}>{t('tuner.mode.strings')}</option>
      </select></label>
      <label>{t('tuner.reference')}<input type="number" min={REFERENCE_RANGE[0]} max={REFERENCE_RANGE[1]} step="any" value={reference} aria-invalid={!validReference||undefined} onChange={event=>setReference(event.target.value)}/></label>
      {!validReference&&<p role="alert">{t('tuner.reference_range',{low:REFERENCE_RANGE[0],high:REFERENCE_RANGE[1]})}</p>}
      <button type="button" aria-pressed={running} {...busyGuard({busy:pending,onClick:toggle})}>{running?t('tuner.stop'):t('tuner.start')}</button>
      {/* Announce only the note and whether it is in tune, not every cents update. */}
      <span className="tuner-sr-only" role="status">{running&&shownMode==='chromatic'&&note?`${note.name}${inTune?`, ${t('tuner.in_tune')}`:''}`:''}</span>
      {running&&shownMode==='chromatic'&&<div className="tuner-reading">
        {note?<>
          <strong className={inTune?'tuner-note in-tune':'tuner-note'}>{note.name}</strong>
          <meter min={-50} max={50} low={-IN_TUNE_CENTS} high={IN_TUNE_CENTS} optimum={0} value={note.cents} aria-label={t('tuner.cents_label')}/>
          <span>{shown(note.cents)}</span>
        </>:<span className="muted">{silent?t('tuner.silent'):t('tuner.play')}</span>}
      </div>}
      {running&&shownMode==='strings'&&<>
        <p className="muted">{t('tuner.strings_hint')}</p>
        {silent&&<p className="muted">{t('tuner.silent')}</p>}
        <table className="tuner-strings" aria-label={t('tuner.strings_label')}><tbody>
          {tuning.map((midi,index)=>{
            const measured=reading?.strings[index]??null,offset=measured===null||!targets[index]?null:Math.round(centsBetween(measured,targets[index])*10)/10;
            return <tr key={index}><th scope="row">{t('tuner.string',{number:index+1,note:noteName(midi)})}</th>
              <td className={offset!==null&&Math.abs(offset)<=IN_TUNE_CENTS?'in-tune':undefined}>{offset===null?t('tuner.string_unheard'):shown(offset)}</td></tr>;
          })}
        </tbody></table>
      </>}
      {error&&<p role="alert">{error}</p>}
    </div>
  </details>;
}
