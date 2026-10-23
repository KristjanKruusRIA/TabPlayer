import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { completeSound, defaultEffects } from '../document-settings';
import type { EditCommand, FxSettings, TrackSound } from '../edit-types';
import type { NativePlaybackController } from './NativePlaybackController';
import type { AudioDeviceInfo } from './bridge';
import { copyPedal, copySound, deleteSoundPreset, renameSoundPreset, saveSoundPreset, soundClipboard, soundLibrary, subscribeSoundClipboard, subscribeSoundLibrary } from './sound-library';
import './sound-panel.css';

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
const blockNames:Record<keyof FxSettings,string>={gate:'Gate',compressor:'Compressor',wah:'Wah',octaver:'Octaver',pitch:'Pitch shift',amp:'Amp',cabinet:'Cabinet',eq:'EQ',vibrato:'Vibrato',phaser:'Phaser',flanger:'Flanger',chorus:'Chorus',tremolo:'Tremolo',delay:'Delay',reverb:'Reverb'};
const parameters:Record<keyof FxSettings,NumericControl[]>={
  gate:[{key:'thresholdDb',label:'Threshold (dB)',min:-96,max:0,step:1},{key:'releaseMs',label:'Release (ms)',min:1,max:1000,step:1}],
  compressor:[{key:'thresholdDb',label:'Threshold (dB)',min:-60,max:0,step:1},{key:'ratio',label:'Ratio',min:1,max:20,step:.1},{key:'attackMs',label:'Attack (ms)',min:.1,max:200,step:.1},{key:'releaseMs',label:'Release (ms)',min:1,max:2000,step:1},{key:'makeupDb',label:'Makeup (dB)',min:0,max:24,step:.1}],
  wah:[{key:'position',label:'Pedal position',min:0,max:1,step:.01},{key:'resonance',label:'Resonance',min:0,max:1,step:.01},{key:'sensitivity',label:'Sensitivity',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  octaver:[{key:'octaveDown',label:'Octave down',min:0,max:1,step:.01},{key:'twoOctavesDown',label:'Two octaves down',min:0,max:1,step:.01},{key:'direct',label:'Direct',min:0,max:1,step:.01}],
  pitch:[{key:'semitones',label:'Semitones',min:-24,max:24,step:1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  amp:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'gainDb',label:'Gain (dB)',min:-24,max:24,step:.1}],cabinet:[],
  eq:[{key:'lowDb',label:'Low (dB)',min:-24,max:24,step:.1},{key:'midDb',label:'Mid (dB)',min:-24,max:24,step:.1},{key:'highDb',label:'High (dB)',min:-24,max:24,step:.1},{key:'midHz',label:'Mid frequency (Hz)',min:200,max:5000,step:10}],
  // Listed in the native processing order.
  vibrato:[{key:'rateHz',label:'Rate (Hz)',min:1,max:14,step:.1},{key:'depthCents',label:'Depth (cents)',min:0,max:100,step:1}],
  phaser:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depth',label:'Depth',min:0,max:1,step:.01},{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  flanger:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depthMs',label:'Depth (ms)',min:0,max:10,step:.1},{key:'feedback',label:'Feedback',min:-.9,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  chorus:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:8,step:.1},{key:'depthMs',label:'Depth (ms)',min:0,max:20,step:.1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  tremolo:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:20,step:.1},{key:'depth',label:'Depth',min:0,max:1,step:.01}],
  delay:[{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  reverb:[{key:'room',label:'Room',min:0,max:1,step:.01},{key:'damping',label:'Damping',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
};
export function SoundPanel({trackId,sound,onEdit,playback,busy=false}:{trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean}) {
  const playbackState=useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const current=completeSound(sound??soundPreset('gm'));const [devices,setDevices]=useState<AudioDeviceInfo[]>([]);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;if(playback)void playback.devices().then(items=>{if(alive)setDevices(items);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[playback]);
  /** Applies `next` as one undoable edit; resolves to whether it was accepted. */
  const save=(next:TrackSound)=>Promise.resolve(onEdit({type:'setTrackSound',trackId,sound:next})).then(()=>true,e=>{setError(String(e));return false;});
  const fx=(block:keyof FxSettings,key:string,value:unknown)=>{const next=structuredClone(current);Object.assign(next.effects[block],{[key]:value});save(next);};
  const library=useSyncExternalStore(subscribeSoundLibrary,soundLibrary),clipboard=useSyncExternalStore(subscribeSoundClipboard,soundClipboard);
  const [chosen,setChosen]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState(''),[confirming,setConfirming]=useState(false);
  const entry=library.find(item=>item.name===chosen),savedSelect=useRef<HTMLSelectElement>(null);
  // Messages and an open confirmation belong to the track they were shown for.
  const shownTrack=useRef(trackId);
  useEffect(()=>{shownTrack.current=trackId;setStatus('');setConfirming(false);},[trackId]);
  const closeConfirm=()=>{setConfirming(false);savedSelect.current?.focus();};
  const report=(result:ReturnType<typeof saveSoundPreset>,done:string)=>{if(!result.ok){setStatus(result.error);return false;}setStatus(result.stored===false?`${done} It is kept until TabPlayer closes, because the sound library could not be stored.`:done);return true;};
  const pastePedal=()=>{const pedal=clipboard.pedal;if(!pedal)return;const next=structuredClone(current);(next.effects as unknown as Record<string,unknown>)[pedal.block]=structuredClone(pedal.settings);save(next);};
  return <section className="sound-panel" aria-label="Track sound"><h3>Sound</h3><fieldset disabled={busy}>
    <label>Sound source<select value={current.voiceId??''} onChange={e=>save({...current,voiceId:e.target.value||null})}><option value="">Automatic instrument</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
    <label>Sound preset<select value={current.presetId} onChange={e=>save(soundPreset(e.target.value as TrackSound['presetId'],current.voiceId))}>{['gm','clean','crunch','lead','bass'].map(id=><option value={id} key={id}>{id==='gm'?'Bypass':id[0].toUpperCase()+id.slice(1)}</option>)}</select></label>
    <button onClick={()=>save(soundPreset(current.presetId,current.voiceId))}>Restore preset</button>
    <div className="sound-clipboard"><button onClick={()=>{copySound(current);setStatus('Copied this track’s sound.');}}>Copy sound</button><button disabled={!clipboard.sound} onClick={()=>{if(clipboard.sound)save(structuredClone(clipboard.sound));}}>Paste sound</button></div>
    </fieldset>
    <fieldset disabled={busy} className="sound-library"><legend>My sounds</legend>
      <label>Saved sound<select ref={savedSelect} aria-label="Saved sound" value={entry?chosen:''} onChange={e=>{setChosen(e.target.value);setConfirming(false);}}><option value="">{library.length?'Choose a saved sound':'No saved sounds yet'}</option>{library.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <div className="sound-library-actions"><button disabled={!entry} onClick={()=>{if(entry){const applied=entry.name,appliedTo=trackId;void save(structuredClone(entry.sound)).then(ok=>{if(ok&&shownTrack.current===appliedTo)setStatus(`Applied “${applied}”.`);});}}}>Apply saved sound</button><button disabled={!entry} onClick={()=>setConfirming(true)}>Delete saved sound</button></div>
      {confirming&&entry&&<div role="group" aria-label={`Delete “${entry.name}”?`} className="sound-library-confirm"><span>Delete “{entry.name}”? This cannot be undone.</span><button onClick={()=>{if(report(deleteSoundPreset(entry.name),`Deleted “${entry.name}”.`))setChosen('');closeConfirm();}}>Delete</button><button autoFocus onClick={closeConfirm}>Cancel</button></div>}
      <label>Name<input aria-label="Saved sound name" value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
      <div className="sound-library-actions"><button disabled={!name.trim()} onClick={()=>{const result=saveSoundPreset(name,current);if(report(result,`${result.ok&&result.replaced?'Replaced':'Saved'} “${name.trim()}”.`)){setChosen(name.trim());setName('');}}}>Save sound</button><button disabled={!entry||!name.trim()} onClick={()=>{if(entry&&report(renameSoundPreset(entry.name,name),`Renamed “${entry.name}” to “${name.trim()}”.`)){setChosen(name.trim());setName('');}}}>Rename saved sound</button></div>
      <p role="status" className="muted">{status}</p>
    </fieldset><p className="sound-chain-label muted">Fixed signal chain</p>
    <div className="sound-chain">{(Object.keys(parameters) as (keyof FxSettings)[]).map(block=><details className="sound-block" key={block}><summary><span className="sound-block-name">{blockNames[block]}</span><span className="sound-block-state">{current.effects[block].enabled?'Enabled':'Bypassed'}</span></summary><fieldset disabled={busy}>
      <label className="check"><input aria-label={`Enable ${block}`} type="checkbox" checked={current.effects[block].enabled} onChange={e=>fx(block,'enabled',e.target.checked)}/>Enabled</label>
      {parameters[block].map(p=><label key={p.key}>{p.label}<input aria-label={`${block} ${p.label}`} type="number" disabled={block==='wah'&&p.key===(current.effects.wah.mode==='auto'?'position':'sensitivity')} min={p.min} max={p.max} step={p.step} value={Number((current.effects[block] as unknown as Record<string,unknown>)[p.key])} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=p.min&&value<=p.max)fx(block,p.key,value);}}/></label>)}
      {block==='amp'&&<label>Amp model<select value={current.effects.amp.model} onChange={e=>fx('amp','model',e.target.value)}>{['clean','crunch','lead','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      {block==='phaser'&&<label>Phaser stages<select aria-label="Phaser stages" value={current.effects.phaser.stages} onChange={e=>fx('phaser','stages',Number(e.target.value))}>{[2,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
      {block==='wah'&&<label>Wah mode<select aria-label="Wah mode" value={current.effects.wah.mode} onChange={e=>fx('wah','mode',e.target.value)}><option value="manual">Manual pedal</option><option value="auto">Auto (follows playing)</option></select></label>}
      {block==='tremolo'&&<label>Tremolo shape<select aria-label="Tremolo shape" value={current.effects.tremolo.shape} onChange={e=>fx('tremolo','shape',e.target.value)}><option value="sine">Sine</option><option value="square">Square</option></select></label>}
      {block==='cabinet'&&<label>Cabinet model<select value={current.effects.cabinet.model} onChange={e=>fx('cabinet','model',e.target.value)}>{['open','closed','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      <div className="sound-pedal-clipboard"><button aria-label={`Copy pedal: ${blockNames[block]}`} onClick={()=>{copyPedal(block,current.effects[block]);setStatus(`Copied the ${blockNames[block]} pedal.`);}}>Copy pedal</button><button aria-label={`Paste pedal: ${blockNames[block]}`} disabled={clipboard.pedal?.block!==block} onClick={pastePedal}>Paste pedal</button></div>
      {block==='delay'&&<><label>Delay quarter notes<select value={current.effects.delay.quarterNotes} onChange={e=>fx('delay','quarterNotes',Number(e.target.value))}>{[.125,.25,.5,1,2,4].map(value=><option key={value} value={value}>{value}</option>)}</select></label><p className="muted">Delay times are limited to 16 seconds.</p></>}
    </fieldset></details>)}</div>
    {playback&&<fieldset disabled={busy} className="sound-output"><label>Audio output<select value={playback.deviceId()??''} onChange={e=>playback.selectDevice(e.target.value||null)}><option value="">System default</option>{devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label></fieldset>}
  {error&&<p role="alert">{error}</p>}{playbackState?.error&&playbackState.error!==error&&<p role="alert">{playbackState.error}</p>}</section>;
}
