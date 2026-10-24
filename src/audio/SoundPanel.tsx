import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { chainOrder, completeSound, defaultEffects, delayDivisions, effectBlocks, laterFields, modulationDivisions, syncedBlocks } from '../document-settings';
import type { EditCommand, EffectBlock, TrackSound } from '../edit-types';
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
/** The graphic EQ's bands, an octave apart, as their centres are named. */
const graphicBands=['31','63','125','250','500','1k','2k','4k','8k','16k'];
const presetIds=['gm','clean','crunch','lead','bass'] as const,presetName=(id:string)=>id==='gm'?'Bypass':id[0].toUpperCase()+id.slice(1);
const blockNames:Record<EffectBlock,string>={microphone:'Microphone',gate:'Gate',compressor:'Compressor',wah:'Wah',octaver:'Octaver',pitch:'Pitch shift',drive:'Drive',amp:'Amp',cabinet:'Cabinet',eq:'EQ',graphicEq:'Graphic EQ',vibrato:'Vibrato',phaser:'Phaser',flanger:'Flanger',chorus:'Chorus',tremolo:'Tremolo',delay:'Delay',reverb:'Reverb'};
const parameters:Record<EffectBlock,NumericControl[]>={
  // The sound bank's recording comes before the pedals.
  microphone:[],
  gate:[{key:'thresholdDb',label:'Threshold (dB)',min:-96,max:0,step:1},{key:'releaseMs',label:'Release (ms)',min:1,max:1000,step:1}],
  compressor:[{key:'thresholdDb',label:'Threshold (dB)',min:-60,max:0,step:1},{key:'ratio',label:'Ratio',min:1,max:20,step:.1},{key:'attackMs',label:'Attack (ms)',min:.1,max:200,step:.1},{key:'releaseMs',label:'Release (ms)',min:1,max:2000,step:1},{key:'makeupDb',label:'Makeup (dB)',min:0,max:24,step:.1}],
  wah:[{key:'position',label:'Pedal position',min:0,max:1,step:.01},{key:'resonance',label:'Resonance',min:0,max:1,step:.01},{key:'sensitivity',label:'Sensitivity',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  octaver:[{key:'octaveDown',label:'Octave down',min:0,max:1,step:.01},{key:'twoOctavesDown',label:'Two octaves down',min:0,max:1,step:.01},{key:'direct',label:'Direct',min:0,max:1,step:.01}],
  pitch:[{key:'semitones',label:'Semitones',min:-24,max:24,step:1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  drive:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'tone',label:'Tone',min:0,max:1,step:.01},{key:'levelDb',label:'Level (dB)',min:-24,max:12,step:.5}],
  amp:[{key:'drive',label:'Drive',min:0,max:1,step:.01},{key:'gainDb',label:'Gain (dB)',min:-24,max:24,step:.1},{key:'bassDb',label:'Bass (dB)',min:-12,max:12,step:.5},{key:'midDb',label:'Mid (dB)',min:-12,max:12,step:.5},{key:'trebleDb',label:'Treble (dB)',min:-12,max:12,step:.5},{key:'presenceDb',label:'Presence (dB)',min:-12,max:12,step:.5}],cabinet:[],
  eq:[{key:'lowDb',label:'Low (dB)',min:-24,max:24,step:.1},{key:'midDb',label:'Mid (dB)',min:-24,max:24,step:.1},{key:'highDb',label:'High (dB)',min:-24,max:24,step:.1},{key:'midHz',label:'Mid frequency (Hz)',min:200,max:5000,step:10}],
  graphicEq:[{key:'levelDb',label:'Level (dB)',min:-12,max:12,step:.5}],
  // Listed in the native processing order.
  vibrato:[{key:'rateHz',label:'Rate (Hz)',min:1,max:14,step:.1},{key:'depthCents',label:'Depth (cents)',min:0,max:100,step:1}],
  phaser:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depth',label:'Depth',min:0,max:1,step:.01},{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  flanger:[{key:'rateHz',label:'Rate (Hz)',min:.05,max:5,step:.05},{key:'depthMs',label:'Depth (ms)',min:0,max:10,step:.1},{key:'feedback',label:'Feedback',min:-.9,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  chorus:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:8,step:.1},{key:'depthMs',label:'Depth (ms)',min:0,max:20,step:.1},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  tremolo:[{key:'rateHz',label:'Rate (Hz)',min:.1,max:20,step:.1},{key:'depth',label:'Depth',min:0,max:1,step:.01}],
  delay:[{key:'feedback',label:'Feedback',min:0,max:.9,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
  reverb:[{key:'room',label:'Room',min:0,max:1,step:.01},{key:'damping',label:'Damping',min:0,max:1,step:.01},{key:'mix',label:'Mix',min:0,max:1,step:.01}],
};
export function SoundPanel({trackId,sound,onEdit,playback,busy=false,shown=true}:{trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean;shown?:boolean}) {
  const playbackState=useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const current=completeSound(sound??soundPreset('gm'));const [devices,setDevices]=useState<AudioDeviceInfo[]>([]);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;if(playback)void playback.devices().then(items=>{if(alive)setDevices(items);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[playback]);
  /** Records `next` as one undoable edit; resolves to whether it was accepted. */
  const record=(next:TrackSound)=>Promise.resolve(onEdit({type:'setTrackSound',trackId,sound:next})).then(()=>true,e=>{setError(String(e));return false;});
  // Hosts may give a playback surface without sound previews.
  const previewer=playback&&typeof playback.soundPreview==='function'?playback:null;
  const [previewChoice,setPreviewChoice]=useState(''),[previewLabel,setPreviewLabel]=useState(''),previewRequest=useRef(0),previewSelect=useRef<HTMLSelectElement>(null);
  // The controller may end a preview itself, with its track or document, so it decides what is shown.
  const playing=previewer?.soundPreview(),activePreview=playing?.track===trackId?playing:null,showingPreview=!!previewChoice&&!!activePreview;
  /** Ends this track's preview; a preview still being started is dropped. */
  const endPreview=()=>{previewRequest.current++;setPreviewChoice('');return previewer&&previewer.soundPreview()?.track===trackId?Promise.resolve(previewer.previewSound(trackId,null)).catch(e=>setError(String(e))):Promise.resolve();};
  /** Applies `next` as one undoable edit. A preview ends at once, so the edit is what plays and edits keep their order. */
  const save=(next:TrackSound)=>{if(previewChoice||activePreview){void endPreview();setStatus('Preview ended.');}return record(next);};
  /** Sets one field of `block`. A field added after sounds could be saved is left out while 0, as the native player writes it. */
  const fx=(block:EffectBlock,key:string,value:unknown)=>{const next=structuredClone(current);if(value===0&&laterFields(block).includes(key))delete (next.effects[block] as unknown as Record<string,unknown>)[key];else Object.assign(next.effects[block],{[key]:value});save(next);};
  /** Quarter notes per cycle when `block`'s rate follows the tempo, or 0 for its free rate. */
  const syncOf=(block:EffectBlock)=>Number((current.effects[block] as {syncQuarterNotes?:number}).syncQuarterNotes??0);
  /** Sets `block` to follow the tempo at `value` quarter notes per cycle; 0 returns it to its free rate, which saves no sync. */
  const sync=(block:EffectBlock,value:number)=>{const next=structuredClone(current),settings=next.effects[block] as {syncQuarterNotes?:number};if(value)settings.syncQuarterNotes=value;else delete settings.syncQuarterNotes;save(next);};
  const order=chainOrder(current.effects);
  /** Swaps `block` with its neighbour `step` places along the chain; the default order is saved as no order. */
  const move=(block:EffectBlock,step:-1|1)=>{const next=structuredClone(current),names=[...order],at=names.indexOf(block);[names[at],names[at+step]]=[names[at+step],names[at]];if(names.every((name,index)=>name===effectBlocks[index]))delete next.effects.order;else next.effects.order=names;movedBlock.current={block,step,from:order.join()};void save(next).then(ok=>{if(ok)setStatus(`${blockNames[block]} is now ${at+step+1} of ${names.length} in the chain.`);});};
  // A moved block's buttons move with it, which loses their focus; it returns to the same button once the new order shows,
  // or to the other one when the block reached an end of the chain.
  const movedBlock=useRef<{block:EffectBlock;step:-1|1;from:string}|null>(null),chainRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const pending=movedBlock.current;if(!pending||order.join()===pending.from)return;movedBlock.current=null;
    const button=(step:number)=>chainRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="Move ${blockNames[pending.block]} ${step<0?'earlier':'later'}"]`);
    const target=[button(pending.step),button(-pending.step)].find(candidate=>candidate&&!candidate.disabled);if(target&&document.activeElement!==target)target.focus();
  });
  const library=useSyncExternalStore(subscribeSoundLibrary,soundLibrary),clipboard=useSyncExternalStore(subscribeSoundClipboard,soundClipboard);
  const [chosen,setChosen]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState(''),[confirming,setConfirming]=useState(false);
  const entry=library.find(item=>item.name===chosen),savedSelect=useRef<HTMLSelectElement>(null);
  // Messages and an open confirmation belong to the track they were shown for.
  const shownTrack=useRef(trackId);
  useEffect(()=>{shownTrack.current=trackId;setStatus('');setConfirming(false);setPreviewChoice('');},[trackId]);
  // A preview lasts only while its track's panel is shown.
  useEffect(()=>()=>{if(previewer?.soundPreview()?.track===trackId)void Promise.resolve(previewer.previewSound(trackId,null)).catch(()=>{});},[previewer,trackId]);
  useEffect(()=>{if(!shown&&previewer?.soundPreview()?.track===trackId){previewRequest.current++;setPreviewChoice('');void Promise.resolve(previewer.previewSound(trackId,null)).catch(e=>setError(String(e)));}},[shown,previewer,trackId]);
  // A preview the player ended itself leaves nothing to keep.
  const previewGone=!!previewChoice&&!activePreview;
  useEffect(()=>{if(previewGone)setPreviewChoice('');},[previewGone]);
  const choosePreview=(value:string)=>{
    if(!previewer)return;
    if(!value){void endPreview().then(()=>setStatus('Back to this track’s sound.'));return;}
    const split=value.indexOf(':'),kind=value.slice(0,split),id=value.slice(split+1),saved=library.find(item=>item.name===id);
    const sound=kind==='preset'?soundPreset(id as TrackSound['presetId'],current.voiceId):saved?.sound,label=kind==='preset'?presetName(id):`“${id}”`;if(!sound)return;
    const request=++previewRequest.current,track=trackId;setPreviewChoice('');
    // A result that arrives after another choice, a cancel or a track change is dropped.
    void Promise.resolve(previewer.previewSound(track,structuredClone(sound))).then(()=>{if(request!==previewRequest.current||shownTrack.current!==track||previewer.soundPreview()?.track!==track)return;setPreviewChoice(value);setPreviewLabel(label);setError(null);setStatus(`Previewing ${label}. Keep it or cancel to go back to this track’s sound.`);},e=>{if(request===previewRequest.current)setError(String(e));});
  };
  const cancelPreview=()=>{void endPreview().then(()=>setStatus('Back to this track’s sound.'));previewSelect.current?.focus();};
  const keepPreview=()=>{const kept=previewer?.soundPreview();if(kept?.track!==trackId)return;const label=previewLabel;void record(kept.sound).then(ok=>{if(ok){void endPreview();setStatus(`Kept ${label}.`);}previewSelect.current?.focus();});previewSelect.current?.focus();};
  const escapePreview=(event:React.KeyboardEvent)=>{if(event.key==='Escape'&&showingPreview){event.preventDefault();event.stopPropagation();cancelPreview();}};
  const orphanPreview=showingPreview&&previewChoice.startsWith('saved:')&&!library.some(item=>`saved:${item.name}`===previewChoice);
  const closeConfirm=()=>{setConfirming(false);savedSelect.current?.focus();};
  const report=(result:ReturnType<typeof saveSoundPreset>,done:string)=>{if(!result.ok){setStatus(result.error);return false;}setStatus(result.stored===false?`${done} It is kept until TabPlayer closes, because the sound library could not be stored.`:done);return true;};
  const pastePedal=()=>{const pedal=clipboard.pedal;if(!pedal)return;const next=structuredClone(current);(next.effects as unknown as Record<string,unknown>)[pedal.block]=structuredClone(pedal.settings);save(next);};
  return <section className="sound-panel" aria-label="Track sound"><h3>Sound</h3><fieldset disabled={busy}>
    <label>Sound source<select value={current.voiceId??''} onChange={e=>save({...current,voiceId:e.target.value||null})}><option value="">Automatic instrument</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
    <label>Sound preset<select value={current.presetId} onChange={e=>save(soundPreset(e.target.value as TrackSound['presetId'],current.voiceId))}>{presetIds.map(id=><option value={id} key={id}>{presetName(id)}</option>)}</select></label>
    <button onClick={()=>save(soundPreset(current.presetId,current.voiceId))}>Restore preset</button>
    {previewer&&<><label>Preview sound<select ref={previewSelect} aria-label="Preview sound" value={showingPreview?previewChoice:''} onKeyDown={escapePreview} onChange={e=>choosePreview(e.target.value)}>
      <option value="">Choose a sound to preview</option>{orphanPreview&&<option value={previewChoice} disabled>{previewLabel} (no longer saved)</option>}<optgroup label="Factory presets">{presetIds.map(id=><option key={id} value={`preset:${id}`}>{presetName(id)}</option>)}</optgroup>{library.length>0&&<optgroup label="My sounds">{library.map(item=><option key={item.name} value={`saved:${item.name}`}>{item.name}</option>)}</optgroup>}</select></label>
    {showingPreview&&<div className="sound-clipboard" role="group" aria-label="Sound preview" onKeyDown={escapePreview}><button onClick={keepPreview}>Keep previewed sound</button><button onClick={cancelPreview}>Cancel preview</button></div>}</>}
    <div className="sound-clipboard"><button onClick={()=>{copySound(current);setStatus('Copied this track’s sound.');}}>Copy sound</button><button disabled={!clipboard.sound} onClick={()=>{if(clipboard.sound)save(structuredClone(clipboard.sound));}}>Paste sound</button></div>
    </fieldset>
    <fieldset disabled={busy} className="sound-library"><legend>My sounds</legend>
      <label>Saved sound<select ref={savedSelect} aria-label="Saved sound" value={entry?chosen:''} onChange={e=>{setChosen(e.target.value);setConfirming(false);}}><option value="">{library.length?'Choose a saved sound':'No saved sounds yet'}</option>{library.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <div className="sound-library-actions"><button disabled={!entry} onClick={()=>{if(entry){const applied=entry.name,appliedTo=trackId;void save(structuredClone(entry.sound)).then(ok=>{if(ok&&shownTrack.current===appliedTo)setStatus(`Applied “${applied}”.`);});}}}>Apply saved sound</button><button disabled={!entry} onClick={()=>setConfirming(true)}>Delete saved sound</button></div>
      {confirming&&entry&&<div role="group" aria-label={`Delete “${entry.name}”?`} className="sound-library-confirm"><span>Delete “{entry.name}”? This cannot be undone.</span><button onClick={()=>{if(report(deleteSoundPreset(entry.name),`Deleted “${entry.name}”.`))setChosen('');closeConfirm();}}>Delete</button><button autoFocus onClick={closeConfirm}>Cancel</button></div>}
      <label>Name<input aria-label="Saved sound name" value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
      <div className="sound-library-actions"><button disabled={!name.trim()} onClick={()=>{const result=saveSoundPreset(name,current);if(report(result,`${result.ok&&result.replaced?'Replaced':'Saved'} “${name.trim()}”.`)){setChosen(name.trim());setName('');}}}>Save sound</button><button disabled={!entry||!name.trim()} onClick={()=>{if(entry&&report(renameSoundPreset(entry.name,name),`Renamed “${entry.name}” to “${name.trim()}”.`)){setChosen(name.trim());setName('');}}}>Rename saved sound</button></div>
      <p role="status" className="muted">{status}</p>
    </fieldset><p className="sound-chain-label muted">Signal chain</p>
    <div className="sound-chain" ref={chainRef}>{order.map((block,index)=><details className="sound-block" key={block}><summary><span className="sound-block-name">{blockNames[block]}</span><span className="sound-block-state">{current.effects[block].enabled?'Enabled':'Bypassed'}</span></summary><fieldset disabled={busy}>
      <label className="check"><input aria-label={`Enable ${block}`} type="checkbox" checked={current.effects[block].enabled} onChange={e=>fx(block,'enabled',e.target.checked)}/>Enabled</label>
      <div className="sound-block-order"><button aria-label={`Move ${blockNames[block]} earlier`} disabled={index===0} onClick={()=>move(block,-1)}>Move earlier</button><button aria-label={`Move ${blockNames[block]} later`} disabled={index===order.length-1} onClick={()=>move(block,1)}>Move later</button></div>
      {parameters[block].map(p=><label key={p.key}>{p.label}<input aria-label={`${block} ${p.label}`} type="number" disabled={block==='wah'&&p.key===(current.effects.wah.mode==='auto'?'position':'sensitivity')||p.key==='rateHz'&&syncOf(block)!==0} min={p.min} max={p.max} step={p.step} value={Number((current.effects[block] as unknown as Record<string,unknown>)[p.key]??0)} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=p.min&&value<=p.max)fx(block,p.key,value);}}/></label>)}
      {block==='microphone'&&<><label>Microphone placement<select aria-label="Microphone placement" value={current.effects.microphone.placement} onChange={e=>fx('microphone','placement',e.target.value)}><option value="standard">Standard</option><option value="close">Close</option><option value="edge">Edge</option><option value="room">Room</option></select></label><label>Microphone output<select aria-label="Microphone output" value={current.effects.microphone.output} onChange={e=>fx('microphone','output',e.target.value)}><option value="stereo">Stereo</option><option value="mono">Mono</option></select></label></>}
      {block==='graphicEq'&&<><div className="sound-graphic-eq" role="group" aria-label="Graphic EQ bands">{graphicBands.map((band,index)=><label key={band}>{band} Hz<input aria-label={`Graphic EQ ${band} Hz (dB)`} type="number" min={-12} max={12} step={.5} value={current.effects.graphicEq.gainsDb[index]} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=-12&&value<=12)fx('graphicEq','gainsDb',current.effects.graphicEq.gainsDb.map((gain,other)=>other===index?value:gain));}}/></label>)}</div><button onClick={()=>fx('graphicEq','gainsDb',graphicBands.map(()=>0))}>Flatten graphic EQ</button></>}
      {block==='drive'&&<label>Drive model<select aria-label="Drive model" value={current.effects.drive.model} onChange={e=>fx('drive','model',e.target.value)}><option value="overdrive">Overdrive</option><option value="distortion">Distortion</option><option value="fuzz">Fuzz</option></select></label>}
      {block==='reverb'&&<label>Reverb model<select aria-label="Reverb model" value={current.effects.reverb.model} onChange={e=>fx('reverb','model',e.target.value)}><option value="room">Room</option><option value="hall">Hall</option><option value="plate">Plate</option><option value="spring">Spring</option></select></label>}
      {block==='amp'&&<label>Amp model<select value={current.effects.amp.model} onChange={e=>fx('amp','model',e.target.value)}>{['clean','crunch','lead','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      {syncedBlocks.includes(block)&&<label>Tempo sync<select aria-label={`${blockNames[block]} tempo sync`} value={syncOf(block)} onChange={e=>sync(block,Number(e.target.value))}><option value={0}>Off (free rate)</option>{modulationDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>}
      {block==='phaser'&&<label>Phaser stages<select aria-label="Phaser stages" value={current.effects.phaser.stages} onChange={e=>fx('phaser','stages',Number(e.target.value))}>{[2,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
      {block==='wah'&&<label>Wah mode<select aria-label="Wah mode" value={current.effects.wah.mode} onChange={e=>fx('wah','mode',e.target.value)}><option value="manual">Manual pedal</option><option value="auto">Auto (follows playing)</option></select></label>}
      {block==='tremolo'&&<label>Tremolo shape<select aria-label="Tremolo shape" value={current.effects.tremolo.shape} onChange={e=>fx('tremolo','shape',e.target.value)}><option value="sine">Sine</option><option value="square">Square</option></select></label>}
      {block==='cabinet'&&<label>Cabinet model<select value={current.effects.cabinet.model} onChange={e=>fx('cabinet','model',e.target.value)}>{['open','closed','bass'].map(model=><option key={model}>{model}</option>)}</select></label>}
      <div className="sound-pedal-clipboard"><button aria-label={`Copy pedal: ${blockNames[block]}`} onClick={()=>{copyPedal(block,current.effects[block]);setStatus(`Copied the ${blockNames[block]} pedal.`);}}>Copy pedal</button><button aria-label={`Paste pedal: ${blockNames[block]}`} disabled={clipboard.pedal?.block!==block} onClick={pastePedal}>Paste pedal</button></div>
      {block==='delay'&&<><label>Delay model<select aria-label="Delay model" value={current.effects.delay.model} onChange={e=>fx('delay','model',e.target.value)}><option value="digital">Digital</option><option value="tape">Tape</option><option value="analog">Analog</option></select></label><label>Delay time<select aria-label="Delay time" value={current.effects.delay.quarterNotes} onChange={e=>fx('delay','quarterNotes',Number(e.target.value))}>{delayDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label><p className="muted">Delay times are limited to 16 seconds.</p></>}
    </fieldset></details>)}</div>
    {playback&&<fieldset disabled={busy} className="sound-output"><label>Audio output<select value={playback.deviceId()??''} onChange={e=>playback.selectDevice(e.target.value||null)}><option value="">System default</option>{devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label></fieldset>}
  {error&&<p role="alert">{error}</p>}{playbackState?.error&&playbackState.error!==error&&<p role="alert">{playbackState.error}</p>}</section>;
}
