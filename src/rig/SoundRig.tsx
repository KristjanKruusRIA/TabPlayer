import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EditCommand, TrackSound } from '../edit-types';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { presetIds, presetName } from '../audio/sound-model';
import { SoundLock } from '../audio/SoundLock';
import { useSoundEditing } from '../audio/useSoundEditing';
import type { Board } from '../audio/useSoundEditing';
import { Segmented, busyGuard } from '../ui';
import { BlockStage } from './BlockStage';
import { SignalChain } from './SignalChain';
import { SoundBrowser } from './SoundBrowser';
import { SourcePicker, TrackStrip } from './SourcePicker';
import type { BlockRef } from './blocks';
import './rig.css';

/** A track the rig can switch to: its name, and the General MIDI program and percussion flag that decide what Automatic plays it as. */
export interface RigTrack {id:string;name:string;program?:number;percussion?:boolean}
export interface SoundRigProps {
  trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean;
  /** The score's tracks, to change which one the rig edits without leaving it. */
  tracks:readonly RigTrack[];onTrack:(id:string)=>void;
  /** The control for a cabinet's impulse response, shown with that pedalboard's cabinet. */
  cabinetResponse?:(board:Board)=>ReactNode;
  /** A control for the master output, shown below the stage. Left empty until it exists. */
  master?:ReactNode;
}

/** The Sound view: a track's whole signal path as hardware. The chain runs across the top, the chosen block fills the
 * stage and the sound browser sits beside it. Every change goes through the shared sound editing, so each is one
 * undoable `setTrackSound` edit, exactly as in the inspector's Sound task. */
export function SoundRig({trackId,sound,onEdit,playback,busy=false,tracks,onTrack,cabinetResponse,master}:SoundRigProps) {
  const editing=useSoundEditing({trackId,sound,onEdit,playback,busy,shown:true});
  const {current,second,playbackState,error,status,showingPreview,previewLabel,previewReturn}=editing;
  const [chosen,setChosen]=useState<BlockRef>({block:'amp',second:false}),[browserOpen,setBrowserOpen]=useState(false);
  // A second pedalboard with that pedal off is gone, so the first board's block is shown instead.
  const selected:BlockRef=chosen.second&&!(second&&second.effects[chosen.block].enabled)?{block:chosen.block,second:false}:chosen;
  useEffect(()=>{if(chosen.second&&!(second&&second.effects[chosen.block].enabled)){setChosen({block:chosen.block,second:false});}},[chosen,second]);
  const root=useRef<HTMLElement>(null);
  useEffect(()=>{previewReturn.current=()=>root.current?.querySelector<HTMLElement>('.rig-sources [role=radio][aria-checked=true]')?.focus();return()=>{previewReturn.current=null;};},[previewReturn]);
  return <section ref={root} className="sound-view" aria-label="Sound rig" data-browser-open={browserOpen||undefined} onKeyDown={editing.escapePreview}>
    <header className="rig-head">
      <TrackStrip tracks={tracks} trackId={trackId} onTrack={onTrack}/>
      <SourcePicker editing={editing} track={tracks.find(item=>item.id===trackId)}/>
      <Segmented className="rig-presets" label="Sound preset" value={current.presetId} disabled={busy} onChange={id=>void editing.applyPreset(id)} options={presetIds.map(id=>({value:id,label:presetName(id)}))}/>
      <SoundLock editing={editing} className="rig-lock"/>
      <span className="rig-head-gap"/>
      <button type="button" className="rig-button rig-browser-toggle" aria-pressed={browserOpen} aria-expanded={browserOpen} onClick={()=>setBrowserOpen(open=>!open)}>Sounds</button>
    </header>
    <SignalChain editing={editing} selected={selected} onSelect={setChosen} disabled={busy}/>
    <div className="rig-body">
      <SoundBrowser editing={editing}/>
      <div className="rig-main">
        <BlockStage editing={editing} selected={selected} cabinetResponse={cabinetResponse}/>
        {master&&<div className="rig-slot" data-slot="master">{master}</div>}
      </div>
    </div>
    <div className="rig-messages">
      <div className="rig-sound-actions">
        <button type="button" {...busyGuard({busy,className:'rig-button',onClick:()=>void editing.restorePreset()})}>Restore preset</button>
        <button type="button" className="rig-button" onClick={editing.copyCurrentSound}>Copy sound</button>
        <button type="button" {...busyGuard({busy,unavailable:!editing.clipboard.sound,className:'rig-button',onClick:editing.pasteSound})}>Paste sound</button>
      </div>
      {/* Always laid out, so a preview starting or ending moves nothing; hidden and inert while none runs. */}
      <div className="rig-preview" role="group" aria-label="Sound preview" inert={!showingPreview} style={{visibility:showingPreview?'visible':'hidden'}}>
        <span className="rig-preview-name" title={showingPreview?`Previewing ${previewLabel}`:undefined}>{showingPreview&&`Previewing ${previewLabel}`}</span>
        <button type="button" data-primary aria-label="Keep previewed sound" {...busyGuard({busy,className:'rig-button',onClick:editing.keepPreview})}><span className="rig-long">Keep previewed sound</span><span className="rig-short" aria-hidden="true">Keep</span></button>
        <button type="button" className="rig-button" aria-label="Cancel preview" onClick={editing.cancelPreview}><span className="rig-long">Cancel preview</span><span className="rig-short" aria-hidden="true">Cancel</span></button>
      </div>
      <p className="rig-status" role="status" title={status||undefined}>{status}</p>
      {playback&&<label className="rig-inline"><span className="rig-field-name">Audio output</span><select className="rig-select" aria-label="Audio output" aria-disabled={busy||undefined} value={playback.deviceId()??''} onChange={event=>{if(busy){event.target.value=playback.deviceId()??'';return;}editing.selectOutput(event.target.value);}} onKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDown={event=>{if(busy)event.preventDefault();}} onMouseDown={event=>{if(busy)event.preventDefault();}}>
        <option value="">System default</option>{editing.devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>}
    </div>
    {error&&<p role="alert" className="rig-alert">{error}</p>}{playbackState?.error&&playbackState.error!==error&&<p role="alert" className="rig-alert">{playbackState.error}</p>}
  </section>;
}
