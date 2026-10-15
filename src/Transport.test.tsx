// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import { DEFAULT_PRACTICE } from './audio/practice-types';
afterEach(()=>{cleanup();vi.useRealTimers();});
function snapshot(patch:Partial<PlaybackState>={}):PlaybackState {return {ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null,...patch};}
function playerFor(initial=snapshot()) {
  let state=initial;const listeners=new Set<()=>void>();
  const player={getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setMetronome:vi.fn(),setPractice:vi.fn()};
  return {player,update:(next:PlaybackState)=>act(()=>{state=next;for(const listener of listeners)listener();})};
}
it('uses structural native transport controls and validates measure drafts',()=>{
  const {player,update}=playerFor();
  const view=render(<Transport player={player} measures={4} busy={false}/>);fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'1.5'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(0);
  fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(3);
  fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(0,0);update(snapshot({loop:{startTick:0,endTick:3840}}));fireEvent.click(screen.getByRole('button',{name:'Clear loop'}));expect(player.clearLoop).toHaveBeenCalled();
  view.rerender(<Transport player={player} measures={2} busy={false}/>);expect(screen.getByLabelText('Seek measure')).toHaveValue(2);view.rerender(<Transport player={player} measures={2} busy/>);expect(screen.getByRole('button',{name:'Play'})).toBeDisabled();
});
it('loop_pressed_state_waits_for_native_acknowledgement_and_retains_failed_clear',()=>{
  const {player,update}=playerFor();render(<Transport player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(0,0);expect(screen.getByRole('button',{name:'Loop'})).toHaveAttribute('aria-pressed','false');
  update(snapshot({loop:{startTick:0,endTick:3840}}));expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');fireEvent.click(screen.getByRole('button',{name:'Clear loop'}));expect(player.clearLoop).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');
  update(snapshot({loop:{startTick:0,endTick:3840},error:'Loop clear failed.'}));expect(screen.getByRole('alert')).toHaveTextContent('Loop clear failed.');expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');
  update(snapshot());expect(screen.getByRole('button',{name:'Loop'})).toHaveAttribute('aria-pressed','false');
});
it('custom_acknowledged_coefficients_and_full_relative_endpoints_are_displayed_without_dispatch',()=>{
  const state=snapshot({speed:123});state.practice.effectiveRatio=1.23;state.practice.currentBpm=147.6;state.practice.settings.tempo={kind:'relative',ratio:1.23};const {player,update}=playerFor(state);render(<Transport player={player} measures={4} busy={false}/>);
  expect(screen.getByLabelText('Speed')).toHaveValue('123');expect(screen.getByRole('option',{name:'123%'})).toBeInTheDocument();expect(screen.getByRole('status',{name:'Practice playback'})).toHaveTextContent(/147.6 BPM.*123%.*Completed passes 0/);
  fireEvent.change(screen.getByLabelText('Speed'),{target:{value:'10'}});expect(player.setSpeed).toHaveBeenLastCalledWith(10);fireEvent.change(screen.getByLabelText('Speed'),{target:{value:'300'}});expect(player.setSpeed).toHaveBeenLastCalledWith(300);
  const fixed=snapshot({speed:75});fixed.practice.settings.tempo={kind:'fixed',bpm:90};fixed.practice.currentBpm=90;fixed.practice.effectiveRatio=.75;update(fixed);expect(screen.getByLabelText('Speed')).toBeDisabled();expect(screen.getByLabelText('Practice playback')).toHaveTextContent(/90 BPM.*75%/);expect(player.setSpeed).toHaveBeenCalledTimes(2);expect(player.setPractice).not.toHaveBeenCalled();
});
it('pending_settings_disable_only_settings_controls_while_pause_stop_keep_working',()=>{
  const {player}=playerFor(snapshot({playing:true,practicePending:true}));render(<Transport player={player} measures={4} busy={false}/>);
  expect(screen.getByLabelText('Speed')).toBeDisabled();expect(screen.getByLabelText('Metronome')).toBeDisabled();expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Pause'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(player.pause).toHaveBeenCalledTimes(1);expect(player.stop).toHaveBeenCalledTimes(1);expect(player.setPractice).not.toHaveBeenCalled();
});
it('metronome_toggle_preserves_zero_volume_visual_and_other_practice_settings',()=>{
  const state=snapshot();state.practice.settings={tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};const {player}=playerFor(state);render(<Transport player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByLabelText('Metronome'));expect(player.setPractice).toHaveBeenCalledWith({tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}});expect(player.setMetronome).not.toHaveBeenCalled();expect(state.practice.settings.metronome.enabled).toBe(false);
  const emitted=player.setPractice.mock.calls[0][0];expect(emitted.metronome).not.toBe(state.practice.settings.metronome);
});
it('count_paused_count_and_pulses_render_only_acknowledged_native_state',()=>{
  vi.useFakeTimers();const state=snapshot({playing:true});state.practice={...state.practice,phase:'countIn',countInRemaining:3,completedPasses:2,pulse:{serial:42,beat:1,beatsPerBar:4,accent:false,counting:true}};const {player,update}=playerFor(state);render(<Transport player={player} measures={4} busy={false}/>);
  expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/Count-in.*3.*remaining/);expect(screen.getByRole('status',{name:'Metronome pulse'})).toHaveAttribute('data-pulse-serial','42');expect(screen.getByLabelText('Metronome pulse')).toHaveTextContent('Count-in beat 2 of 4');expect(screen.getByLabelText('Metronome pulse')).toHaveAttribute('aria-live','off');expect(screen.getByLabelText('Practice playback')).toHaveTextContent('Completed passes 2');
  act(()=>{vi.advanceTimersByTime(5000);});expect(screen.getByText('0:01 / 0:06 · M1')).toBeInTheDocument();expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/3.*remaining/);expect(player.setSpeed).not.toHaveBeenCalled();expect(player.setPractice).not.toHaveBeenCalled();
  update({...state,playing:false,practice:{...state.practice,phase:'paused'}});expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/Count-in paused.*3.*remaining/);expect(screen.getByRole('button',{name:'Play'})).toBeEnabled();expect(screen.getByLabelText('Metronome pulse')).toHaveAttribute('data-pulse-serial','42');
  update(snapshot());expect(screen.queryByLabelText('Metronome pulse')).not.toBeInTheDocument();expect(screen.queryByRole('status',{name:'Count-in'})).not.toBeInTheDocument();
});
it('practice_notices_are_visible_and_control_errors_stay_inline',()=>{
  const {player}=playerFor(snapshot({practiceNotice:'Fixed tempo disabled because this score has backing audio.'}));player.setSpeed.mockImplementation(()=>{throw new Error('Practice change rejected.');});render(<Transport player={player} measures={4} busy={false}/>);
  expect(screen.getByText('Fixed tempo disabled because this score has backing audio.')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('Speed'),{target:{value:'50'}});expect(screen.getByRole('alert')).toHaveTextContent('Practice change rejected.');
});
