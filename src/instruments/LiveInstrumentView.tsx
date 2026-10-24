import { useMemo, useState, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { trackIdentity } from '../engine';
import type { BeatTarget } from '../project';
import { focusNotes, type InstrumentFocus } from './focus';
import type { EditCommand } from '../edit-types';
import type { EntryFollow } from './entry';
import { InstrumentView } from './InstrumentView';

const editKey='tabplayer.instrument.editNotes';
function storedEditing() { try { return localStorage.getItem(editKey) === 'on'; } catch { return false; } }
const noSubscribe=()=>()=>{};
const noState=()=>null;
const focuses:Record<InstrumentFocus,{label:string;caption:string;empty:string}>={
  playing:{label:'Playing notes',caption:'Sounding notes',empty:'No notes sounding'},
  beat:{label:'Selected beat',caption:'Notes in the selected beat',empty:'No notes in the selected beat'},
  bar:{label:'Selected bar',caption:'Notes in the selected bar',empty:'No notes in the selected bar'},
  next:{label:'Next beat',caption:'Notes in the next beat',empty:'No later notes on this staff'},
};
export function LiveInstrumentView({score,track,staff,target=null,player,onEdit,busy=false,string}: {
  score:model.Score;track:number;staff:number;target?:BeatTarget|null;
  /** Sends an edit made from the view through the app's edit path; without it the view cannot edit. */
  onEdit?:(command:EditCommand,follow:EntryFollow)=>void;busy?:boolean;string?:number;
  player:(Pick<NativePlaybackController,'subscribe'|'getState'|'activeNotes'>&Partial<Pick<NativePlaybackController,'scheduledNotes'>>)|null;
}) {
  const [focus,setFocus]=useState<InstrumentFocus>('playing'),[editing,setEditing]=useState(storedEditing);
  const editMode=editing&&!!onEdit;
  const chooseEditing=(on:boolean)=>{setEditing(on);try{localStorage.setItem(editKey,on?'on':'off');}catch{/* the choice still applies to this view */}};
  const state=useSyncExternalStore(player?.subscribe??noSubscribe,player?.getState??noState);
  const id=trackIdentity(score.tracks[track]),active=player?.activeNotes(id)??[];
  const scheduled=focus==='playing'?null:player?.scheduledNotes?.(id)??null;
  // Only the next beat moves with playback; the selected beat and bar depend on the plan and the selection alone.
  const tick=focus==='next'?scheduled?.tick??null:null,{notes:planned,beats,counting,loop,range}=scheduled??{};
  const picked=useMemo(()=>planned&&beats?focusNotes(focus,{notes:planned,beats,tick,counting:!!counting,loop:loop??null,range:range??null,active:[],target}):[],
    [focus,planned,beats,tick,counting,loop?.startTick,loop?.endTick,range?.endTick,target?.track,target?.staff,target?.bar,target?.voice,target?.beat]);
  const shownFocus:InstrumentFocus=editMode?'beat':focus,notes=focus==='playing'?active:picked,shown=focuses[shownFocus];
  const empty=editMode||focus==='playing'?shown.empty:state?.error?'Playback is unavailable':!state?.ready||!scheduled?'Playback is not ready yet':shown.empty;
  return <section className="live-instrument-view" aria-label="Instrument view">
    <InstrumentView score={score} track={track} staff={staff} notes={notes} caption={shown.caption} empty={empty}
      entry={editing&&onEdit?{target,busy,string,onEdit}:undefined}
      controls={<>{onEdit?<label className="instrument-check"><input type="checkbox" checked={editing} onChange={event=>chooseEditing(event.target.checked)}/>Click to edit notes</label>:null}<label>Show<select value={focus} disabled={editMode} onChange={event=>setFocus(event.target.value as InstrumentFocus)}>{Object.entries(focuses).map(([value,{label}])=><option key={value} value={value}>{label}</option>)}</select></label></>}/>
  </section>;
}
