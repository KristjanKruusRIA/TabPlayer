import {useState,useSyncExternalStore} from 'react';
import {defaultMix} from '../document-settings';
import type {BackingSettings,EditCommand,SyncAnchor} from '../edit-types';
import type {AssetInfo} from '../project';
import type {BackingCandidate} from './bridge';
import type {NativePlaybackController} from './NativePlaybackController';
const noSubscribe=()=>()=>{},noState=()=>null;

export function BackingPanel({settings,assets,onEdit,stageBacking,stageEmbeddedBacking,beginOperation,busy=false,durationMs,playback,embedded,originalSettings}:{settings:BackingSettings|null|undefined;assets:Record<string,AssetInfo>;onEdit:(edit:EditCommand,candidate?:BackingCandidate)=>void|Promise<void>;stageBacking:()=>Promise<BackingCandidate|null>;stageEmbeddedBacking:(bytes:Uint8Array)=>Promise<BackingCandidate|null>;beginOperation:()=>()=>void;busy?:boolean;durationMs?:number;playback?:NativePlaybackController|null;embedded?:Uint8Array|null;originalSettings?:BackingSettings|null}) {
  useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const [error,setError]=useState<string|null>(null),[staging,setStaging]=useState(false),[duration,setDuration]=useState<number|undefined>(durationMs);
  const [bar,setBar]=useState(1),[occurrence,setOccurrence]=useState(1),[ratio,setRatio]=useState(0),[audioMs,setAudioMs]=useState(0);
  const edit=(backing:BackingSettings|null,candidate?:BackingCandidate)=>{setError(null);void Promise.resolve(candidate?onEdit({type:'setBacking',backing},candidate):onEdit({type:'setBacking',backing})).catch(e=>setError(String(e)));};
  const importAudio=async(original=false)=>{let release:(()=>void)|undefined;setStaging(true);setError(null);try{const end=beginOperation();let released=false;release=()=>{if(!released){released=true;end();}};const candidate=original&&embedded?await stageEmbeddedBacking(embedded):await stageBacking();if(candidate){setDuration(candidate.durationMs);const prior=original?originalSettings:null;await onEdit({type:'setBacking',backing:{offsetMs:0,anchors:[],mix:defaultMix(),...prior,assetId:candidate.assetId}},candidate);}}catch(e){setError(String(e));}finally{release?.();setStaging(false);}};
  const actualDuration=durationMs??playback?.backingDurationMs()??duration;
  const anchor=(index:number,patch:Partial<SyncAnchor>)=>{if(settings)edit({...settings,anchors:settings.anchors.map((a,i)=>i===index?{...a,...patch}:a)});};
  return <section className="backing-panel"><h3>Backing audio</h3><fieldset disabled={busy||staging}>
    <p className="muted">{settings?assets[settings.assetId]?.filename.split(/[\\/]/).at(-1)||'Backing audio':settings===undefined?'Original embedded audio, if available':'Score only'}{actualDuration!==undefined&&` · ${(actualDuration/1000).toFixed(1)} s`}</p>
    <button onClick={()=>void importAudio()}>{settings?'Replace backing':'Import backing'}</button><button onClick={()=>edit(null)}>Remove backing</button>
    {embedded&&<button onClick={()=>void importAudio(true)}>Edit embedded backing</button>}
    {settings&&<>
      <label>Backing offset (ms)<input type="number" value={settings.offsetMs} onChange={e=>edit({...settings,offsetMs:Number(e.target.value)})}/></label>
      <label>Backing gain<input type="range" min={0} max={1} step={.01} value={settings.mix.gain} onChange={e=>edit({...settings,mix:{...settings.mix,gain:Number(e.target.value)}})}/></label>
      <label>Backing pan<input type="range" min={-1} max={1} step={.05} value={settings.mix.pan} onChange={e=>edit({...settings,mix:{...settings.mix,pan:Number(e.target.value)}})}/></label>
      <label className="check"><input type="checkbox" aria-label="Backing mute" checked={settings.mix.mute} onChange={e=>edit({...settings,mix:{...settings.mix,mute:e.target.checked}})}/>Mute</label>
      <label className="check"><input type="checkbox" aria-label="Backing solo" checked={settings.mix.solo} onChange={e=>edit({...settings,mix:{...settings.mix,solo:e.target.checked}})}/>Solo</label>
      <details><summary>Synchronization anchors</summary><p className="muted">Measure and occurrence count from 1. Position is the fraction of the measure.</p>
        {settings.anchors.map((a,index)=><div className="backing-anchor" key={index}>
          <label>Measure<input aria-label={`Anchor ${index+1} measure`} type="number" min={1} value={a.bar+1} onChange={e=>anchor(index,{bar:Number(e.target.value)-1})}/></label>
          <label>Occurrence<input aria-label={`Anchor ${index+1} occurrence`} type="number" min={1} value={a.occurrence+1} onChange={e=>anchor(index,{occurrence:Number(e.target.value)-1})}/></label>
          <label>Position<input aria-label={`Anchor ${index+1} position`} type="number" min={0} max={1} step={.01} value={a.ratio} onChange={e=>anchor(index,{ratio:Number(e.target.value)})}/></label>
          <label>Audio (ms)<input aria-label={`Anchor ${index+1} audio (ms)`} type="number" min={0} value={a.audioMs} onChange={e=>anchor(index,{audioMs:Number(e.target.value)})}/></label>
          <button onClick={()=>edit({...settings,anchors:settings.anchors.filter((_,i)=>i!==index)})}>Delete anchor {index+1}</button>
        </div>)}
        <label>Anchor measure<input type="number" min={1} value={bar} onChange={e=>setBar(Number(e.target.value))}/></label>
        <label>Anchor occurrence<input type="number" min={1} value={occurrence} onChange={e=>setOccurrence(Number(e.target.value))}/></label>
        <label>Anchor position<input type="number" min={0} max={1} step={.01} value={ratio} onChange={e=>setRatio(Number(e.target.value))}/></label>
        <label>Anchor audio (ms)<input type="number" min={0} value={audioMs} onChange={e=>setAudioMs(Number(e.target.value))}/></label>
        <button onClick={()=>edit({...settings,anchors:[...settings.anchors,{bar:bar-1,occurrence:occurrence-1,ratio,audioMs}]})}>Add anchor</button>
      </details>
    </>}
  </fieldset>{error&&<p role="alert">{error}</p>}</section>;
}
