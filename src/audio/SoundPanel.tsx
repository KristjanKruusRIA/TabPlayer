import { useEffect, useRef } from 'react';
import { delayDivisions, effectBlocks, modulationDivisions, syncedBlocks } from '../document-settings';
import type { EditCommand, EffectBlock, TrackSound } from '../edit-types';
import { CabinetResponse } from './CabinetResponse';
import type { NativePlaybackController } from './NativePlaybackController';
import { factoryCategories, factorySounds } from './factory-sounds';
import { chainOrder } from '../document-settings';
import { ampModels, blockNames, cabinetModels, graphicBands, modelName, parameters, presetIds, presetName, soundPreset } from './sound-model';
import { SoundLock } from './SoundLock';
import { BusyFieldset, busyGuard } from '../ui';
import { useI18n } from '../i18n';
import { DrumKitPicker } from './DrumKitPicker';
import { useSoundEditing } from './useSoundEditing';
import type { Board } from './useSoundEditing';
import './sound-panel.css';

export { soundPreset };
/** The inspector's Sound task: every control as a field. The rig in `src/rig` shows the same sound as hardware; both share `useSoundEditing`. */
export function SoundPanel({trackId,sound,onEdit,playback,busy=false,shown=true,percussion=false}:{trackId:string;/** A drum track, which also chooses its drum kit here. */percussion?:boolean;sound?:TrackSound;onEdit:(edit:EditCommand)=>void|Promise<void>;playback?:NativePlaybackController|null;busy?:boolean;shown?:boolean}) {
  const { t } = useI18n();
  const editing=useSoundEditing({trackId,sound,onEdit,playback,busy,shown,diagnostics:true});
  const {playbackState,current,devices,diagnostics,diagnosticsError,testToneMessage,testTone,error,status,fx,duplicate,syncOf,sync,order,move,movedBlock,pastePedal,clipboard,library,chosen,setChosen,name,setName,entry,confirming,setConfirming,savedSelect,closeConfirm,
    factoryChoice,setFactoryChoice,factory,factoryNote,applyFactory,previewer,previewChoice,previewLabel,showingPreview,previewSelect,choosePreview,cancelPreview,keepPreview,escapePreview,orphanPreview,first,second,save}=editing;
  const chainRef=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null);
  // The wheel over a focused number field steps it natively, and a refused change does not put the number back; while busy the wheel is refused (React's own wheel listener is passive, so this one is native).
  useEffect(()=>{
    const node=panel.current;if(!node||!busy)return;
    const refuse=(event:WheelEvent)=>{if(event.target instanceof HTMLInputElement&&event.target.type==='number')event.preventDefault();};
    node.addEventListener('wheel',refuse,{passive:false});return()=>node.removeEventListener('wheel',refuse);
  },[busy]);
  // A moved block's buttons move with it, which loses their focus; it returns to the same button once the new order shows,
  // or to the other one when the block reached an end of the chain.
  useEffect(()=>{
    const pending=movedBlock.current;if(!pending||order.join()===pending.from)return;movedBlock.current=null;
    const button=(step:number)=>chainRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="Move ${blockNames[pending.block]} ${step<0?'earlier':'later'}"]`);
    const target=[button(pending.step),button(-pending.step)].find(candidate=>candidate&&!candidate.disabled);if(target&&document.activeElement!==target)target.focus();
  });
  /** One pedal's controls on `board`, at `index` in the track's chain. Names on the second board say so. */
  const pedal=(board:Board,block:EffectBlock,index:number)=><details className="sound-block" key={block}><summary><span className="sound-block-name">{blockNames[block]}</span><span className="sound-block-state">{board.effects[block].enabled?'Enabled':'Bypassed'}</span></summary><BusyFieldset busy={busy}>
      <label className="check"><input aria-label={board.name(`Enable ${block}`)} type="checkbox" checked={board.effects[block].enabled} onChange={e=>fx(board,block,'enabled',e.target.checked)}/>Enabled</label>
      {!board.second&&<div className="sound-block-order"><button aria-label={board.name(`Move ${blockNames[block]} earlier`)} disabled={index===0} onClick={()=>move(block,-1)}>Move earlier</button><button aria-label={board.name(`Move ${blockNames[block]} later`)} disabled={index===order.length-1} onClick={()=>move(block,1)}>Move later</button></div>}
      {parameters[block].map(p=><label key={p.key}>{p.label}<input aria-label={board.name(`${block} ${p.label}`)} type="number" disabled={block==='wah'&&p.key===(board.effects.wah.mode==='auto'?'position':'sensitivity')||p.key==='rateHz'&&syncOf(board,block)!==0} min={p.min} max={p.max} step={p.step} value={Number((board.effects[block] as unknown as Record<string,unknown>)[p.key]??0)} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=p.min&&value<=p.max)fx(board,block,p.key,value);}}/></label>)}
      {block==='microphone'&&<><label>Microphone placement<select aria-label={board.name('Microphone placement')} value={board.effects.microphone.placement} onChange={e=>fx(board,'microphone','placement',e.target.value)}><option value="standard">Standard</option><option value="close">Close</option><option value="edge">Edge</option><option value="room">Room</option></select></label><label>Microphone output<select aria-label={board.name('Microphone output')} value={board.effects.microphone.output} onChange={e=>fx(board,'microphone','output',e.target.value)}><option value="stereo">Stereo</option><option value="mono">Mono</option></select></label></>}
      {block==='graphicEq'&&<><div className="sound-graphic-eq" role="group" aria-label={board.name('Graphic EQ bands')}>{graphicBands.map((band,index)=><label key={band}>{band} Hz<input aria-label={board.name(`Graphic EQ ${band} Hz (dB)`)} type="number" min={-12} max={12} step={.5} value={board.effects.graphicEq.gainsDb[index]} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=-12&&value<=12)fx(board,'graphicEq','gainsDb',board.effects.graphicEq.gainsDb.map((gain,other)=>other===index?value:gain));}}/></label>)}</div><button aria-label={board.name('Flatten graphic EQ')} onClick={()=>fx(board,'graphicEq','gainsDb',graphicBands.map(()=>0))}>Flatten graphic EQ</button></>}
      {block==='drive'&&<label>Drive model<select aria-label={board.name('Drive model')} value={board.effects.drive.model} onChange={e=>fx(board,'drive','model',e.target.value)}><option value="overdrive">Overdrive</option><option value="distortion">Distortion</option><option value="fuzz">Fuzz</option></select></label>}
      {block==='reverb'&&<label>Reverb model<select aria-label={board.name('Reverb model')} value={board.effects.reverb.model} onChange={e=>fx(board,'reverb','model',e.target.value)}><option value="room">Room</option><option value="hall">Hall</option><option value="plate">Plate</option><option value="spring">Spring</option></select></label>}
      {block==='amp'&&<label>Amp model<select aria-label={board.name('Amp model')} value={board.effects.amp.model} onChange={e=>fx(board,'amp','model',e.target.value)}>{ampModels.map(model=><option key={model} value={model}>{modelName(model)}</option>)}</select></label>}
      {syncedBlocks.includes(block)&&<label>Tempo sync<select aria-label={board.name(`${blockNames[block]} tempo sync`)} value={syncOf(board,block)} onChange={e=>sync(board,block,Number(e.target.value))}><option value={0}>Off (free rate)</option>{modulationDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>}
      {block==='phaser'&&<label>Phaser stages<select aria-label={board.name('Phaser stages')} value={board.effects.phaser.stages} onChange={e=>fx(board,'phaser','stages',Number(e.target.value))}>{[2,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
      {block==='wah'&&<label>Wah model<select aria-label={board.name('Wah model')} value={board.effects.wah.model} onChange={e=>fx(board,'wah','model',e.target.value)}><option value="classic">Classic</option><option value="vintage">Vintage (vocal)</option><option value="wide">Wide range</option><option value="bass">Bass</option></select></label>}
      {block==='wah'&&<label>Wah mode<select aria-label={board.name('Wah mode')} value={board.effects.wah.mode} onChange={e=>fx(board,'wah','mode',e.target.value)}><option value="manual">Manual pedal</option><option value="auto">Auto (follows playing)</option></select></label>}
      {block==='tremolo'&&<label>Tremolo shape<select aria-label={board.name('Tremolo shape')} value={board.effects.tremolo.shape} onChange={e=>fx(board,'tremolo','shape',e.target.value)}><option value="sine">Sine</option><option value="square">Square</option></select></label>}
      {block==='cabinet'&&<label>Cabinet model<select aria-label={board.name('Cabinet model')} value={board.effects.cabinet.model} onChange={e=>fx(board,'cabinet','model',e.target.value)}>{cabinetModels.map(model=><option key={model} value={model}>{modelName(model)}</option>)}</select></label>}{block==='cabinet'&&<CabinetResponse ir={board.effects.cabinet.ir} model={board.effects.cabinet.model} label={board.name} scope={`${trackId}:${board.name('Cabinet')}`} onLibraryChange={()=>{if(playback&&typeof playback.refreshSounds==='function')void playback.refreshSounds().catch(()=>{});}} onChange={ir=>board.write(effects=>{if(ir)effects.cabinet.ir=ir;else delete effects.cabinet.ir;})}/>}
      <div className="sound-pedal-clipboard"><button aria-label={board.name(`Copy pedal: ${blockNames[block]}`)} onClick={()=>{editing.copyPedalOf(board,block);}}>Copy pedal</button><button aria-label={board.name(`Paste pedal: ${blockNames[block]}`)} disabled={clipboard.pedal?.block!==block} onClick={()=>pastePedal(board)}>Paste pedal</button></div>
      {board.second?<button aria-label={`Remove duplicate: ${blockNames[block]}`} onClick={()=>fx(board,block,'enabled',false)}>Remove duplicate</button>:<button aria-label={`Duplicate pedal: ${blockNames[block]}`} disabled={!!second?.effects[block].enabled} onClick={()=>duplicate(block)}>Duplicate pedal</button>}
      {block==='delay'&&<><label>Delay model<select aria-label={board.name('Delay model')} value={board.effects.delay.model} onChange={e=>fx(board,'delay','model',e.target.value)}><option value="digital">Digital</option><option value="tape">Tape</option><option value="analog">Analog</option></select></label><label>Delay time<select aria-label={board.name('Delay time')} value={board.effects.delay.quarterNotes} onChange={e=>fx(board,'delay','quarterNotes',Number(e.target.value))}>{delayDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label><p className="muted">Delay times are limited to 16 seconds.</p></>}
    </BusyFieldset></details>;

  return <section ref={panel} className="sound-panel" aria-label="Track sound"><h3>Sound</h3>
    <SoundLock editing={editing} className="check"/>
    {percussion&&<DrumKitPicker editing={editing} className="drum-kit"/>}
    <BusyFieldset busy={busy}>
    <label>Sound source<select value={current.voiceId??''} onChange={e=>save({...current,voiceId:e.target.value||null})}><option value="">Automatic instrument</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
    <label>Sound preset<select value={current.presetId} onChange={e=>save(soundPreset(e.target.value as TrackSound['presetId'],current.voiceId))}>{presetIds.map(id=><option value={id} key={id}>{presetName(id)}</option>)}</select></label>
    <button onClick={()=>void editing.restorePreset()}>Restore preset</button>
    <label>Factory sound<select aria-label="Factory sound" aria-describedby={factoryNote} value={factoryChoice} onChange={e=>setFactoryChoice(e.target.value)}><option value="">Choose a factory sound</option>{factoryCategories.map(category=><optgroup key={category} label={category}>{factorySounds.filter(item=>item.category===category).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select></label>
    <p id={factoryNote} className="muted">{factory?`${factory.description} `:''}Factory sounds set the effects; the track keeps its instrument.</p>
    <button disabled={!factory} onClick={applyFactory}>Apply factory sound</button>
    {previewer&&<><label>Preview sound<select ref={previewSelect} aria-label="Preview sound" value={showingPreview?previewChoice:''} onKeyDown={escapePreview} onChange={e=>choosePreview(e.target.value)}>
      <option value="">Choose a sound to preview</option>{orphanPreview&&<option value={previewChoice} disabled>{previewLabel} (no longer saved)</option>}<optgroup label="Factory presets">{presetIds.map(id=><option key={id} value={`preset:${id}`}>{presetName(id)}</option>)}</optgroup>{factoryCategories.map(category=><optgroup key={category} label={`${category} sounds`}>{factorySounds.filter(item=>item.category===category).map(item=><option key={item.id} value={`factory:${item.id}`}>{item.name}</option>)}</optgroup>)}{library.length>0&&<optgroup label="My sounds">{library.map(item=><option key={item.name} value={`saved:${item.name}`}>{item.name}</option>)}</optgroup>}</select></label>
    {showingPreview&&<div className="sound-clipboard" role="group" aria-label="Sound preview" onKeyDown={escapePreview}><button onClick={keepPreview}>Keep previewed sound</button><button onClick={cancelPreview}>Cancel preview</button></div>}</>}
    <div className="sound-clipboard"><button onClick={editing.copyCurrentSound}>Copy sound</button><button disabled={!clipboard.sound} onClick={editing.pasteSound}>Paste sound</button></div>
    </BusyFieldset>
    <BusyFieldset busy={busy} className="sound-library"><legend>My sounds</legend>
      <label>Saved sound<select ref={savedSelect} aria-label="Saved sound" value={entry?chosen:''} onChange={e=>{setChosen(e.target.value);setConfirming(false);}}><option value="">{library.length?'Choose a saved sound':'No saved sounds yet'}</option>{library.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <div className="sound-library-actions"><button disabled={!entry} onClick={()=>{if(entry)editing.applySaved(entry.name);}}>Apply saved sound</button><button disabled={!entry} onClick={()=>setConfirming(true)}>Delete saved sound</button></div>
      {confirming&&entry&&<div role="group" aria-label={`Delete “${entry.name}”?`} className="sound-library-confirm"><span>Delete “{entry.name}”? This cannot be undone.</span><button onClick={editing.deleteChosen}>Delete</button><button autoFocus onClick={closeConfirm}>Cancel</button></div>}
      <label>Name<input aria-label="Saved sound name" value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
      <div className="sound-library-actions"><button disabled={!name.trim()} onClick={editing.saveNamed}>Save sound</button><button disabled={!entry||!name.trim()} onClick={editing.renameChosen}>Rename saved sound</button></div>
      <p role="status" className="muted">{status}</p>
    </BusyFieldset><p className="sound-chain-label muted">Signal chain</p>
    <div className="sound-chain" ref={chainRef}>{order.map((block,index)=>pedal(first,block,index))}</div>
    {second&&effectBlocks.some(block=>second.effects[block].enabled)&&<section className="sound-second-board" aria-label="Second pedalboard"><p className="sound-chain-label muted">Second pedalboard, after the signal chain</p><div className="sound-chain">{chainOrder(second.effects).filter(block=>second.effects[block].enabled).map((block,index)=>pedal(second,block,index))}</div></section>}
    {playback&&<BusyFieldset busy={busy} className="sound-output">
      <label>{t('audio.audio_output')}<select value={playback.deviceId()??''} onChange={e=>editing.selectOutput(e.target.value)}><option value="">{t('audio.system_default')}</option>{devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
      <button type="button" {...busyGuard({ busy, onClick: testTone })}>{t('audio.test_tone')}</button>
      <div className="sound-diagnostics" role="group" aria-label={t('audio.diagnostics_label')}>
        <div className="sound-diag-item"><span className="sound-diag-label">{t('audio.current_device')}:</span> <span className="sound-diag-value">{diagnostics?.deviceName ?? t('audio.unknown')}</span></div>
        <div className="sound-diag-item"><span className="sound-diag-label">{t('audio.sample_rate')}:</span> <span className="sound-diag-value">{diagnostics?.sampleRate ? `${diagnostics.sampleRate} Hz` : t('audio.unknown')}</span></div>
        <div className="sound-diag-item"><span className="sound-diag-label">{t('audio.buffer_size')}:</span> <span className="sound-diag-value">{diagnostics?.bufferSize != null ? t('audio.frames', { count: diagnostics.bufferSize }) : t('audio.unknown')}</span></div>
      </div>
      {diagnosticsError&&<p role="alert" className="sound-diagnostics-error">{t(diagnosticsError)}</p>}
      {testToneMessage&&<p role="alert" className="sound-test-tone-message">{t(testToneMessage)}</p>}
    </BusyFieldset>}
  {error&&<p role="alert">{error}</p>}{playbackState?.error&&playbackState.error!==error&&<p role="alert">{playbackState.error}</p>}</section>;
}
