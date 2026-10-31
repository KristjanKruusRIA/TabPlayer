import { useI18n } from '../i18n';
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { trackIdentity } from '../engine';
import { FINALIZED_MESSAGE, type BeatTarget } from '../project';
import { focusNotes, type InstrumentFocus } from './focus';
import type { EditCommand } from '../edit-types';
import type { EntryFollow } from './entry';
import { InstrumentView } from './InstrumentView';

const editKey='tabplayer.instrument.editNotes';
function storedEditing() { try { return localStorage.getItem(editKey) === 'on'; } catch { return false; } }
const noSubscribe=()=>()=>{};
const noState=()=>null;
export function LiveInstrumentView({score,track,staff,target=null,player,onEdit,busy=false,locked=false,string}: {
  score:model.Score;track:number;staff:number;target?:BeatTarget|null;
  /** Sends an edit made from the view through the app's edit path; without it the view cannot edit. */
  onEdit?:(command:EditCommand,follow:EntryFollow)=>void;busy?:boolean;/** The document is finalized: entry mode is unavailable. */locked?:boolean;string?:number;
  player:(Pick<NativePlaybackController,'subscribe'|'getState'|'activeNotes'>&Partial<Pick<NativePlaybackController,'scheduledNotes'>>)|null;
}) {
  const { t } = useI18n();
  const focuses:Record<InstrumentFocus,{label:string;caption:string;empty:string}>={
    playing:{label:t('instruments.focus_playing'),caption:t('instruments.caption_playing'),empty:t('instruments.empty_playing')},
    beat:{label:t('instruments.focus_beat'),caption:t('instruments.caption_beat'),empty:t('instruments.empty_beat')},
    bar:{label:t('instruments.focus_bar'),caption:t('instruments.caption_bar'),empty:t('instruments.empty_bar')},
    next:{label:t('instruments.focus_next'),caption:t('instruments.caption_next'),empty:t('instruments.empty_next')},
  };
  const [focus,setFocus]=useState<InstrumentFocus>('playing'),[editing,setEditing]=useState(storedEditing);
  const editMode=editing&&!!onEdit&&!locked;
  const chooseEditing=(on:boolean)=>{setEditing(on);try{localStorage.setItem(editKey,on?'on':'off');}catch{/* the choice still applies to this view */}};
  const state=useSyncExternalStore(player?.subscribe??noSubscribe,player?.getState??noState);
  const id=trackIdentity(score.tracks[track]),active=player?.activeNotes(id)??[];
  const scheduled=focus==='playing'?null:player?.scheduledNotes?.(id)??null;
  // Only the next beat moves with playback; the selected beat and bar depend on the plan and the selection alone.
  const tick=focus==='next'?scheduled?.tick??null:null,{notes:planned,beats,counting,loop,range}=scheduled??{};
  const picked=useMemo(()=>planned&&beats?focusNotes(focus,{notes:planned,beats,tick,counting:!!counting,loop:loop??null,range:range??null,active:[],target}):[],
    [focus,planned,beats,tick,counting,loop?.startTick,loop?.endTick,range?.endTick,target?.track,target?.staff,target?.bar,target?.voice,target?.beat]);
  const shownFocus:InstrumentFocus=editMode?'beat':focus,notes=focus==='playing'?active:picked,shown=focuses[shownFocus];
  const empty=editMode||focus==='playing'?shown.empty:state?.error?t('instruments.playback_unavailable'):!state?.ready||!scheduled?t('instruments.playback_not_ready'):shown.empty;
  return <section className="live-instrument-view" aria-label={t('instruments.instrument_view')}>
    <InstrumentView score={score} track={track} staff={staff} notes={notes} caption={shown.caption} empty={empty}
      entry={editing&&onEdit&&!locked?{target,busy,string,onEdit}:undefined}
      controls={<>{onEdit?<label className="instrument-check"><input type="checkbox" checked={editing&&!locked} disabled={locked} title={locked?FINALIZED_MESSAGE:undefined} onChange={event=>chooseEditing(event.target.checked)}/>{t('instruments.click_to_edit')}</label>:null}<label>{t('instruments.show_focus')}<select value={focus} disabled={editMode} onChange={event=>setFocus(event.target.value as InstrumentFocus)}>{Object.entries(focuses).map(([value,{label}])=><option key={value} value={value}>{label}</option>)}</select></label></>}/>
  </section>;
}
