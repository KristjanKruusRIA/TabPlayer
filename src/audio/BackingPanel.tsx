import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import {defaultMix} from '../document-settings';
import type {BackingSettings,EditCommand,SyncAnchor} from '../edit-types';
import type {AssetInfo} from '../project';
import type {BackingCandidate} from './bridge';
import type {NativePlaybackController} from './NativePlaybackController';
import type {ReferenceEndpoint,ReferenceSyncControls} from './reference-sync-types';
const noSubscribe=()=>()=>{},noState=()=>null;
const numberValue=(value:string)=>/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):NaN;

export function BackingPanel({settings,assets,onEdit,stageBacking,stageEmbeddedBacking,beginOperation,busy=false,durationMs,playback,embedded,originalSettings,onShowWaveform,reference}:{settings:BackingSettings|null|undefined;assets:Record<string,AssetInfo>;onEdit:(edit:EditCommand,candidate?:BackingCandidate)=>void|Promise<void>;stageBacking:()=>Promise<BackingCandidate|null>;stageEmbeddedBacking:(bytes:Uint8Array)=>Promise<BackingCandidate|null>;beginOperation:()=>()=>void;busy?:boolean;durationMs?:number;playback?:NativePlaybackController|null;embedded?:Uint8Array|null;originalSettings?:BackingSettings|null;onShowWaveform?:()=>void;reference?:ReferenceSyncControls}) {
  useSyncExternalStore(playback?.subscribe??noSubscribe,playback?.getState??noState);
  const [error,setError]=useState<string|null>(null),[staging,setStaging]=useState(false),[duration,setDuration]=useState<number|undefined>(durationMs);
  const [bar,setBar]=useState(1),[occurrence,setOccurrence]=useState(1),[ratio,setRatio]=useState(0),[audioMs,setAudioMs]=useState(0);
  const edit=(backing:BackingSettings|null,candidate?:BackingCandidate)=>{setError(null);void Promise.resolve(candidate?onEdit({type:'setBacking',backing},candidate):onEdit({type:'setBacking',backing})).catch(e=>setError(String(e)));};
  const importAudio=async(original=false)=>{let release:(()=>void)|undefined;setStaging(true);setError(null);try{const end=beginOperation();let released=false;release=()=>{if(!released){released=true;end();}};const candidate=original&&embedded?await stageEmbeddedBacking(embedded):await stageBacking();if(candidate){setDuration(candidate.durationMs);const prior=original?originalSettings:null;await onEdit({type:'setBacking',backing:{offsetMs:0,anchors:[],mix:defaultMix(),...prior,assetId:candidate.assetId}},candidate);}}catch(e){setError(String(e));}finally{release?.();setStaging(false);}};
  const actualDuration=durationMs??playback?.backingDurationMs()??duration;
  const anchor=(index:number,patch:Partial<SyncAnchor>)=>{if(settings)edit({...settings,anchors:settings.anchors.map((a,i)=>i===index?{...a,...patch}:a)});};
  const [numberDraft,setNumberDraft]=useState<{endpoint:ReferenceEndpoint;value:string}|null>(null),numberSession=useRef<typeof numberDraft>(null);
  const instructionId=useId(),consequenceId=useId(),referenceErrorId=useId(),active=reference?.edit.active;
  const referenceEdit=useRef(reference?.edit);referenceEdit.current=reference?.edit;
  const competing=busy||staging||!!active,referenceReady=!!settings&&!!reference?.ready,endpointReady=referenceReady&&!!settings?.referenceSync&&!!reference?.timing;
  useEffect(()=>{if(active?.surface!=='number'){numberSession.current=null;setNumberDraft(null);}},[active]);
  useEffect(()=>()=>{if(referenceEdit.current?.active?.surface==='number')referenceEdit.current.cancel();},[]);
  const runReference=(action:()=>Promise<void>)=>{setError(null);void action().catch(e=>setError(String(e)));};
  const sourceValue=(endpoint:ReferenceEndpoint)=>{const backing=reference?.edit.preview??settings,bounds=backing?.referenceSync;return bounds&&backing?Number(((endpoint==='entry'?bounds.entryAudioMs:bounds.exitAudioMs)-backing.offsetMs).toFixed(7)).toString():'';};
  const updateNumber=(endpoint:ReferenceEndpoint,value:string)=>{
    if(!reference||!endpointReady||staging)return;
    if(!numberSession.current){if(value===sourceValue(endpoint)||!reference.edit.begin(endpoint,'number'))return;}
    if(numberSession.current&&numberSession.current.endpoint!==endpoint)return;
    const draft={endpoint,value};numberSession.current=draft;setNumberDraft(draft);reference.edit.update(numberValue(value));
  };
  const cancelNumber=()=>{if(numberSession.current){numberSession.current=null;setNumberDraft(null);reference?.edit.cancel();}};
  const numberField=(endpoint:ReferenceEndpoint)=>{
    const own=active?.surface==='number'&&active.endpoint===endpoint,value=numberDraft?.endpoint===endpoint?numberDraft.value:sourceValue(endpoint),invalid=numberDraft?.endpoint===endpoint&&(!Number.isFinite(numberValue(value))||!!reference?.edit.error);
    return <label>{endpoint==='entry'?'Entry (ms)':'Exit (ms)'}<input type="text" inputMode="decimal" role="spinbutton" aria-valuenow={Number.isFinite(numberValue(value))?numberValue(value):undefined} aria-valuemin={0} aria-valuemax={actualDuration} aria-invalid={invalid||undefined} aria-describedby={`${instructionId}${reference?.edit.error?` ${referenceErrorId}`:''}`} disabled={!endpointReady||staging||(competing&&!own)} value={value} onFocus={e=>e.currentTarget.select()} onChange={e=>updateNumber(endpoint,e.target.value)} onBlur={cancelNumber} onKeyUp={e=>e.stopPropagation()} onKeyDown={e=>{
      e.stopPropagation();
      if(e.key==='Escape'){e.preventDefault();cancelNumber();}
      else if(e.key==='Enter'){e.preventDefault();if(numberSession.current?.endpoint===endpoint){numberSession.current=null;reference?.edit.commit();}}
      else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const current=numberValue(value);if(Number.isFinite(current))updateNumber(endpoint,String(current+(e.key==='ArrowUp'?1:-1)*(e.shiftKey?10:1)));}
    }}/></label>;
  };
  return <section className="backing-panel"><h3>Backing audio</h3>{onShowWaveform&&<button onClick={onShowWaveform}>Show waveform</button>}<fieldset><fieldset disabled={competing}>
    <p className="muted">{settings?assets[settings.assetId]?.filename.split(/[\\/]/).at(-1)||'Backing audio':settings===undefined?'Original embedded audio, if available':'Score only'}{actualDuration!==undefined&&` · ${(actualDuration/1000).toFixed(1)} s`}</p>
    <button onClick={()=>void importAudio()}>{settings?'Replace backing':'Import backing'}</button><button onClick={()=>edit(null)}>Remove backing</button>
    {embedded&&<button onClick={()=>void importAudio(true)}>Edit embedded backing</button>}
    {settings&&<>
      <label>Backing offset (ms)<input type="number" value={settings.offsetMs} onChange={e=>edit({...settings,offsetMs:Number(e.target.value)})}/></label>
      <label>Backing gain<input type="range" min={0} max={1} step={.01} value={settings.mix.gain} onChange={e=>edit({...settings,mix:{...settings.mix,gain:Number(e.target.value)}})}/></label>
      <label>Backing pan<input type="range" min={-1} max={1} step={.05} value={settings.mix.pan} onChange={e=>edit({...settings,mix:{...settings.mix,pan:Number(e.target.value)}})}/></label>
      <label className="check"><input type="checkbox" aria-label="Backing mute" checked={settings.mix.mute} onChange={e=>edit({...settings,mix:{...settings.mix,mute:e.target.checked}})}/>Mute</label>
      <label className="check"><input type="checkbox" aria-label="Backing solo" checked={settings.mix.solo} onChange={e=>edit({...settings,mix:{...settings.mix,solo:e.target.checked}})}/>Solo</label>
    </>}
    </fieldset>
    {reference&&<details open onToggle={e=>{if(!e.currentTarget.open&&referenceEdit.current?.active?.surface==='number')referenceEdit.current.cancel();}}><summary>Sync timing</summary><fieldset>
      <label>Timing<select value={settings?.referenceSync?'reference':'score'} disabled={!referenceReady||competing} onKeyDown={e=>e.stopPropagation()} onKeyUp={e=>e.stopPropagation()} onChange={e=>runReference(()=>reference.onModeChange(e.target.value as 'score'|'reference'))}><option value="score">Audio follows score</option><option value="reference">Score follows audio</option></select></label>
      <div className="pair">{numberField('entry')}{numberField('exit')}</div>
      <p className="muted">{settings?.referenceSync?'Reference audio stays linear.':'Backing audio follows score tempos.'}</p>
      <p className="muted" id={instructionId}>Enter applies; Escape or blur cancels.</p>
      <details onKeyUp={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}><summary>From score</summary><fieldset disabled={!referenceReady||competing}><button onClick={()=>runReference(()=>reference.onFromScore('replace'))}>Replace sync points</button><button onClick={()=>runReference(()=>reference.onFromScore('add'))}>Add sync points</button></fieldset></details>
      <button disabled={!endpointReady||competing} aria-describedby={consequenceId} onClick={()=>runReference(reference.onWriteScore)}>Write score tempos</button><p className="muted" id={consequenceId}>Replaces score tempo changes.</p>
      {reference.edit.error&&<p role="alert" id={referenceErrorId}>{reference.edit.error}</p>}
    </fieldset></details>}
    {settings&&<fieldset disabled={competing}>
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
    </fieldset>}
  </fieldset>{error&&<p role="alert">{error}</p>}</section>;
}
