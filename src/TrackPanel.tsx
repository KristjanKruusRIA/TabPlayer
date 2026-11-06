import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { BeatTarget } from './project';
import type { NativePlaybackController } from './audio/NativePlaybackController';
import { projectScoreOverview } from './workstation/overview';
import { ScoreOverview } from './workstation/ScoreOverview';
import { trackColorHex } from './track-color';
import { trackIdentity } from './engine';
import { MasterPanel } from './audio/MasterPanel';
import { useI18n } from './i18n';
import './workstation/track-panels.css';
const noSubscribe=()=>()=>{};const noState=()=>null;
/** The player's latest state, so dock rows re-render on mix changes without each subscribing to the player. */
const PlaybackTick=createContext<unknown>(null);

export function TrackPanel({score,selected,busy,view,target,onExitOverview,onSelect,onSelectPosition,player}: {
  score:model.Score;selected:number;busy:boolean;view:'overview'|'mixer';target:BeatTarget;onExitOverview:()=>void;
  onSelect:(track:number)=>void;onSelectPosition:(track:number,bar:number)=>void;
  player:Pick<NativePlaybackController,'subscribe'|'getState'|'mix'|'setMute'|'setSolo'|'setTrackVolume'|'setPan'|'focus'|'setFocus'>&Partial<Pick<NativePlaybackController,'master'|'setMaster'>>|null;
}):React.JSX.Element {
  const state=useSyncExternalStore(player?.subscribe ?? noSubscribe,player?.getState ?? noState);
  const { t } = useI18n();
  const overview=useMemo(()=>projectScoreOverview(score),[score]);
  const colors=useMemo(()=>score.tracks.map(track=>trackColorHex(track.color)),[score]);
  // GP-style dock rows: each track's mute, solo, volume and pan sit beside its bars. The row component is stable per
  // score/player/busy, and subscribes itself, so playback ticks re-render these few controls and not the bar grid.
  const controls=useMemo(()=>({
    header:<span className="score-overview-mix" aria-hidden="true"><span className="score-overview-mix-head">{t('overview.col_mute')}</span><span className="score-overview-mix-head">{t('overview.col_solo')}</span><span className="score-overview-mix-head">{t('overview.col_volume')}</span><span className="score-overview-mix-head">{t('overview.col_pan')}</span></span>,
    Row:function TrackMixRow({track:index}:{track:number}){
      useSyncExternalStore(player?.subscribe ?? noSubscribe,player?.getState ?? noState);
      const track=score.tracks[index];if(!track)return null;
      const name=track.name||`Track ${index+1}`,mix=player?.mix(track),mute=mix?.mute??track.playbackInfo.isMute,solo=mix?.solo??track.playbackInfo.isSolo,volume=mix?.volume??1,pan=mix?.pan??0,off=busy||!player;
      return <span className="score-overview-mix" onKeyDown={event=>event.stopPropagation()}>
        <button type="button" data-kind="mute" aria-pressed={mute} aria-label={t('overview.mute_track',{track:name})} title={t('overview.mute_track',{track:name})} disabled={off} onClick={()=>player?.setMute(index,!mute)}>{t('overview.col_mute')}</button>
        <button type="button" data-kind="solo" aria-pressed={solo} aria-label={t('overview.solo_track',{track:name})} title={t('overview.solo_track',{track:name})} disabled={off} onClick={()=>player?.setSolo(index,!solo)}>{t('overview.col_solo')}</button>
        <input type="range" min={0} max={1} step={.05} value={volume} disabled={off} aria-label={t('overview.track_volume',{track:name})} aria-valuetext={`${Math.round(volume*100)}%`} title={`${Math.round(volume*100)}%`} onChange={e=>player?.setTrackVolume(index,Number(e.target.value))}/>
        <input type="range" min={-1} max={1} step={.05} value={pan} disabled={off} aria-label={t('overview.track_pan',{track:name})} aria-valuetext={pan===0?'C':pan<0?`L${Math.round(-pan*100)}`:`R${Math.round(pan*100)}`} title={pan===0?'C':pan<0?`L${Math.round(-pan*100)}`:`R${Math.round(pan*100)}`} onChange={e=>player?.setPan(index,Number(e.target.value))} onDoubleClick={()=>player?.setPan(index,0)}/>
      </span>;
    },
  }),[score,player,busy,t]);
  // Focus belongs to the selected track (by identity): selecting another track moves it there.
  const selectedId=score.tracks[selected]?trackIdentity(score.tracks[selected]):null,focus=player?.focus(),amount=focus&&focus.track===selectedId?focus.amount:0;
  // Invalid input is prevented by the control; playback failures are reported by the player itself.
  const changeFocus=(value:number)=>{if(selectedId)void player?.setFocus(selectedId,value).catch(()=>{});};
  useEffect(()=>{const current=player?.focus();if(current&&selectedId&&current.track!==selectedId)void player?.setFocus(selectedId,current.amount).catch(()=>{});},[player,selectedId]);
  const selectedMix=score.tracks[selected]?player?.mix(score.tracks[selected]):undefined,anySolo=score.tracks.some(track=>player?.mix(track)?.solo);
  const silent=Boolean(selectedMix?.mute||(anySolo&&!selectedMix?.solo));
  const focusReady=Boolean(state?.ready&&!state.error);
  const phase=state?.practice?.phase;
  const playbackBar=state?.ready&&!state.error&&(phase==='playing'||phase==='paused')&&!state.practice.countInRemaining&&Number.isInteger(state.measure)&&state.measure>=0&&state.measure<score.masterBars.length?state.measure:null;
  return <section className="track-panel" aria-label="Tracks">
    <div className="track-panel-view" hidden={view!=='overview'}><PlaybackTick.Provider value={state}><ScoreOverview model={overview} colors={colors} controls={controls} target={target} playbackBar={playbackBar} onSelect={onSelectPosition} onExit={onExitOverview}/></PlaybackTick.Provider></div>
    <div className="track-panel-view track-mixer" role="region" aria-label="Mixer" hidden={view!=='mixer'}>
      <section className="track-channel track-focus" aria-label="Focus">
        <div className="track-channel-heading"><span>Focus</span><span className="track-channel-status">Not saved</span></div>
        <label className="track-channel-range">Selected track <output>{amount>0?`Focus ${Math.round(amount*100)}%`:amount<0?`Unfocus ${Math.round(-amount*100)}%`:'Off'}</output><input type="range" min={-100} max={100} step={5} value={Math.round(amount*100)} disabled={busy||!player||!focusReady} aria-label="Focus selected track" aria-valuetext={amount>0?`Focus ${Math.round(amount*100)}%`:amount<0?`Unfocus ${Math.round(-amount*100)}%`:'Off'} onChange={e=>changeFocus(Number(e.target.value)/100)}/></label>
        <button type="button" disabled={busy||!player||!focusReady||amount===0} onClick={()=>changeFocus(0)}>Reset focus</button>
        {silent&&<p className="track-focus-note">The selected track is silent, so focusing it lowers everything you hear.</p>}
      </section>
      {score.tracks.map(track=>{
        const mix=player?.mix(track),mute=mix?.mute??track.playbackInfo.isMute,solo=mix?.solo??track.playbackInfo.isSolo,volume=mix?.volume??1,pan=mix?.pan??0;
        return <section className={`track-channel${track.index===selected?' selected':''}`} key={track.index} aria-label={`Channel ${track.index+1}: ${track.name}`}>
          <div className="track-channel-heading"><button className="track-channel-select" title={track.name} aria-label={`Track ${track.index+1}: ${track.name}`} aria-pressed={track.index===selected} disabled={busy} onClick={()=>onSelect(track.index)}><span className="track-color-swatch" aria-hidden="true" style={{backgroundColor:trackColorHex(track.color)}}/>{track.index+1}. {track.name || `Track ${track.index+1}`}</button><span className="track-channel-status">{track.index===selected?'Selected':track.isPercussion?'Percussion':`${track.staves[0].tuning.length?`${track.staves[0].tuning.length} strings`:'Notation'}`}</span></div>
          <div className="track-channel-switches"><label><input type="checkbox" checked={mute} disabled={busy||!player} onChange={e=>player?.setMute(track.index,e.target.checked)}/>Mute</label><label><input type="checkbox" checked={solo} disabled={busy||!player} onChange={e=>player?.setSolo(track.index,e.target.checked)}/>Solo</label></div>
          <label className="track-channel-range">Volume <output>{volume.toFixed(2)}</output><input type="range" min={0} max={1} step={.05} value={volume} disabled={busy||!player} aria-label={`Volume ${track.name}`} aria-valuetext={String(volume)} onChange={e=>player?.setTrackVolume(track.index,Number(e.target.value))}/></label>
          <label className="track-channel-range">Pan <output>{pan.toFixed(2)}</output><input type="range" min={-1} max={1} step={.05} value={pan} disabled={busy||!player} aria-label={`Pan ${track.name}`} aria-valuetext={String(pan)} onChange={e=>player?.setPan(track.index,Number(e.target.value))}/></label>
        </section>;
      })}
      <MasterPanel master={player?.master?.()} disabled={busy||!player?.setMaster} onChange={next=>player!.setMaster!(next)}/>
    </div>
  </section>;
}
