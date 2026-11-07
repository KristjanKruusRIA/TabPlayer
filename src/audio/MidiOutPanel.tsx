import { useEffect,useState } from 'react';
import { defaultMix } from '../document-settings';
import type { ChannelMix,EditCommand } from '../edit-types';
import { useI18n } from '../i18n';
import { busyGuard,busySelect } from '../ui/useBusyGuard';
import { nativeMidiOut,type MidiOutBridge,type MidiOutOwner,type MidiOutPort,type MidiOutStatus } from './midi-out';
import { MIDI_OUT_DELAY_MAX,readMidiOutDelay,saveMidiOutDelay } from './midi-out-preferences';

export interface MidiOutPanelProps {
  trackId:string;
  /** The open score, so Refresh also moves its tracks back onto a port that has come back. */
  owner?:MidiOutOwner;
  mix?:ChannelMix;
  busy?:boolean;
  onEdit:(edit:EditCommand)=>void|Promise<void>;
  bridge?:MidiOutBridge;
  /** How often the port state is read while the track is routed; tests pass a short one. */
  interval?:number;
}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** The last port list, shared by every track's panel: listing can open ports, so it happens once and on Refresh, not on each track change. */
const portCache=new WeakMap<MidiOutBridge,MidiOutPort[]>();

/**
 * Sends the selected track to a MIDI output port instead of the internal sound (A26). The port is saved with the
 * track's mix, so choosing it is one undoable edit and travels with the score; a port that is not connected on this
 * computer leaves the track on the internal sound until it is.
 */
export function MidiOutPanel({trackId,owner,mix,busy=false,onEdit,bridge=nativeMidiOut,interval=1000}:MidiOutPanelProps):React.JSX.Element {
  const {t}=useI18n();
  const [ports,setPorts]=useState<MidiOutPort[]|null>(()=>portCache.get(bridge)??null),[listError,setListError]=useState('');
  const [status,setStatus]=useState<MidiOutStatus|null>(null),[error,setError]=useState('');
  const [delay,setDelay]=useState(()=>readMidiOutDelay());
  const current=mix?.midiPort??'';
  const load=()=>{bridge.ports(owner).then(list=>{portCache.set(bridge,list);setPorts(list);setListError('');}).catch(reason=>{setPorts(last=>last??[]);setListError(message(reason));});};
  useEffect(()=>{if(!portCache.has(bridge))load();},[bridge]);
  useEffect(()=>{
    if(!current){setStatus(null);return;}
    let live=true;
    const read=()=>{bridge.status().then(next=>{if(live)setStatus(next);}).catch(()=>{/* A missed read only delays the notice. */});};
    read();const timer=setInterval(read,interval);
    return ()=>{live=false;clearInterval(timer);};
  },[bridge,current,interval]);
  const choose=(port:string)=>{
    // Choosing the output already in use records nothing.
    if(busy||port===current)return;
    const {midiPort:_dropped,...rest}=mix??defaultMix();
    setError('');
    Promise.resolve(onEdit({type:'setTrackMix',trackId,mix:port?{...rest,midiPort:port}:rest})).catch(reason=>setError(message(reason)));
  };
  const changeDelay=(ms:number)=>{setDelay(ms);saveMidiOutDelay(ms);void bridge.setDelay(ms).catch(reason=>setError(message(reason)));};
  const known=ports?.some(port=>port.name===current)??false;
  const port=status?.ports.find(entry=>entry.name===current);
  const notice=!current||ports===null?'':!known?t('midi_out.not_connected',{port:current})
    :port?.error?t('midi_out.port_failed',{port:current,error:port.error})
    :port?.overflowTracks.includes(trackId)?t('midi_out.overflow',{port:current})
    :port?.sharedPercussion?.includes(trackId)?t('midi_out.shared_drums',{port:current})
    :port?.tracks.includes(trackId)?t('midi_out.sending',{port:current}):'';
  const problem=error?t('midi_out.change_failed',{error}):listError?t('midi_out.ports_failed',{error:listError}):'';
  return <div className="sound-panel midi-out-panel">
    <label>{t('midi_out.output')}<select value={current} {...busySelect(busy)} onChange={event=>choose(event.target.value)}>
      <option value="">{t('midi_out.internal')}</option>
      {ports?.map(entry=><option key={entry.id} value={entry.name}>{entry.name}</option>)}
      {current&&!known&&<option value={current}>{t('midi_out.missing',{name:current})}</option>}
    </select></label>
    <button type="button" {...busyGuard({busy:false,onClick:load})}>{t('midi_out.refresh')}</button>
    {current&&<label>{t('midi_out.delay')}<input type="range" min={0} max={MIDI_OUT_DELAY_MAX} step={5} value={delay} aria-valuetext={t('midi_out.delay_ms',{ms:delay})} onChange={event=>changeDelay(Number(event.target.value))}/><output>{t('midi_out.delay_ms',{ms:delay})}</output></label>}
    {current&&<p className="hint">{t('midi_out.delay_hint')}</p>}
    {notice&&<p className="hint" role="status">{notice}</p>}
    <p className="hint">{t('midi_out.hint')}</p>
    {problem&&<p role="alert">{problem}</p>}
  </div>;
}
