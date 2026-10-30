import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EditCommand, TrackSound } from '../edit-types';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { presetIds, presetName } from '../audio/sound-model';
import { useSoundEditing } from '../audio/useSoundEditing';
import { Segmented } from '../ui';
import { BlockStage } from './BlockStage';
import { SignalChain } from './SignalChain';
import { SoundBrowser } from './SoundBrowser';
import type { BlockRef } from './blocks';
import './rig.css';

export interface RigTrack {id:string;name:string}
export interface SoundRigProps {
  trackId:string;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean;
  /** The score's tracks, to change which one the rig edits without leaving it. */
  tracks:readonly RigTrack[];onTrack:(id:string)=>void;
  /** A control for the cabinet's impulse response, shown with the cabinet. Left empty until it exists. */
  cabinetResponse?:ReactNode;
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
  const root=useRef<HTMLElement>(null);
  useEffect(()=>{previewReturn.current=()=>root.current?.querySelector<HTMLElement>('[data-row-main][tabindex="0"]')?.focus();return()=>{previewReturn.current=null;};},[previewReturn]);
  return <section ref={root} className="sound-view" aria-label="Sound rig" data-browser-open={browserOpen||undefined} onKeyDown={editing.escapePreview}>
    <header className="rig-head">
      <label className="rig-field"><span className="rig-field-name">Track</span><select className="rig-select" aria-label="Sound track" value={trackId} onChange={event=>onTrack(event.target.value)}>{tracks.map(track=><option key={track.id} value={track.id}>{track.name}</option>)}</select></label>
      <label className="rig-field"><span className="rig-field-name">Sound source</span><select className="rig-select" aria-label="Sound source" disabled={busy} value={current.voiceId??''} onChange={event=>void editing.setVoice(event.target.value||null)}>
        <option value="">Automatic instrument</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
      <div className="rig-field"><span className="rig-field-name" aria-hidden="true">Sound preset</span>
        <Segmented label="Sound preset" value={current.presetId} disabled={busy} onChange={id=>void editing.applyPreset(id)} options={presetIds.map(id=>({value:id,label:presetName(id)}))}/></div>
      <button type="button" className="rig-button" disabled={busy} onClick={()=>void editing.restorePreset()}>Restore preset</button>
      <span className="rig-head-gap"/>
      <button type="button" className="rig-button" onClick={editing.copyCurrentSound}>Copy sound</button>
      <button type="button" className="rig-button" disabled={busy||!editing.clipboard.sound} onClick={editing.pasteSound}>Paste sound</button>
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
      {showingPreview&&<div className="rig-preview" role="group" aria-label="Sound preview">
        <span className="rig-preview-name">Previewing {previewLabel}</span>
        <button type="button" className="rig-button" data-primary onClick={editing.keepPreview}>Keep previewed sound</button>
        <button type="button" className="rig-button" onClick={editing.cancelPreview}>Cancel preview</button>
      </div>}
      <p className="rig-status" role="status">{status}</p>
      {playback&&<label className="rig-inline"><span className="rig-field-name">Audio output</span><select className="rig-select" aria-label="Audio output" disabled={busy} value={playback.deviceId()??''} onChange={event=>editing.selectOutput(event.target.value)}>
        <option value="">System default</option>{editing.devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>}
    </div>
    {error&&<p role="alert" className="rig-alert">{error}</p>}{playbackState?.error&&playbackState.error!==error&&<p role="alert" className="rig-alert">{playbackState.error}</p>}
  </section>;
}
