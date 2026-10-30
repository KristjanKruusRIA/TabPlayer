import { useEffect, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { factorySound, factorySounds } from '../audio/factory-sounds';
import { presetName } from '../audio/sound-model';
import { completeSound } from '../document-settings';
import type { TrackSound } from '../edit-types';
import { trackIdentity } from '../engine';
import { midiPrograms } from '../midi-programs';
import { trackColorHex } from '../track-color';
import { Fader, Knob } from '../ui';
import './mixer.css';

const noSubscribe=()=>()=>{};
const noState=()=>null;

const voiceNames:Record<string,string>={
  gm:'General MIDI',
  'green-guitar':'Green Guitar',
  'black-guitar':'Black Guitar',
  'darkblack-bass':'Darkblack Bass',
  'babyblue-bass':'Babyblue Bass',
};

/** Names the instrument source and tone (factory sound or preset) currently set on `track`. */
export function describeTrackSound(track:model.Track,sound?:TrackSound):{voice:string;tone:string} {
  const voice=sound?.voiceId
    ?voiceNames[sound.voiceId]??sound.voiceId
    :track.isPercussion
      ?'Percussion'
      :midiPrograms[track.playbackInfo.program]??'Automatic instrument';
  if(!sound)return {voice,tone:presetName('gm')};
  const completed=completeSound(sound),effectsKey=JSON.stringify(completed.effects);
  const matched=factorySounds.find(item=>{
    if(item.presetId!==completed.presetId)return false;
    const candidate=factorySound(item.id,completed.voiceId);
    return candidate!==null&&JSON.stringify(completeSound(candidate).effects)===effectsKey;
  });
  return {voice,tone:matched?matched.name:presetName(completed.presetId)};
}

export type MixerPlayer=Pick<
  NativePlaybackController,
  'subscribe'|'getState'|'mix'|'setMute'|'setSolo'|'setTrackVolume'|'setPan'|'focus'|'setFocus'
>;

export interface MixerViewProps {
  score:model.Score;
  sounds?:Record<string,TrackSound>;
  selected:number;
  busy:boolean;
  onSelect:(track:number)=>void;
  player:MixerPlayer|null;
}

/** The Mixer view: one channel strip per track with a vertical volume fader, pan knob, mute, solo, track selection and
 * current sound, plus session focus for the selected track. Every mix change goes through the player's undoable
 * `setTrackMix` path, matching the dock mixer. */
export function MixerView({score,sounds,selected,busy,onSelect,player}:MixerViewProps):React.JSX.Element {
  const state=useSyncExternalStore(player?.subscribe??noSubscribe,player?.getState??noState);
  // Focus belongs to the selected track (by identity): selecting another track moves it there.
  const selectedId=score.tracks[selected]?trackIdentity(score.tracks[selected]):null;
  const focus=player?.focus(),amount=focus&&focus.track===selectedId?focus.amount:0;
  // Invalid input is prevented by the control; playback failures are reported by the player itself.
  const changeFocus=(value:number)=>{if(selectedId)void player?.setFocus(selectedId,value).catch(()=>{});};
  useEffect(()=>{
    const current=player?.focus();
    if(current&&selectedId&&current.track!==selectedId)void player?.setFocus(selectedId,current.amount).catch(()=>{});
  },[player,selectedId]);
  const selectedMix=score.tracks[selected]?player?.mix(score.tracks[selected]):undefined;
  const anySolo=score.tracks.some(track=>player?.mix(track)?.solo);
  const silent=Boolean(selectedMix?.mute||(anySolo&&!selectedMix?.solo));
  const focusReady=Boolean(state?.ready&&!state.error);

  return <section className="mixer-view" aria-label="Mixer">
    <section className="mixer-focus" aria-label="Focus">
      <div className="mixer-focus-head">
        <span className="mixer-focus-title">Focus</span>
        <span className="mixer-badge">Not saved</span>
      </div>
      <Knob
        className="mixer-focus-knob"
        label="Selected track"
        ariaLabel="Focus selected track"
        bipolar
        min={-100}
        max={100}
        step={5}
        defaultValue={0}
        value={Math.round(amount*100)}
        format={v=>v>0?`Focus ${Math.round(v)}%`:v<0?`Unfocus ${Math.round(-v)}%`:'Off'}
        disabled={busy||!player||!focusReady}
        onCommit={v=>changeFocus(v/100)}
      />
      <button type="button" className="mixer-button" disabled={busy||!player||!focusReady||amount===0} onClick={()=>changeFocus(0)}>Reset focus</button>
      {silent&&<p className="mixer-focus-note">The selected track is silent, so focusing it lowers everything you hear.</p>}
    </section>
    <div className="mixer-strips">
      {score.tracks.map(track=>{
        const id=trackIdentity(track),sound=describeTrackSound(track,sounds?.[id]);
        const mix=player?.mix(track),mute=mix?.mute??track.playbackInfo.isMute,solo=mix?.solo??track.playbackInfo.isSolo,volume=mix?.volume??1,pan=mix?.pan??0;
        const isSelected=track.index===selected;
        return <section className={`mixer-strip${isSelected?' selected':''}`} data-selected={isSelected||undefined} key={track.index} aria-label={`Channel ${track.index+1}: ${track.name}`}>
          <div className="mixer-strip-head">
            <button type="button" className="mixer-strip-select" title={track.name} aria-label={`Track ${track.index+1}: ${track.name}`} aria-pressed={isSelected} disabled={busy} onClick={()=>onSelect(track.index)}>
              <span className="track-color-swatch" aria-hidden="true" style={{backgroundColor:trackColorHex(track.color)}}/>
              <span className="mixer-strip-name">{track.index+1}. {track.name||`Track ${track.index+1}`}</span>
            </button>
            {isSelected&&<span className="mixer-strip-status">Selected</span>}
          </div>
          <div className="mixer-strip-sound" aria-label={`Sound ${track.name}`}>
            <span className="mixer-strip-voice" title={sound.voice}>{sound.voice}</span>
            <span className="mixer-strip-preset" title={sound.tone}>{sound.tone}</span>
          </div>
          <div className="mixer-strip-switches">
            <label className="mixer-switch" data-kind="mute" data-active={mute||undefined} data-disabled={busy||!player||undefined}>
              <input type="checkbox" checked={mute} disabled={busy||!player} onChange={e=>player?.setMute(track.index,e.target.checked)}/>
              <span>Mute</span>
            </label>
            <label className="mixer-switch" data-kind="solo" data-active={solo||undefined} data-disabled={busy||!player||undefined}>
              <input type="checkbox" checked={solo} disabled={busy||!player} onChange={e=>player?.setSolo(track.index,e.target.checked)}/>
              <span>Solo</span>
            </label>
          </div>
          <Knob
            className="mixer-strip-pan"
            label="Pan"
            ariaLabel={`Pan ${track.name}`}
            bipolar
            min={-1}
            max={1}
            step={0.05}
            defaultValue={0}
            value={pan}
            format={v=>v.toFixed(2)}
            disabled={busy||!player}
            onCommit={v=>player?.setPan(track.index,v)}
          />
          <div className="mixer-strip-fader-well">
            <Fader
              className="mixer-strip-fader"
              label="Volume"
              ariaLabel={`Volume ${track.name}`}
              min={0}
              max={1}
              step={0.05}
              defaultValue={1}
              value={volume}
              format={v=>v.toFixed(2)}
              disabled={busy||!player}
              onCommit={v=>player?.setTrackVolume(track.index,v)}
            />
          </div>
        </section>;
      })}
    </div>
  </section>;
}
