import { useEffect, useState, useSyncExternalStore } from 'react';
import { defaultEffects } from '../document-settings';
import type { EditCommand, FxSettings, TrackSound } from '../edit-types';
import type { NativePlaybackController } from './NativePlaybackController';
import type { AudioDeviceInfo } from './bridge';

export function soundPreset(presetId:TrackSound['presetId'],voiceId:string|null=null):TrackSound {
  const effects=defaultEffects();
  if(presetId!=='gm'){effects.amp.enabled=true;effects.cabinet.enabled=true;effects.amp.model=presetId;}
  if(presetId==='crunch'){effects.amp.drive=.4;effects.cabinet.model='closed';effects.eq.enabled=true;effects.eq.midDb=2;}
  if(presetId==='lead'){effects.amp.drive=.75;effects.cabinet.model='closed';effects.delay.enabled=true;effects.reverb.enabled=true;}
  if(presetId==='bass'){effects.amp.drive=.2;effects.cabinet.model='bass';effects.compressor.enabled=true;effects.compressor.makeupDb=3;effects.eq.enabled=true;effects.eq.lowDb=3;effects.eq.highDb=-2;}
  return {voiceId,presetId,effects};
}
type NumericControl={key:string;label:string;min:number;max:number;step:number};
const noSubscribe=()=>()=>{},noState=()=>null;
const parameters:Record<keyof FxSettings,NumericControl[]>={
  gate:[{key:'thresholdDb',label:'Threshold (dB)',min:-96,max:0,step:1},{key:'releaseMs',label:'Release (ms)',min:1,max:1000,step:1}],
  compressor:[{key:'thresholdDb',label:'Threshold (dB)',min:-60,max:0,step:1},{key:'ratio',label:'Ratio',min:1,max:20,step:.1},{key:'attackMs',label:'Attack (ms)',min:.1,max:200,step:.1},{key:'releaseMs',label:'Release (ms)',min:1,max:2000,step:1},{key:'makeupDb',label:'Makeup (dB)',min:0,max:24,step:.1}],
  amp:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'gainDb',label:'Gain (dB)',min:-24,max:24,step:.1}],cabinet:[],
  eq:[{key:'lowDb',label:'Low (dB)',min:-24,max:24,step:.1},{key:'midDb',label:'Mid (dB)',min:-24,max:24,step:.1},{key:'highDb',label:'High (dB)',min:-24,max:24,step:.1},{key:'midHz',label:'Mid frequency (Hz)',min:200,max:5000,step:10}],
  chorus:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:8,step:.1},{key:'depthMs',label:'Depth (ms)',min:0,max:20,step:.1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  delay:[{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  reverb:[{key:'room',label:'Room',min:0,max:1,step:.01},{key:'damping',label:'Damping',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
};
export function SoundPanel({trackId,sound,onEdit,playback,busy=false}:{trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean}) {
  useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const current=sound??soundPreset('gm');const [devices,setDevices]=useState<AudioDeviceInfo[]>([]);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;if(playback)void playback.devices().then(items=>{if(alive)setDevices(items);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[playback]);
  const save=(next:TrackSound)=>{void Promise.resolve(onEdit({type:'setTrackSound',trackId,sound:next})).catch(e=>setError(String(e)));};
  const fx=(block:keyof FxSettings,key:string,value:unknown)=>{const next=structuredClone(current);Object.assign(next.effects[block],{[key]:value});save(next);};
  return <section className="sound-panel"><h3>Sound</h3><fieldset disabled={busy}>
    <label>Sound source<select value={current.voiceId??''} onChange={e=>save({...current,voiceId:e.target.value||null})}><option value="">Automatic instrument</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
    <label>Sound preset<select value={current.presetId} onChange={e=>save(soundPreset(e.target.value as TrackSound['presetId'],current.voiceId))}>{['gm','clean','crunch','lead','bass'].map(id=><option value={id} key={id}>{id==='gm'?'Bypass':id[0].toUpperCase()+id.slice(1)}</option>)}</select></label>
    <button onClick={()=>save(soundPreset(current.presetId,current.voiceId))}>Restore preset</button>
    <p className="muted">Gate → compressor → amp → cabinet → EQ → chorus → delay → reverb</p>
    {(Object.keys(parameters) as (keyof FxSettings)[]).map(block=><details key={block}><summary>{block==='eq'?'EQ':block[0].toUpperCase()+block.slice(1)}</summary>
      <label className="check"><input aria-label={`Enable ${block}`} type="checkbox" checked={current.effects[block].enabled} onChange={e=>fx(block,'enabled',e.target.checked)}/>Enabled</label>
      {parameters[block].map(p=><label key={p.key}>{p.label}<input aria-label={`${block} ${p.label}`} type="number" min={p.min} max={p.max} step={p.step} value={Number((current.effects[block] as unknown as Record<string,unknown>)[p.key])} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=p.min&&value<=p.max)fx(block,p.key,value);}}/></label>)}
      {block==='amp'&&<label>Amp model<select value={current.effects.amp.model} onChange={e=>fx('amp','model',e.target.value)}>{['clean','crunch','lead','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      {block==='cabinet'&&<label>Cabinet model<select value={current.effects.cabinet.model} onChange={e=>fx('cabinet','model',e.target.value)}>{['open','closed','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      {block==='delay'&&<><label>Delay quarter notes<select value={current.effects.delay.quarterNotes} onChange={e=>fx('delay','quarterNotes',Number(e.target.value))}>{[.125,.25,.5,1,2,4].map(value=><option key={value} value={value}>{value}</option>)}</select></label><p className="muted">Delay times are limited to 16 seconds.</p></>}
    </details>)}
    {playback&&<label>Audio output<select value={playback.deviceId()??''} onChange={e=>playback.selectDevice(e.target.value||null)}><option value="">System default</option>{devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>}
  </fieldset>{error&&<p role="alert">{error}</p>}</section>;
}
