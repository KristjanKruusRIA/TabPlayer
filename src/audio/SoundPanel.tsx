import { useEffect, useRef } from 'react';
import { delayDivisions, effectBlocks, modulationDivisions, syncedBlocks } from '../document-settings';
import type { EditCommand, EffectBlock, TrackSound } from '../edit-types';
import { CabinetResponse } from './CabinetResponse';
import { AmpCapture } from './AmpCapture';
import type { NativePlaybackController } from './NativePlaybackController';
import { factoryCategories, factorySounds } from './factory-sounds';
import { chainOrder } from '../document-settings';
import { ampModels, blockNames, cabinetModels, graphicBands, modelName, parameters, presetIds, presetName, soundPreset, localizedBlockName, localizedPresetName, localizedAmpModelName, localizedCabinetModelName, localizedParamLabel } from './sound-model';
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
  const { lang, t } = useI18n();
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
    const button=(step:number)=>chainRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="${first.name(t(step<0?'sound.move_block_earlier':'sound.move_block_later',{block:localizedBlockName(pending.block,lang)}))}"]`)??chainRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="Move ${blockNames[pending.block]} ${step<0?'earlier':'later'}"]`);
    const target=[button(pending.step),button(-pending.step)].find(candidate=>candidate&&!candidate.disabled);if(target&&document.activeElement!==target)target.focus();
  });
  /** One pedal's controls on `board`, at `index` in the track's chain. Names on the second board say so. */
  const pedal=(board:Board,block:EffectBlock,index:number)=>{
    const bName=localizedBlockName(block,lang);
    return <details className="sound-block" key={block}><summary><span className="sound-block-name">{bName}</span><span className="sound-block-state">{board.effects[block].enabled?t('sound.enabled'):t('sound.bypassed')}</span></summary><BusyFieldset busy={busy}>
      <label className="check"><input aria-label={board.name(t('sound.enable_block',{block:lang==='en'?block:bName}))} type="checkbox" checked={board.effects[block].enabled} onChange={e=>fx(board,block,'enabled',e.target.checked)}/>{t('sound.enabled')}</label>
      {!board.second&&<div className="sound-block-order"><button aria-label={board.name(t('sound.move_block_earlier',{block:bName}))} disabled={index===0} onClick={()=>move(block,-1)}>{t('sound.move_earlier')}</button><button aria-label={board.name(t('sound.move_block_later',{block:bName}))} disabled={index===order.length-1} onClick={()=>move(block,1)}>{t('sound.move_later')}</button></div>}
      {parameters[block].map(p=>{const pLabel=lang==='en'?p.label:localizedParamLabel(block,p.key,p.label,lang);return <label key={p.key}>{pLabel}<input aria-label={board.name(`${lang==='en'?block:bName} ${pLabel}`)} type="number" disabled={block==='wah'&&p.key===(board.effects.wah.mode==='auto'?'position':'sensitivity')||p.key==='rateHz'&&syncOf(board,block)!==0} min={p.min} max={p.max} step={p.step} value={Number((board.effects[block] as unknown as Record<string,unknown>)[p.key]??0)} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=p.min&&value<=p.max)fx(board,block,p.key,value);}}/></label>;})}
      {block==='microphone'&&<><label>{t('sound.mic_placement')}<select aria-label={board.name(t('sound.mic_placement'))} value={board.effects.microphone.placement} onChange={e=>fx(board,'microphone','placement',e.target.value)}><option value="standard">{t('sound.placement_standard')}</option><option value="close">{t('sound.placement_close')}</option><option value="edge">{t('sound.placement_edge')}</option><option value="room">{t('sound.placement_room')}</option></select></label><label>{t('sound.mic_output')}<select aria-label={board.name(t('sound.mic_output'))} value={board.effects.microphone.output} onChange={e=>fx(board,'microphone','output',e.target.value)}><option value="stereo">{t('sound.output_stereo')}</option><option value="mono">{t('sound.output_mono')}</option></select></label></>}
      {block==='graphicEq'&&<><div className="sound-graphic-eq" role="group" aria-label={board.name(t('sound.graphic_eq_bands'))}>{graphicBands.map((band,index)=><label key={band}>{band} Hz<input aria-label={board.name(t('sound.graphic_eq_band_label',{band}))} type="number" min={-12} max={12} step={.5} value={board.effects.graphicEq.gainsDb[index]} onChange={e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=-12&&value<=12)fx(board,'graphicEq','gainsDb',board.effects.graphicEq.gainsDb.map((gain,other)=>other===index?value:gain));}}/></label>)}</div><button aria-label={board.name(t('sound.flatten_graphic_eq'))} onClick={()=>fx(board,'graphicEq','gainsDb',graphicBands.map(()=>0))}>{t('sound.flatten_graphic_eq')}</button></>}
      {block==='drive'&&<label>{t('sound.drive_model')}<select aria-label={board.name(t('sound.drive_model'))} value={board.effects.drive.model} onChange={e=>fx(board,'drive','model',e.target.value)}><option value="overdrive">{t('sound.model_overdrive')}</option><option value="distortion">{t('sound.model_distortion')}</option><option value="fuzz">{t('sound.model_fuzz')}</option></select></label>}
      {block==='reverb'&&<label>{t('sound.reverb_model')}<select aria-label={board.name(t('sound.reverb_model'))} value={board.effects.reverb.model} onChange={e=>fx(board,'reverb','model',e.target.value)}><option value="room">{t('sound.model_room')}</option><option value="hall">{t('sound.model_hall')}</option><option value="plate">{t('sound.model_plate')}</option><option value="spring">{t('sound.model_spring')}</option></select></label>}
      {block==='amp'&&<label>{t('sound.amp_model')}<select aria-label={board.name(t('sound.amp_model'))} value={board.effects.amp.model} onChange={e=>fx(board,'amp','model',e.target.value)}>{ampModels.map(model=><option key={model} value={model}>{localizedAmpModelName(model,lang)}</option>)}</select></label>}{block==='amp'&&<AmpCapture value={board.effects.amp.capture} busy={busy} label={board.name} scope={`${trackId}:${first.name(t('block.amp'))}`} onLibraryChange={()=>{if(playback&&typeof playback.refreshSounds==='function')void playback.refreshSounds().catch(()=>{});}} onChange={capture=>board.write(effects=>{if(capture)effects.amp.capture=capture;else delete effects.amp.capture;})}/>}
      {syncedBlocks.includes(block)&&<label>{t('sound.tempo_sync')}<select aria-label={board.name(t('sound.tempo_sync_named',{block:bName}))} value={syncOf(board,block)} onChange={e=>sync(board,block,Number(e.target.value))}><option value={0}>{t('sound.sync_off')}</option>{modulationDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>}
      {block==='phaser'&&<label>{t('sound.phaser_stages')}<select aria-label={board.name(t('sound.phaser_stages'))} value={board.effects.phaser.stages} onChange={e=>fx(board,'phaser','stages',Number(e.target.value))}>{[2,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
      {block==='wah'&&<label>{t('sound.wah_model')}<select aria-label={board.name(t('sound.wah_model'))} value={board.effects.wah.model} onChange={e=>fx(board,'wah','model',e.target.value)}><option value="classic">{t('sound.model_classic')}</option><option value="vintage">{t('sound.model_vintage')}</option><option value="wide">{t('sound.model_wide')}</option><option value="bass">{t('sound.model_bass')}</option></select></label>}
      {block==='wah'&&<label>{t('sound.wah_mode')}<select aria-label={board.name(t('sound.wah_mode'))} value={board.effects.wah.mode} onChange={e=>fx(board,'wah','mode',e.target.value)}><option value="manual">{t('sound.wah_manual')}</option><option value="auto">{t('sound.wah_auto')}</option></select></label>}
      {block==='tremolo'&&<label>{t('sound.tremolo_shape')}<select aria-label={board.name(t('sound.tremolo_shape'))} value={board.effects.tremolo.shape} onChange={e=>fx(board,'tremolo','shape',e.target.value)}><option value="sine">{t('sound.tremolo_sine')}</option><option value="square">{t('sound.tremolo_square')}</option></select></label>}
      {block==='cabinet'&&<label>{t('sound.cabinet_model')}<select aria-label={board.name(t('sound.cabinet_model'))} value={board.effects.cabinet.model} onChange={e=>fx(board,'cabinet','model',e.target.value)}>{cabinetModels.map(model=><option key={model} value={model}>{localizedCabinetModelName(model,lang)}</option>)}</select></label>}{block==='cabinet'&&<CabinetResponse ir={board.effects.cabinet.ir} model={board.effects.cabinet.model} label={board.name} scope={`${trackId}:${first.name(t('block.cabinet'))}`} onLibraryChange={()=>{if(playback&&typeof playback.refreshSounds==='function')void playback.refreshSounds().catch(()=>{});}} onChange={ir=>board.write(effects=>{if(ir)effects.cabinet.ir=ir;else delete effects.cabinet.ir;})}/>}
      <div className="sound-pedal-clipboard"><button aria-label={board.name(t('sound.copy_pedal_named',{name:bName}))} onClick={()=>{editing.copyPedalOf(board,block);}}>{t('sound.copy_pedal')}</button><button aria-label={board.name(t('sound.paste_pedal_named',{name:bName}))} disabled={clipboard.pedal?.block!==block} onClick={()=>pastePedal(board)}>{t('sound.paste_pedal')}</button></div>
      {board.second?<button aria-label={t('sound.remove_duplicate_named',{name:bName})} onClick={()=>fx(board,block,'enabled',false)}>{t('sound.remove_duplicate')}</button>:<button aria-label={t('sound.duplicate_pedal_named',{name:bName})} disabled={!!second?.effects[block].enabled} onClick={()=>duplicate(block)}>{t('sound.duplicate_pedal')}</button>}
      {block==='delay'&&<><label>{t('sound.delay_model')}<select aria-label={board.name(t('sound.delay_model'))} value={board.effects.delay.model} onChange={e=>fx(board,'delay','model',e.target.value)}><option value="digital">{t('sound.model_digital')}</option><option value="tape">{t('sound.model_tape')}</option><option value="analog">{t('sound.model_analog')}</option></select></label><label>{t('sound.delay_time')}<select aria-label={board.name(t('sound.delay_time'))} value={board.effects.delay.quarterNotes} onChange={e=>fx(board,'delay','quarterNotes',Number(e.target.value))}>{delayDivisions.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label><p className="muted">{t('sound.delay_limit_note')}</p></>}
    </BusyFieldset></details>;
  };

  return <section ref={panel} className="sound-panel" aria-label={t('sound.track_sound')}><h3>{t('sound.heading')}</h3>
    <SoundLock editing={editing} className="check"/>
    {percussion&&<DrumKitPicker editing={editing} className="drum-kit"/>}
    <BusyFieldset busy={busy}>
    <label>{t('sound.sound_source')}<select value={current.voiceId??''} onChange={e=>save({...current,voiceId:e.target.value||null})}><option value="">{t('sound.automatic_instrument')}</option><option value="gm">General MIDI</option><option value="green-guitar">Green Guitar</option><option value="black-guitar">Black Guitar</option><option value="darkblack-bass">Darkblack Bass</option><option value="babyblue-bass">Babyblue Bass</option></select></label>
    <label>{t('sound.sound_preset')}<select value={current.presetId} onChange={e=>save(soundPreset(e.target.value as TrackSound['presetId'],current.voiceId))}>{presetIds.map(id=><option value={id} key={id}>{localizedPresetName(id,lang)}</option>)}</select></label>
    <button onClick={()=>void editing.restorePreset()}>{t('sound.restore_preset')}</button>
    <label>{t('sound.factory_sound')}<select aria-label={t('sound.factory_sound')} aria-describedby={factoryNote} value={factoryChoice} onChange={e=>setFactoryChoice(e.target.value)}><option value="">{t('sound.choose_factory_sound')}</option>{factoryCategories.map(category=><optgroup key={category} label={category}>{factorySounds.filter(item=>item.category===category).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select></label>
    <p id={factoryNote} className="muted">{factory?`${factory.description} `:''}{t('sound.factory_help')}</p>
    <button disabled={!factory} onClick={applyFactory}>{t('sound.apply_factory_sound')}</button>
    {previewer&&<><label>{t('sound.preview_sound')}<select ref={previewSelect} aria-label={t('sound.preview_sound')} value={showingPreview?previewChoice:''} onKeyDown={escapePreview} onChange={e=>choosePreview(e.target.value)}>
      <option value="">{t('sound.choose_preview_sound')}</option>{orphanPreview&&<option value={previewChoice} disabled>{previewLabel} {t('sound.no_longer_saved')}</option>}<optgroup label={t('sound.factory_presets_group')}>{presetIds.map(id=><option key={id} value={`preset:${id}`}>{localizedPresetName(id,lang)}</option>)}</optgroup>{factoryCategories.map(category=><optgroup key={category} label={t('sound.category_sounds_group',{category})}>{factorySounds.filter(item=>item.category===category).map(item=><option key={item.id} value={`factory:${item.id}`}>{item.name}</option>)}</optgroup>)}{library.length>0&&<optgroup label={t('sound.my_sounds')}>{library.map(item=><option key={item.name} value={`saved:${item.name}`}>{item.name}</option>)}</optgroup>}</select></label>
    {showingPreview&&<div className="sound-clipboard" role="group" aria-label="Sound preview" onKeyDown={escapePreview}><button onClick={keepPreview}>{t('sound.keep_preview')}</button><button onClick={cancelPreview}>{t('sound.cancel_preview')}</button></div>}</>}
    <div className="sound-clipboard"><button onClick={editing.copyCurrentSound}>{t('sound.copy_sound')}</button><button disabled={!clipboard.sound} onClick={editing.pasteSound}>{t('sound.paste_sound')}</button></div>
    </BusyFieldset>
    <BusyFieldset busy={busy} className="sound-library"><legend>{t('sound.my_sounds')}</legend>
      <label>{t('sound.saved_sound')}<select ref={savedSelect} aria-label={t('sound.saved_sound')} value={entry?chosen:''} onChange={e=>{setChosen(e.target.value);setConfirming(false);}}><option value="">{library.length?t('sound.choose_saved_sound'):t('sound.no_saved_sounds')}</option>{library.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <div className="sound-library-actions"><button disabled={!entry} onClick={()=>{if(entry)editing.applySaved(entry.name);}}>{t('sound.apply_saved_sound')}</button><button disabled={!entry} onClick={()=>setConfirming(true)}>{t('sound.delete_saved_sound')}</button></div>
      {confirming&&entry&&<div role="group" aria-label={t('rig.delete_sound_title',{name:entry.name})} className="sound-library-confirm"><span>{t('sound.delete_confirm',{name:entry.name})}</span><button onClick={editing.deleteChosen}>{t('action.delete')}</button><button autoFocus onClick={closeConfirm}>{t('action.cancel')}</button></div>}
      <label>{t('sound.saved_sound_name')}<input aria-label={t('sound.saved_sound_name')} value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
      <div className="sound-library-actions"><button disabled={!name.trim()} onClick={editing.saveNamed}>{t('sound.save_sound')}</button><button disabled={!entry||!name.trim()} onClick={editing.renameChosen}>{t('sound.rename_saved_sound')}</button></div>
      <p role="status" className="muted">{status}</p>
    </BusyFieldset><p className="sound-chain-label muted">{t('sound.signal_chain')}</p>
    <div className="sound-chain" ref={chainRef}>{order.map((block,index)=>pedal(first,block,index))}</div>
    {second&&effectBlocks.some(block=>second.effects[block].enabled)&&<section className="sound-second-board" aria-label={t('sound.second_pedalboard')}><p className="sound-chain-label muted">{t('sound.second_pedalboard_desc')}</p><div className="sound-chain">{chainOrder(second.effects).filter(block=>second.effects[block].enabled).map((block,index)=>pedal(second,block,index))}</div></section>}
    {playback&&<BusyFieldset busy={busy} className="sound-output">
      <label>{t('audio.audio_output')}<select value={playback.deviceId()??''} onChange={e=>editing.selectOutput(e.target.value)}><option value="">{t('audio.system_default')}</option>{devices.map(device=><option key={device.id} value={device.id}>{device.name??t('audio.unknown_device')}</option>)}</select></label>
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
