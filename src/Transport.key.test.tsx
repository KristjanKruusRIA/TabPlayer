// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import { DEFAULT_PRACTICE,type PracticeSettings } from './audio/practice-types';
import { setLanguagePreference } from './i18n';

const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
afterEach(()=>{cleanup();setLanguagePreference('en');vi.unstubAllGlobals();});
function snapshot(settings:PracticeSettings=structuredClone(DEFAULT_PRACTICE),patch:Partial<PlaybackState>={}):PlaybackState {
  return {ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,practice:{settings,phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null,...patch};
}
function playerFor(initial:PlaybackState) {
  let state=initial;const listeners=new Set<()=>void>();
  const player={generation:7,getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setPractice:vi.fn(),stepKeyShift:vi.fn(),setKeyShift:vi.fn(),cursorPlaybackChoices:vi.fn(()=>[]),selectionPlaybackChoices:vi.fn(()=>[]),playbackOccurrences:()=>[],playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn()};
  return {player,update:(next:PlaybackState)=>act(()=>{state=next;for(const listener of listeners)listener();})};
}
const shifted=(tonality:number,patch:Partial<PlaybackState>={})=>snapshot({...structuredClone(DEFAULT_PRACTICE),tonality},patch);
const show=(state:PlaybackState,busy=false)=>{const made=playerFor(state);const view=render(<Transport cursor={cursor} selection={null} player={made.player as never} measures={4} busy={busy}/>);return {...made,view};};
const lower=()=>screen.getByRole('button',{name:'Lower the key'}),raise=()=>screen.getByRole('button',{name:'Raise the key'}),reset=()=>screen.getByRole('button',{name:'Original key'});
const said=()=>document.querySelector('.transport-key-said')!;

it('shows_the_key_group_with_its_value_and_a_session_only_hint',()=>{
  show(shifted(3));
  const group=screen.getByRole('group',{name:'Key'});
  expect(group).toHaveTextContent('+3');expect(screen.getByRole('status',{name:'Key shift'})).toHaveTextContent('+3');
  expect(group).toHaveAccessibleDescription(/this session only.*exports keep the original key/i);
  cleanup();show(snapshot());expect(screen.getByRole('status',{name:'Key shift'})).toHaveTextContent('0');
  cleanup();show(shifted(-2));expect(screen.getByRole('status',{name:'Key shift'})).toHaveTextContent(/^[−-]2$/);
});
it('each_click_asks_the_player_for_one_step_or_the_original_key_and_never_writes_settings_itself',()=>{
  const {player}=show(shifted(4));
  fireEvent.click(raise());expect(player.stepKeyShift).toHaveBeenLastCalledWith(1);
  fireEvent.click(lower());expect(player.stepKeyShift).toHaveBeenLastCalledWith(-1);
  fireEvent.click(reset());expect(player.setKeyShift).toHaveBeenLastCalledWith(0);
  expect(player.stepKeyShift).toHaveBeenCalledTimes(2);expect(player.setPractice).not.toHaveBeenCalled();expect(player.setSpeed).not.toHaveBeenCalled();
});
it('the_ends_and_the_original_key_send_nothing_and_stay_in_place_aria_disabled',()=>{
  const {player,update}=show(snapshot());
  expect(reset()).toHaveAttribute('aria-disabled','true');fireEvent.click(reset());expect(player.setKeyShift).not.toHaveBeenCalled();
  update(shifted(12));expect(raise()).toHaveAttribute('aria-disabled','true');fireEvent.click(raise());expect(player.stepKeyShift).not.toHaveBeenCalled();expect(lower()).not.toHaveAttribute('aria-disabled');
  update(shifted(-12));expect(lower()).toHaveAttribute('aria-disabled','true');fireEvent.click(lower());expect(player.stepKeyShift).not.toHaveBeenCalled();
  for(const button of [lower(),raise(),reset()])expect(button).not.toBeDisabled();
  update(shifted(5));expect(reset()).not.toHaveAttribute('aria-disabled');
  // The ends follow the key asked for, not only the acknowledged one: Raise at a pending +12 is out.
  update(shifted(5,{practicePending:true,keyTarget:12}));expect(raise()).toHaveAttribute('aria-disabled','true');expect(reset()).not.toHaveAttribute('aria-disabled');
  update(shifted(5,{practicePending:true,keyTarget:0}));expect(reset()).toHaveAttribute('aria-disabled','true');
});
it('a_pending_shift_is_shown_pending_keeps_focus_and_further_steps_are_handed_to_the_player_to_coalesce',()=>{
  const {player,update}=show(shifted(2));
  raise().focus();expect(raise()).toHaveFocus();
  update(shifted(2,{practicePending:true,keyTarget:3}));
  expect(raise()).toHaveFocus();expect(raise()).not.toBeDisabled();expect(raise()).not.toHaveAttribute('aria-disabled');
  expect(screen.getByRole('group',{name:'Key'})).toHaveAttribute('data-pending','true');
  expect(screen.getByText('Applying practice settings…')).toBeInTheDocument();
  fireEvent.click(raise());fireEvent.click(raise());expect(player.stepKeyShift).toHaveBeenCalledTimes(2);
  update(shifted(3));expect(screen.getByRole('status',{name:'Key shift'})).toHaveTextContent('+3');expect(raise()).toHaveFocus();expect(screen.getByRole('group',{name:'Key'})).not.toHaveAttribute('data-pending');
});
it('a_pending_key_is_shown_in_the_group_and_not_in_the_messages_row_so_nothing_moves_under_the_pointer',()=>{
  const {update}=show(shifted(2));
  update(shifted(2,{practicePending:true,keyTarget:3}));
  expect(document.querySelector('.transport-messages')).toBeNull();
  expect(screen.getByRole('group',{name:'Key'})).toHaveTextContent('Applying practice settings…');
  // Another pending setting still uses the row.
  update(shifted(2,{practicePending:true,keyTarget:2}));expect(document.querySelector('.transport-messages')).toHaveTextContent('Applying practice settings…');
});
it('a_busy_editor_blocks_the_key_with_aria_disabled_never_disabled',()=>{
  const {player}=show(shifted(1),true);
  for(const button of [lower(),raise(),reset()]){expect(button).toHaveAttribute('aria-disabled','true');expect(button).not.toBeDisabled();fireEvent.click(button);}
  expect(player.stepKeyShift).not.toHaveBeenCalled();expect(player.setKeyShift).not.toHaveBeenCalled();
});
it('any_acknowledged_key_change_is_announced_once_politely_except_a_document_switch_and_a_first_render',()=>{
  const {update}=show(shifted(2));
  expect(said()).toHaveAttribute('role','status');expect(said()).toHaveAttribute('aria-live','polite');expect(said()).toBeEmptyDOMElement();
  update(shifted(2,{practicePending:true,keyTarget:3}));expect(said()).toBeEmptyDOMElement();
  update(shifted(3));expect(said()).toHaveTextContent('Key +3');
  // A key that lands without a pending request in view (a late echo after a timeout, a carried key after an edit) is announced too.
  update(shifted(5));expect(said()).toHaveTextContent('Key +5');
  // A reset that comes with another document is not.
  update(shifted(0,{documentSerial:1}));expect(said()).toHaveTextContent('Key +5');
  update(shifted(1,{documentSerial:1}));expect(said()).toHaveTextContent('Key +1');
  expect(said().closest('.transport-more')).toBeNull();
});
it('an_identical_second_refusal_is_announced_again',()=>{
  const {update}=show(shifted(3));
  update(shifted(3,{practiceNotice:'key_shift_refused'}));const first=said().textContent;
  update(shifted(3,{practicePending:true,keyTarget:4}));update(shifted(3,{practiceNotice:'key_shift_refused'}));
  expect(said().textContent).not.toBe(first);expect(said().textContent).toContain('The key change was not applied. The key stays at +3.');
});
it('a_refused_shift_shows_one_translated_message_announced_once_and_no_raw_error',()=>{
  const {update}=show(shifted(3));
  update(shifted(3,{practiceNotice:'key_shift_refused'}));
  expect(screen.getAllByText('The key change was not applied. The key stays at +3.')).toHaveLength(2);
  expect(said()).toHaveTextContent('The key change was not applied. The key stays at +3.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.queryByText(/Fixed tempo/)).not.toBeInTheDocument();
  update(shifted(3));expect(document.querySelector('.transport-messages')?.textContent??'').not.toMatch(/not applied/);
  expect(document.querySelectorAll('.transport-messages [role=status]')).toHaveLength(0);
});
it('a_change_that_was_never_confirmed_says_so_in_one_translated_message',()=>{
  show(snapshot(structuredClone(DEFAULT_PRACTICE),{practiceNotice:'practice_unconfirmed'}));
  expect(screen.getByText('The practice change was not confirmed. The settings stay as they were.')).toBeInTheDocument();
});
it('the_labels_the_hint_and_the_announcement_are_translated_in_german_and_estonian',()=>{
  const cases={
    de:{group:'Tonart',buttons:['Tonart senken','Tonart erhöhen','Originaltonart'],value:'Tonartverschiebung',hint:/nur für diese Sitzung.*Exporte behalten die Originaltonart/,said:'Tonart +1'},
    et:{group:'Helistik',buttons:['Madalda helistikku','Tõsta helistikku','Algne helistik'],value:'Helistiku nihe',hint:/ainult selle seansi ajaks.*eksport säilitab algse helistiku/,said:'Helistik +1'},
  } as const;
  for(const [language,expected] of Object.entries(cases)){
    cleanup();setLanguagePreference(language as 'de'|'et');
    const {update}=show(shifted(0));update(shifted(0,{practicePending:true,keyTarget:1}));update(shifted(1));
    const group=screen.getByRole('group',{name:expected.group});
    for(const name of expected.buttons)expect(screen.getByRole('button',{name})).toBeInTheDocument();
    expect(screen.getByRole('status',{name:expected.value})).toHaveTextContent('+1');
    expect(group).toHaveAccessibleDescription(expected.hint);expect(said()).toHaveTextContent(expected.said);
  }
});
it('the_buttons_carry_the_data_actions_the_command_palette_clicks',()=>{
  show(shifted(1));
  expect(lower()).toHaveAttribute('data-action','key-lower');expect(raise()).toHaveAttribute('data-action','key-raise');expect(reset()).toHaveAttribute('data-action','key-reset');
});
it('in_a_narrow_window_the_key_group_is_folded_into_more_playback_so_the_row_cannot_push_it_off',()=>{
  const media=(matches:boolean)=>vi.stubGlobal('matchMedia',(query:string)=>({matches,media:query,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{},onchange:null,dispatchEvent:()=>false}));
  media(false);show(shifted(1));expect(screen.getByRole('group',{name:'Key'}).closest('.transport-more')).toBeNull();
  cleanup();media(true);const {player}=show(shifted(1));
  const group=screen.getByRole('group',{name:'Key'});expect(group.closest('.transport-more')).not.toBeNull();expect(screen.getAllByRole('group',{name:'Key'})).toHaveLength(1);
  fireEvent.click(raise());expect(player.stepKeyShift).toHaveBeenCalledWith(1);
});
it('while_the_score_is_prepared_the_key_buttons_are_outside_the_disabled_row_so_focus_is_kept_and_nothing_else_wakes_up',()=>{
  const media=(matches:boolean)=>vi.stubGlobal('matchMedia',(query:string)=>({matches,media:query,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{},onchange:null,dispatchEvent:()=>false}));
  for(const narrow of [false,true]){
    cleanup();media(narrow);const {update}=show(shifted(1));
    expect(raise().closest('fieldset')).toBeNull();
    raise().focus();update(shifted(1,{ready:false}));
    expect(raise()).toHaveFocus();expect(raise()).not.toBeDisabled();expect(raise()).toHaveAttribute('aria-disabled','true');
    // The row's other controls stay disabled for as long as the score is prepared, key focus or not.
    expect(document.querySelector('fieldset.transport-fields')).toBeDisabled();
    expect(screen.getByRole('button',{name:'Play'})).toBeDisabled();expect(screen.getByRole('button',{name:'Faster'}).closest('fieldset')).toBeDisabled();
  }
});
it('a_shift_in_a_folded_group_leaves_a_labelled_mark_in_the_more_playback_summary',()=>{
  const media=(matches:boolean)=>vi.stubGlobal('matchMedia',(query:string)=>({matches,media:query,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{},onchange:null,dispatchEvent:()=>false}));
  const summary=()=>document.querySelector('.transport-more>summary')!;
  media(true);const {update}=show(shifted(3));
  const mark=summary().querySelector('.transport-keymark')!;
  expect(mark).toHaveTextContent('♮ +3');expect(mark).toHaveAttribute('role','img');expect(mark).toHaveAccessibleName('Key +3');
  expect(summary()).toHaveAccessibleName('More playback Key +3');
  update(snapshot());expect(summary().querySelector('.transport-keymark')).toBeNull();
  update(shifted(-2));expect(summary().querySelector('.transport-keymark')).toHaveAccessibleName(/^Key [−-]2$/);
  cleanup();media(false);show(shifted(3));expect(summary().querySelector('.transport-keymark')).toBeNull();
  cleanup();setLanguagePreference('de');media(true);show(shifted(3));expect(summary().querySelector('.transport-keymark')).toHaveAccessibleName('Tonart +3');
  cleanup();setLanguagePreference('et');media(true);show(shifted(3));expect(summary().querySelector('.transport-keymark')).toHaveAccessibleName('Helistik +3');
});
it('a_key_button_that_had_focus_keeps_it_when_the_window_crosses_the_breakpoint',()=>{
  const listeners=new Set<()=>void>();let matches=false;
  vi.stubGlobal('matchMedia',(query:string)=>({get matches(){return matches;},media:query,addEventListener:(_:string,listener:()=>void)=>{listeners.add(listener);},removeEventListener:(_:string,listener:()=>void)=>{listeners.delete(listener);},addListener:()=>{},removeListener:()=>{},onchange:null,dispatchEvent:()=>false}));
  show(shifted(1));
  raise().focus();expect(raise()).toHaveFocus();
  act(()=>{matches=true;for(const listener of listeners)listener();});
  expect(screen.getByRole('group',{name:'Key'}).closest('.transport-more')).not.toBeNull();
  expect(document.querySelector('.transport-more')).toHaveAttribute('open');
  expect(raise()).toHaveFocus();expect(document.body).not.toHaveFocus();
  act(()=>{matches=false;for(const listener of listeners)listener();});
  expect(screen.getByRole('group',{name:'Key'}).closest('.transport-more')).toBeNull();expect(raise()).toHaveFocus();
  // Focus elsewhere is not moved.
  screen.getByRole('button',{name:'Play'}).focus();
  act(()=>{matches=true;for(const listener of listeners)listener();});
  expect(screen.getByRole('button',{name:'Play'})).toHaveFocus();
});
