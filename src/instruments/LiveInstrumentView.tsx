import { useI18n } from '../i18n';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { model } from '@coderline/alphatab';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import type { BeatTarget } from '../project';
import type { InstrumentFocus } from './focus';
import { useFocusedNotes } from './use-focused-notes';
import type { EditCommand } from '../edit-types';
import type { EntryFollow } from './entry';
import { InstrumentView, type PickBy } from './InstrumentView';
import { announceInstrumentFocus, currentInstrumentFocus, currentInstrumentSettingsProblem, readInstrumentViewPreferences, subscribeInstrumentFocus, subscribeInstrumentSettingsProblem, writeInstrumentViewPreferences } from './view-preferences';

export function LiveInstrumentView({score,track,staff,target=null,noteIndex=null,player,onEdit,onSelect,busy=false,locked=false,string,panel}: {
  score:model.Score;track:number;staff:number;target?:BeatTarget|null;
  /** Sends an edit made from the view through the app's edit path; without it the view cannot edit. */
  onEdit?:(command:EditCommand,follow:EntryFollow)=>void;/** Selects in the score the beat, string and note of a mark clicked in the view. */onSelect?:(target:BeatTarget,string:number|undefined,noteIndex:number|undefined,by:PickBy)=>void;/** The note selected in the score: a pick of the same position then moves on from it. */noteIndex?:number|null;busy?:boolean;/** The document is finalized: entry mode is unavailable. */locked?:boolean;string?:number;/** Shows one instrument alone, as its own dock panel. */panel?:'keyboard';
  player:(Pick<NativePlaybackController,'subscribe'|'getState'|'activeNotes'>&Partial<Pick<NativePlaybackController,'scheduledNotes'>>)|null;
}) {
  const { t } = useI18n();
  const focuses:Record<InstrumentFocus,{label:string;caption:string;empty:string}>={
    playing:{label:t('instruments.focus_playing'),caption:t('instruments.caption_playing'),empty:t('instruments.empty_playing')},
    beat:{label:t('instruments.focus_beat'),caption:t('instruments.caption_beat'),empty:t('instruments.empty_beat')},
    bar:{label:t('instruments.focus_bar'),caption:t('instruments.caption_bar'),empty:t('instruments.empty_bar')},
    next:{label:t('instruments.focus_next'),caption:t('instruments.caption_next'),empty:t('instruments.empty_next')},
  };
  const [saved]=useState(readInstrumentViewPreferences),[focus,setFocusNow]=useState<InstrumentFocus>(saved.focus),[editing,setEditing]=useState(saved.clickToEdit);
  useEffect(()=>subscribeInstrumentFocus(()=>setFocusNow(currentInstrumentFocus())),[]);
  const setFocus=(value:InstrumentFocus)=>{setFocusNow(value);writeInstrumentViewPreferences({focus:value});announceInstrumentFocus(value);};
  const editMode=editing&&!!onEdit&&!locked;
  const chooseEditing=(on:boolean)=>{setEditing(on);writeInstrumentViewPreferences({clickToEdit:on});};
  const settingsProblem=useSyncExternalStore(subscribeInstrumentSettingsProblem,currentInstrumentSettingsProblem);
  const {state,notes,held,scheduled}=useFocusedNotes({score,track,target,player,focus});
  const shownFocus:InstrumentFocus=editMode?'beat':focus,shown=focuses[shownFocus];
  const empty=editMode||focus==='playing'?shown.empty:state?.error?t('instruments.playback_unavailable'):!state?.ready||!scheduled?t('instruments.playback_not_ready'):shown.empty;
  return <section className="live-instrument-view" aria-label={panel==='keyboard'?t('instruments.keyboard_panel'):t('instruments.instrument_view')}>
    <InstrumentView lockedMode={panel==='keyboard'?'keys':undefined} score={score} track={track} staff={staff} notes={notes} held={held} caption={shown.caption} empty={empty}
      onSelect={onSelect} selected={target?{target,noteIndex}:null} entry={editing&&onEdit&&!locked?{target,busy,string,onEdit}:undefined}
      controls={<>{settingsProblem?<span className="instrument-settings-note" role="status">{t(settingsProblem==='newer'?'instruments.settings_newer':'instruments.settings_not_saved')}</span>:null}{onEdit?<label className="instrument-check"><input type="checkbox" checked={editing&&!locked} disabled={locked} title={locked?t('project.finalized'):undefined} onChange={event=>chooseEditing(event.target.checked)}/>{t('instruments.click_to_edit')}</label>:null}<label>{t('instruments.show_focus')}<select value={focus} disabled={editMode} onChange={event=>setFocus(event.target.value as InstrumentFocus)}>{Object.entries(focuses).map(([value,{label}])=><option key={value} value={value}>{label}</option>)}</select></label></>}/>
  </section>;
}
