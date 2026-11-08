// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Transport } from './Transport';
import type { PlaybackState } from './audio/types';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import { NativePlaybackController } from './audio/NativePlaybackController';
import type { NativeAudioBridge,NativeAudioStatus } from './audio/bridge';
import { buildDocument,previewEdit } from './engine';
import { blankProject } from './project';
const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
const cursorChoices=[{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:1,startTick:3840}];
const passage={generation:7,startOccurrence:0,endOccurrence:0,startTick:480,endTick:1920};
const occurrences=[0,1].map(occurrence=>({bar:0,occurrence,startTick:occurrence*3840,endTick:(occurrence+1)*3840,startMs:occurrence*2000,endMs:(occurrence+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]}));
afterEach(()=>{cleanup();vi.useRealTimers();});
function renderTransport(element:Parameters<typeof render>[0]) {
  const view=render(element),summary=screen.queryByText(/^More playback/,{selector:'summary'});
  if(summary&&!summary.closest('details')!.open)fireEvent.click(summary);return view;
}
function snapshot(patch:Partial<PlaybackState>={}):PlaybackState {return {ready:true,playing:false,time:1000,endTime:6000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null,...patch};}
function playerFor(initial=snapshot()) {
  let state=initial;const listeners=new Set<()=>void>();
  const player={generation:7,getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},play:vi.fn(),pause:vi.fn(),stop:vi.fn(),setSpeed:vi.fn(),setLoop:vi.fn(),clearLoop:vi.fn(),seekToMeasure:vi.fn(),setMetronome:vi.fn(),setPractice:vi.fn(),cursorPlaybackChoices:vi.fn(()=>cursorChoices),selectionPlaybackChoices:vi.fn(()=>[passage]),playbackOccurrences:()=>occurrences,playFromCursor:vi.fn(),playSelection:vi.fn(),loopSelection:vi.fn()};
  return {player,update:(next:PlaybackState)=>act(()=>{state=next;for(const listener of listeners)listener();})};
}
it('fresh cursor Play requires an explicit repeated occurrence while paused Resume and acknowledged loops remain usable',()=>{
  const idle=snapshot({practice:{...snapshot().practice,phase:'idle'}}),{player,update}=playerFor(idle);renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  expect(screen.getByRole('button',{name:'Play'})).toBeDisabled();fireEvent.click(screen.getByText('Selected playback'));
  fireEvent.change(screen.getByLabelText('Cursor occurrence'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenLastCalledWith(cursor,cursorChoices[1]);
  update(snapshot());fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenLastCalledWith();
  update({...idle,loop:{startTick:0,endTick:3840}});fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenLastCalledWith();
});
it('selection and choice changes are silent; explicit actions dispatch the canonical selection without optimistic range',()=>{
  const selection={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:0},{player,update}=playerFor();const view=renderTransport(<Transport cursor={cursor} selection={selection} player={player} measures={4} busy={false}/>);
  expect(player.play).not.toHaveBeenCalled();expect(player.setLoop).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Selected playback'));
  fireEvent.click(screen.getByRole('button',{name:'Loop selection'}));expect(player.loopSelection).toHaveBeenCalledWith(selection,passage);expect(player.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Play selection'}));expect(player.playSelection).toHaveBeenCalledWith(selection,passage);expect(screen.queryByLabelText('Selected playback range')).not.toBeInTheDocument();
  update(snapshot({range:{startTick:480,endTick:1920}}));expect(screen.getByLabelText('Selected playback range')).toBeInTheDocument();
  view.rerender(<Transport cursor={{...cursor,beat:1}} selection={null} player={player} measures={4} busy={false}/>);expect(screen.getByRole('button',{name:'Play selection'})).toBeDisabled();expect(player.playSelection).toHaveBeenCalledTimes(1);
});
it('explicit measure Seek keeps next-start intent until cursor, Stop or asynchronous error resets it',()=>{
  const idle=snapshot({practice:{...snapshot().practice,phase:'idle'}}),{player,update}=playerFor(idle),view=renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Seek'}));const play=screen.getByRole('button',{name:'Play'});expect(play).toBeEnabled();expect(play).toHaveAttribute('title','Play from transport position');fireEvent.click(play);expect(player.play).toHaveBeenLastCalledWith();
  view.rerender(<Transport cursor={{...cursor,beat:1}} selection={null} player={player} measures={4} busy={false}/>);expect(play).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Seek'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(play).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Seek'}));update({...idle,error:'Queue full'});expect(play).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent('Queue full');
});
it('busy and pending start controls keep native Pause and Stop available',()=>{
  const {player}=playerFor(snapshot({playing:true,practicePending:true}));renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy/>);
  expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Pause'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(player.pause).toHaveBeenCalledOnce();expect(player.stop).toHaveBeenCalledOnce();
});
it('a successful Seek after an error retains position intent when that old error clears',()=>{
  const idle=snapshot({practice:{...snapshot().practice,phase:'idle'}}),{player,update}=playerFor({...idle,error:'Earlier command failed'});
  renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);fireEvent.click(screen.getByRole('button',{name:'Seek'}));
  update(idle);const play=screen.getByRole('button',{name:'Play'});expect(play).toBeEnabled();expect(play).toHaveAttribute('title','Play from transport position');
});
it.each(['reject','accept'] as const)('real controller Seek retry with the same previous error handles immediate %s settlement',async outcome=>{
  let receive!:(status:NativeAudioStatus)=>void;
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const player=new NativePlaybackController({bridge,onEdit:()=>{}}),repeated=previewEdit(blankProject(),{type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:2,endings:[],section:'',tempos:[]});
  await player.loadDocument(repeated.project,buildDocument(repeated.project));
  const range={startTick:120,endTick:1440};receive({generation:player.generation,ready:true,playing:false,tick:1440,seconds:.75,durationSeconds:10,speed:1,metronome:false,practice:{...snapshot().practice,phase:'ended'},loop:null,range,error:null,deviceId:null});
  bridge.command=vi.fn(async()=>{throw new Error('Queue full');});player.seekToMeasure(0);await waitFor(()=>expect(player.getState().error).toBe('Queue full'));
  renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  const play=screen.getByRole('button',{name:'Play'});expect(play).toBeDisabled();const acknowledged=player.getState();
  if(outcome==='accept')bridge.command=vi.fn(async()=>{});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Seek'}));await Promise.resolve();await Promise.resolve();});
  expect(player.getState()).toMatchObject({time:acknowledged.time,measure:acknowledged.measure,playing:false,range,loop:null,practice:acknowledged.practice});
  if(outcome==='reject'){
    expect(screen.getByRole('alert')).toHaveTextContent('Queue full');expect(play).toBeDisabled();expect(play).toHaveAttribute('title','Play from score cursor');
  }else {
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(play).toBeEnabled();expect(play).toHaveAttribute('title','Play from transport position');
  }
  cleanup();player.destroy();
});
it('a new generation retires repeated occurrence choices without dispatching a start',()=>{
  const idle=snapshot({practice:{...snapshot().practice,phase:'idle'}}),{player,update}=playerFor(idle);renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByText('Selected playback'));fireEvent.change(screen.getByLabelText('Cursor occurrence'),{target:{value:'1'}});expect(screen.getByRole('button',{name:'Play'})).toBeEnabled();
  player.generation=8;player.cursorPlaybackChoices.mockReturnValue(cursorChoices.map(choice=>({...choice,generation:8})));update({...idle});
  expect(screen.getByRole('button',{name:'Play'})).toBeDisabled();expect(player.play).not.toHaveBeenCalled();expect(player.playFromCursor).not.toHaveBeenCalled();
});
it('uses structural native transport controls and validates measure drafts',()=>{
  const {player,update}=playerFor();
  const view=renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'1.5'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(0);
  fireEvent.change(screen.getByLabelText('Seek measure'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Seek'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(3);
  fireEvent.click(screen.getByRole('button',{name:'Play'}));expect(player.play).toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(0,0);update(snapshot({loop:{startTick:0,endTick:3840}}));fireEvent.click(screen.getByRole('button',{name:'Clear loop'}));expect(player.clearLoop).toHaveBeenCalled();
  view.rerender(<Transport cursor={cursor} selection={null} player={player} measures={2} busy={false}/>);expect(screen.getByLabelText('Seek measure')).toHaveValue(2);view.rerender(<Transport cursor={cursor} selection={null} player={player} measures={2} busy/>);expect(screen.getByRole('button',{name:'Play'})).toHaveAttribute('aria-disabled','true');expect(screen.getByRole('button',{name:'Play'})).not.toBeDisabled();
});
it('loop_pressed_state_waits_for_native_acknowledgement_and_retains_failed_clear',()=>{
  const {player,update}=playerFor();renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(0,0);expect(screen.getByRole('button',{name:'Loop'})).toHaveAttribute('aria-pressed','false');
  update(snapshot({loop:{startTick:0,endTick:3840}}));expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');fireEvent.click(screen.getByRole('button',{name:'Clear loop'}));expect(player.clearLoop).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');
  update(snapshot({loop:{startTick:0,endTick:3840},error:'Loop clear failed.'}));expect(screen.getByRole('alert')).toHaveTextContent('Loop clear failed.');expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('aria-pressed','true');
  update(snapshot());expect(screen.getByRole('button',{name:'Loop'})).toHaveAttribute('aria-pressed','false');
});
const eightBars=Array.from({length:8},(_,bar)=>({bar,occurrence:0,startTick:bar*3840,endTick:(bar+1)*3840,startMs:bar*2000,endMs:(bar+1)*2000,meterNumerator:4,meterDenominator:4,clickTicks:[]}));
it('the loop bar fields follow the selected bars, so Loop repeats the passage the player picked',()=>{
  const {player}=playerFor();player.playbackOccurrences=()=>eightBars;
  const fields=()=>[screen.getByLabelText('Loop start'),screen.getByLabelText('Loop end')];
  const view=renderTransport(<Transport cursor={cursor} selection={{kind:'bars',tracks:[0],firstBar:4,lastBar:6}} player={player} measures={8} busy={false}/>);
  expect(fields()).toEqual([expect.objectContaining({value:'5'}),expect.objectContaining({value:'7'})]);
  fireEvent.click(screen.getByRole('button',{name:'Loop'}));expect(player.setLoop).toHaveBeenCalledWith(4,6);
  expect(screen.getByRole('button',{name:'Loop'})).toHaveAttribute('title','Loop bars 5 to 7');
  view.rerender(<Transport cursor={{...cursor,bar:2}} selection={null} player={player} measures={8} busy={false}/>);
  expect(fields()).toEqual([expect.objectContaining({value:'3'}),expect.objectContaining({value:'3'})]);
  view.rerender(<Transport cursor={{...cursor,bar:2}} selection={{kind:'range',range:{start:{bar:1,tick:0},end:{bar:3,tick:960},lanes:[]}}} player={player} measures={8} busy={false}/>);
  expect(fields()).toEqual([expect.objectContaining({value:'2'}),expect.objectContaining({value:'4'})]);
  expect(screen.getByLabelText('Loop start')).toHaveAttribute('title','Loop start');
});
it('the loop bar fields show the loop that is running, however it was set, and keep it while the selection moves',()=>{
  const {player,update}=playerFor();player.playbackOccurrences=()=>eightBars;
  const view=renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={8} busy={false}/>);
  expect(screen.getByLabelText('Loop start')).toHaveValue(1);
  update(snapshot({loop:{startTick:4*3840+480,endTick:7*3840}}));
  expect(screen.getByLabelText('Loop start')).toHaveValue(5);expect(screen.getByLabelText('Loop end')).toHaveValue(7);
  view.rerender(<Transport cursor={{...cursor,bar:0}} selection={{kind:'bars',tracks:[0],firstBar:1,lastBar:1}} player={player} measures={8} busy={false}/>);
  expect(screen.getByLabelText('Loop start')).toHaveValue(5);expect(screen.getByLabelText('Loop end')).toHaveValue(7);
  expect(screen.getByRole('button',{name:'Clear loop'})).toHaveAttribute('title','Clear loop');
});
it('the position display shows the bars a running loop plays and says so in text, then says when it is off',()=>{
  const {player,update}=playerFor();player.playbackOccurrences=()=>eightBars;
  renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={8} busy={false} display={{track:'1. Guitar',signatureAt:()=>'4/4'}}/>);
  const lcd=screen.getByRole('group',{name:'Song position'});
  expect(lcd).not.toHaveAttribute('data-loop');expect(lcd).not.toHaveTextContent('Loop');
  update(snapshot({loop:{startTick:4*3840,endTick:7*3840}}));
  expect(lcd).toHaveAttribute('data-loop','true');
  expect(lcd).toHaveTextContent('Loop 5–7');
  expect(screen.getByText('Looping bars 5 to 7')).toBeInTheDocument();
  expect(lcd.style.getPropertyValue('--lcd-loop-from')).toBe('50%');expect(lcd.style.getPropertyValue('--lcd-loop-size')).toBe('37.5%');
  update(snapshot({loop:{startTick:2*3840+960,endTick:3*3840}}));
  expect(lcd).toHaveTextContent('Loop 3');expect(lcd).not.toHaveTextContent('Loop 3–');
  expect(screen.getByText('Looping bar 3')).toBeInTheDocument();
  update(snapshot());
  expect(lcd).not.toHaveAttribute('data-loop');expect(lcd).not.toHaveTextContent('Loop');
  expect(screen.getByText('Loop off')).toBeInTheDocument();
});
it('a loop across a repeat is named by its first and last bar, and a clock tick that hands over an equal loop changes nothing',()=>{
  const {player,update}=playerFor();player.playbackOccurrences=()=>eightBars;
  renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={8} busy={false} display={{track:'1. Guitar',signatureAt:()=>'4/4'}}/>);
  const lcd=screen.getByRole('group',{name:'Song position'});
  update(snapshot({loop:{startTick:3840,endTick:3*3840}}));
  const before=lcd.getAttribute('style');
  update(snapshot({time:2000,loop:{startTick:3840,endTick:3*3840}}));
  expect(lcd).toHaveTextContent('Loop 2–3');
  expect(lcd.style.getPropertyValue('--lcd-loop-from')).toBe(before!.match(/--lcd-loop-from:\s*([^;]+)/)![1]);
});
it('custom_acknowledged_coefficients_and_full_relative_endpoints_are_displayed_without_dispatch',()=>{
  const state=snapshot({speed:123});state.practice.effectiveRatio=1.23;state.practice.currentBpm=147.6;state.practice.settings.tempo={kind:'relative',ratio:1.23};const {player,update}=playerFor(state);renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  const speedGroup=()=>screen.getByRole('group',{name:'Speed'}),slower=()=>screen.getByRole('button',{name:'Slower'}),faster=()=>screen.getByRole('button',{name:'Faster'});expect(speedGroup()).toHaveTextContent('123%');expect(screen.getByRole('status',{name:'Practice playback'})).toHaveTextContent(/147.6 BPM.*123%/);expect(screen.getByLabelText('Practice passes')).toHaveTextContent('Completed passes 0');expect(screen.getByLabelText('Practice passes')).toBeVisible();
  fireEvent.click(slower());expect(player.setSpeed).toHaveBeenLastCalledWith(100);fireEvent.click(faster());expect(player.setSpeed).toHaveBeenLastCalledWith(125);
  const fixed=snapshot({speed:75});fixed.practice.settings.tempo={kind:'fixed',bpm:90};fixed.practice.currentBpm=90;fixed.practice.effectiveRatio=.75;update(fixed);expect(slower()).toHaveAttribute('aria-disabled','true');expect(faster()).toHaveAttribute('aria-disabled','true');fireEvent.click(slower());fireEvent.click(faster());expect(screen.getByLabelText('Practice playback')).toHaveTextContent(/90 BPM.*75%/);expect(player.setSpeed).toHaveBeenCalledTimes(2);expect(player.setPractice).not.toHaveBeenCalled();
});
it('pending_settings_disable_only_settings_controls_while_pause_stop_keep_working',()=>{
  const {player}=playerFor(snapshot({playing:true,practicePending:true}));renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  for(const name of ['Slower','Faster'])expect(screen.getByRole('button',{name})).toHaveAttribute('aria-disabled','true');expect(screen.getByLabelText('Metronome')).toHaveAttribute('aria-disabled','true');fireEvent.click(screen.getByLabelText('Metronome'));expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Pause'}));fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(player.pause).toHaveBeenCalledTimes(1);expect(player.stop).toHaveBeenCalledTimes(1);expect(player.setPractice).not.toHaveBeenCalled();expect(player.setSpeed).not.toHaveBeenCalled();
});
it('metronome_toggle_preserves_zero_volume_visual_and_other_practice_settings',()=>{
  const state=snapshot();state.practice.settings={tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};const {player}=playerFor(state);renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  fireEvent.click(screen.getByLabelText('Metronome'));expect(player.setPractice).toHaveBeenCalledWith({tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}});expect(player.setMetronome).not.toHaveBeenCalled();expect(state.practice.settings.metronome.enabled).toBe(false);
  const emitted=player.setPractice.mock.calls[0][0];expect(emitted.metronome).not.toBe(state.practice.settings.metronome);
});
it('count_paused_count_and_pulses_render_only_acknowledged_native_state',()=>{
  vi.useFakeTimers();const state=snapshot({playing:true});state.practice={...state.practice,phase:'countIn',countInRemaining:3,completedPasses:2,pulse:{serial:42,beat:1,beatsPerBar:4,accent:false,counting:true}};const {player,update}=playerFor(state);renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/Count-in.*3.*remaining/);expect(screen.getByRole('status',{name:'Metronome pulse'})).toHaveAttribute('data-pulse-serial','42');expect(screen.getByLabelText('Metronome pulse')).toHaveTextContent('Count-in beat 2 of 4');expect(screen.getByLabelText('Metronome pulse')).toHaveAttribute('aria-live','off');expect(screen.getByLabelText('Practice passes')).toHaveTextContent('Completed passes 2');expect(screen.getByLabelText('Practice passes')).toBeVisible();
  act(()=>{vi.advanceTimersByTime(5000);});expect(document.querySelector('.transport-time')).toHaveTextContent('0:01 / 0:06');expect(screen.getByText('Bar 1')).toBeInTheDocument();expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/3.*remaining/);expect(player.setSpeed).not.toHaveBeenCalled();expect(player.setPractice).not.toHaveBeenCalled();
  update({...state,playing:false,practice:{...state.practice,phase:'paused'}});expect(screen.getByRole('status',{name:'Count-in'})).toHaveTextContent(/Count-in paused.*3.*remaining/);expect(screen.getByRole('button',{name:'Play'})).toBeEnabled();expect(screen.getByLabelText('Metronome pulse')).toHaveAttribute('data-pulse-serial','42');
  update(snapshot());expect(screen.queryByLabelText('Metronome pulse')).not.toBeInTheDocument();expect(screen.queryByRole('status',{name:'Count-in'})).not.toBeInTheDocument();
});
it('says so in the transport message line when an edit ended the loop',()=>{
  const {player}=playerFor(snapshot({loopNotice:'cleared'}));renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  expect(screen.getByText('The loop was removed because your edit changed the bars it covered.')).toBeInTheDocument();
});
it('practice_notices_are_visible_and_control_errors_stay_inline',()=>{
  const {player}=playerFor(snapshot({practiceNotice:'Fixed tempo disabled because this score has backing audio.'}));player.setSpeed.mockImplementation(()=>{throw new Error('Practice change rejected.');});renderTransport(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false}/>);
  expect(screen.getByText('Fixed tempo disabled because this score has backing audio.')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Slower'}));expect(screen.getByRole('alert')).toHaveTextContent('Practice change rejected.');
});
it('steps bars from the toolbar and shows the selected track, bar, signature and tempo in the position display',()=>{
  const {player,update}=playerFor(snapshot({measure:1}));
  render(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false} display={{track:'2. Bass',signatureAt:bar=>bar===1?'3/4':'4/4'}}/>);
  const lcd=screen.getByRole('group',{name:'Song position'});
  expect(lcd).toHaveTextContent('2. Bass');expect(lcd).toHaveTextContent('Bar 2');expect(lcd).toHaveTextContent('3/4');expect(lcd).toHaveTextContent('♩ = 120');
  fireEvent.click(screen.getByRole('button',{name:'Next bar'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(2);
  fireEvent.click(screen.getByRole('button',{name:'Previous bar'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(0);
  fireEvent.click(screen.getByRole('button',{name:'Last bar'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(3);
  update(snapshot({measure:3}));
  expect(screen.getByRole('button',{name:'Next bar'})).toHaveAttribute('aria-disabled','true');
  fireEvent.click(screen.getByRole('button',{name:'Next bar'}));expect(player.seekToMeasure).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button',{name:'First bar'}));expect(player.seekToMeasure).toHaveBeenLastCalledWith(0);
});

it('lets the position display change track, go to a bar, open measure settings and mark bar completion',()=>{
  const {player}=playerFor(snapshot({measure:1}));
  const onTrack=vi.fn(),onGoTo=vi.fn(),onMeasure=vi.fn();
  const view=render(<Transport cursor={cursor} selection={null} player={player} measures={4} busy={false} display={{track:'1. Guitar',tracks:['1. Guitar','2. Bass'],trackIndex:0,onTrack,onGoTo,onMeasure,signatureAt:()=>'4/4',completionAt:bar=>bar===1?{kind:'short',voice:2}:{kind:'complete'}}}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Current track'}),{target:{value:'1'}});expect(onTrack).toHaveBeenCalledWith(1);
  expect(screen.getByRole('img',{name:'Voice 2 is too short'})).toHaveTextContent('!');
  fireEvent.click(screen.getByRole('button',{name:'Time signature 4/4 (click to change)'}));expect(onMeasure).toHaveBeenLastCalledWith(1);
  fireEvent.click(screen.getByRole('button',{name:'Tempo 120 (click to change)'}));expect(onMeasure).toHaveBeenCalledTimes(2);
  const bar=screen.getByRole('button',{name:/Bar 2/});fireEvent.click(bar);
  const goTo=screen.getByRole('dialog',{name:'Go to bar'});const input=screen.getByRole('spinbutton',{name:'Go to bar'});
  expect(input).toHaveValue(2);expect(input).toHaveFocus();
  fireEvent.change(input,{target:{value:'9'}});fireEvent.submit(goTo);
  expect(onGoTo).toHaveBeenCalledWith(3);expect(player.seekToMeasure).toHaveBeenLastCalledWith(3);
  expect(screen.queryByRole('dialog',{name:'Go to bar'})).toBeNull();expect(bar).toHaveFocus();
  fireEvent.click(bar);fireEvent.keyDown(screen.getByRole('spinbutton',{name:'Go to bar'}),{key:'Escape'});
  expect(screen.queryByRole('dialog',{name:'Go to bar'})).toBeNull();expect(onGoTo).toHaveBeenCalledTimes(1);
  view.rerender(<Transport cursor={cursor} selection={null} player={player} measures={4} busy display={{track:'1. Guitar',tracks:['1. Guitar','2. Bass'],trackIndex:0,onTrack,onGoTo,onMeasure,signatureAt:()=>'4/4'}}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Current track'}),{target:{value:'1'}});expect(onTrack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Tempo 120 (click to change)'}));expect(onMeasure).toHaveBeenCalledTimes(2);
});
