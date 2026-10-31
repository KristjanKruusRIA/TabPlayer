import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { factorySound, factorySounds } from '../audio/factory-sounds';
import { MasterPanel } from '../audio/MasterPanel';
import { automaticVoice, presetName, soundPreset, voiceNames } from '../audio/sound-model';
import { completeSound } from '../document-settings';
import type { ChannelMix, TrackSound } from '../edit-types';
import { trackIdentity } from '../engine';
import { midiPrograms } from '../midi-programs';
import { trackColorHex } from '../track-color';
import { Fader, Knob, busyGuard } from '../ui';
import { useLivePreview } from './useLivePreview';
import './mixer.css';

const noSubscribe=()=>()=>{};
const noState=()=>null;

const effectsKey=(sound:TrackSound)=>JSON.stringify(completeSound(sound).effects);
const baseKeys=new Map<string,string>();
/** The effects of factory sound `factory:id` or preset `preset:id` as a key, worked out once: they do not depend on the instrument. */
function baseKey(kind:'factory'|'preset',id:string):string {
  const name=`${kind}:${id}`;let key=baseKeys.get(name);
  if(key===undefined){const sound=kind==='factory'?factorySound(id):soundPreset(id as TrackSound['presetId']);key=sound?effectsKey(sound):'';baseKeys.set(name,key);}
  return key;
}

/** Names the instrument source and tone currently set on `track`: a factory sound or preset as it was, or the preset it
 * started from marked as edited once a control has moved it. A track with no instrument chosen plays what the native
 * player picks by program (`automatic_voice_id` in voices.rs), and percussion plays the General MIDI drums. */
export function describeTrackSound(track:model.Track,sound?:TrackSound):{voice:string;tone:string} {
  const program=track.playbackInfo.program;
  const automatic=automaticVoice(program,track.isPercussion);
  const voice=sound?.voiceId
    ?(voiceNames as Record<string,string>)[sound.voiceId]??sound.voiceId
    :track.isPercussion
      ?'Percussion'
      :automatic==='gm'?midiPrograms[program]??'Automatic instrument':voiceNames[automatic];
  if(!sound)return {voice,tone:presetName('gm')};
  const {presetId}=completeSound(sound),key=effectsKey(sound);
  const matched=factorySounds.find(item=>item.presetId===presetId&&baseKey('factory',item.id)===key);
  if(matched)return {voice,tone:matched.name};
  return {voice,tone:key===baseKey('preset',presetId)?presetName(presetId):`${presetName(presetId)} (edited)`};
}

export type MixerPlayer=Pick<
  NativePlaybackController,
  'subscribe'|'getState'|'mix'|'setMute'|'setSolo'|'setTrackVolume'|'setPan'|'focus'|'setFocus'
>&Partial<Pick<NativePlaybackController,'previewMix'|'master'|'setMaster'>>;

export interface MixerViewProps {
  score:model.Score;
  sounds?:Record<string,TrackSound>;
  selected:number;
  busy:boolean;
  onSelect:(track:number)=>void;
  player:MixerPlayer|null;
}

/** The Mixer view: one channel strip per track with a vertical volume fader, pan knob, mute, solo, track selection and
 * current sound, session focus for the selected track, and the master output. A fader, pan or focus drag is heard as it
 * moves; each gesture is saved as one undoable `setTrackMix` through the player, matching the dock mixer. */
export function MixerView({score,sounds,selected,busy,onSelect,player}:MixerViewProps):React.JSX.Element {
  const state=useSyncExternalStore(player?.subscribe??noSubscribe,player?.getState??noState);
  const live=useLivePreview(),focusFrom=useRef<number|null>(null);
  // Focus belongs to the selected track (by identity): selecting another track moves it there.
  const selectedId=score.tracks[selected]?trackIdentity(score.tracks[selected]):null;
  const focus=player?.focus(),amount=focus&&focus.track===selectedId?focus.amount:0;
  // Invalid input is prevented by the control; playback failures are reported by the player itself.
  const changeFocus=(value:number)=>selectedId?player?.setFocus(selectedId,value).catch(()=>{}):undefined;
  useEffect(()=>{
    const current=player?.focus();
    if(current&&selectedId&&current.track!==selectedId)void player?.setFocus(selectedId,current.amount).catch(()=>{});
  },[player,selectedId]);
  // A strip belongs to a track, not to a place in the list: a deleted or moved track takes its drag, and the sound it was heard at, with it.
  const ids=score.tracks.map(trackIdentity),idsKey=ids.join('|');
  useEffect(()=>()=>{void live.end();},[live,idsKey]);
  const described=useMemo(()=>score.tracks.map(track=>describeTrackSound(track,sounds?.[trackIdentity(track)])),[score,sounds]);
  const selectedMix=score.tracks[selected]?player?.mix(score.tracks[selected]):undefined;
  const anySolo=score.tracks.some(track=>player?.mix(track)?.solo);
  const silent=Boolean(selectedMix?.mute||(anySolo&&!selectedMix?.solo));
  const focusOff=!player||!state?.ready||Boolean(state.error);
  /** Volume or pan of one track: heard while dragged, then saved once; the player ends the preview when the edit lands. */
  const mixControl=(index:number,patch:(value:number)=>Partial<ChannelMix>,save:(value:number)=>Promise<void>|undefined)=>({
    onInput:(value:number)=>live.hear(()=>player?.previewMix?.(index,patch(value)),()=>player?.previewMix?.(index,null)),
    onCommit:save,
    // A saved drag stays heard until the player holds the edit, so it never steps back to the old level.
    onInputEnd:(committed:boolean)=>{void live.end({keep:committed});},
  });

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
        disabled={busy||focusOff}
        onInput={v=>{
          if(!selectedId)return;
          focusFrom.current??=amount;
          const from=focusFrom.current;
          live.hear(()=>player?.setFocus(selectedId,v/100),()=>player?.setFocus(selectedId,from));
        }}
        onCommit={v=>changeFocus(v/100)}
        onInputEnd={committed=>{focusFrom.current=null;void live.end({keep:committed});}}
      />
      <button type="button" {...busyGuard({busy,unavailable:focusOff||amount===0,className:'mixer-button',onClick:()=>{void changeFocus(0);}})}>Reset focus</button>
      {silent&&<p className="mixer-focus-note">The selected track is silent, so focusing it lowers everything you hear.</p>}
    </section>
    <div className="mixer-strips">
      {score.tracks.map((track,position)=>{
        const sound=described[position];
        const mix=player?.mix(track),mute=mix?.mute??track.playbackInfo.isMute,solo=mix?.solo??track.playbackInfo.isSolo,volume=mix?.volume??1,pan=mix?.pan??0;
        const isSelected=track.index===selected,off=busy||!player;
        const volumeControl=mixControl(track.index,gain=>({gain}),value=>player?.setTrackVolume(track.index,value));
        const panControl=mixControl(track.index,value=>({pan:value}),value=>player?.setPan(track.index,value));
        return <section className={`mixer-strip${isSelected?' selected':''}`} data-selected={isSelected||undefined} key={ids[position]} aria-label={`Channel ${track.index+1}: ${track.name}`}>
          <div className="mixer-strip-head">
            <button type="button" title={track.name} aria-label={`Track ${track.index+1}: ${track.name}`} aria-pressed={isSelected} {...busyGuard({busy,className:'mixer-strip-select',onClick:()=>onSelect(track.index)})}>
              <span className="track-color-swatch" aria-hidden="true" style={{backgroundColor:trackColorHex(track.color)}}/>
              <span className="mixer-strip-name">{track.index+1}. {track.name||`Track ${track.index+1}`}</span>
            </button>
            {/* The slot is always there, so selecting a track moves nothing. */}
            <span className="mixer-strip-status" data-on={isSelected||undefined}>{isSelected?'Selected':''}</span>
          </div>
          <div className="mixer-strip-sound" role="group" aria-label={`Sound ${track.name}`}>
            <span className="mixer-strip-voice" title={sound.voice}>{sound.voice}</span>
            <span className="mixer-strip-preset" title={sound.tone}>{sound.tone}</span>
          </div>
          <div className="mixer-strip-switches">
            <label className="mixer-switch" data-kind="mute" data-active={mute||undefined} data-disabled={off||undefined}>
              <input type="checkbox" checked={mute} aria-disabled={off||undefined} onChange={e=>{if(!off)void player?.setMute(track.index,e.target.checked);}}/>
              <span>Mute</span>
            </label>
            <label className="mixer-switch" data-kind="solo" data-active={solo||undefined} data-disabled={off||undefined}>
              <input type="checkbox" checked={solo} aria-disabled={off||undefined} onChange={e=>{if(!off)void player?.setSolo(track.index,e.target.checked);}}/>
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
            disabled={off}
            {...panControl}
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
              disabled={off}
              {...volumeControl}
            />
          </div>
        </section>;
      })}
    </div>
    <MasterPanel master={player?.master?.()} disabled={busy||!player?.setMaster} onChange={next=>player!.setMaster!(next)}/>
  </section>;
}
