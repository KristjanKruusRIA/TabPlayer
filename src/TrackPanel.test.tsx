// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { previewEdit } from './engine';
import { blankProject } from './project';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import { TrackPanel } from './TrackPanel';
const contract=vi.hoisted(()=>({project:vi.fn()}));
vi.mock('./workstation/overview',()=>({projectScoreOverview:(score:model.Score)=>{contract.project(score);return {barCount:score.masterBars.length,sections:[],tracks:score.tracks.map(track=>({index:track.index,name:track.name,cells:[]}))};}}));
vi.mock('./workstation/ScoreOverview',()=>({ScoreOverview:({playbackBar,onSelect,onExit}:{playbackBar:number|null;onSelect:(track:number,bar:number)=>void;onExit:()=>void})=><section aria-label="Overview contract"><span>Playback bar: {playbackBar??'none'}</span><button onClick={()=>onSelect(0,0)}>Select written measure</button><button onClick={onExit}>Exit overview</button><input aria-label="Overview local draft" defaultValue=""/></section>}));
afterEach(()=>{cleanup();contract.project.mockClear();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const base=()=>previewEdit(blankProject(),{type:'setRest',target}).score;
function livePlayer(score:model.Score){
  let state:PlaybackState={ready:true,playing:true,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'playing',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null};
  const listeners=new Set<()=>void>(),remove=vi.fn();let mix={mute:false,solo:true,volume:.7,pan:-.2};
  const player={subscribe:vi.fn((fn:()=>void)=>{listeners.add(fn);return()=>{remove();listeners.delete(fn);};}),getState:()=>state,mix:vi.fn((_track:model.Track)=>mix),setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn()};
  return {player,remove,emit:(patch:Partial<PlaybackState>={},mixPatch:Partial<typeof mix>={})=>{state={...state,...patch};mix={...mix,...mixPatch};act(()=>{for(const fn of listeners)fn();});},score};
}
function props(score=base()) {return {score,selected:0,busy:false,view:'mixer' as const,target,onExitOverview:vi.fn(),onSelect:vi.fn(),onSelectPosition:vi.fn(),player:null};}

it('shows each track color as a swatch beside its name',()=>{
  const score=previewEdit(blankProject(),{type:'setTrackColor',track:0,color:'#ff8800'}).score;
  render(<TrackPanel {...props(score)}/>);
  const swatch=screen.getByRole('button',{name:/^Track 1: /}).querySelector('.track-color-swatch') as HTMLElement;
  expect(swatch).toHaveAttribute('aria-hidden','true');expect(swatch.style.backgroundColor).toBe('rgb(255, 136, 0)');
});
it('shows the current instrument mix after deletion and undo change its index',()=>{
  const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  let score=added.score;const state={};
  const player={subscribe:()=>()=>{},getState:()=>state,mix:(value:number|model.Track)=>{
    const track=typeof value==='number'?score.tracks[value]:value;
    return {mute:track.name==='Bass',solo:false,volume:track.name==='Bass'?.5:1,pan:0};
  }};
  const currentProps=()=>({...props(score),player:player as never});
  const view=render(<TrackPanel {...currentProps()}/>);
  expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();
  score=previewEdit(added.project,{type:'removeTrack',track:0}).score;view.rerender(<TrackPanel {...currentProps()}/>);
  expect(screen.getByLabelText('Mute')).toBeChecked();expect(screen.getByLabelText('Volume Bass')).toHaveValue('0.5');
  score=added.score;view.rerender(<TrackPanel {...currentProps()}/>);
  expect(screen.getAllByLabelText('Mute')[0]).not.toBeChecked();expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();
});
it('dispatches exact live mix values, retains slider ranges and selects the canonical channel',()=>{
  const initial=props(),{player,emit}=livePlayer(initial.score),onSelect=vi.fn();render(<TrackPanel {...initial} player={player} onSelect={onSelect}/>);
  expect(screen.getByLabelText('Mute')).not.toBeChecked();expect(screen.getByLabelText('Solo')).toBeChecked();
  const volume=screen.getByLabelText('Volume Guitar'),pan=screen.getByLabelText('Pan Guitar');
  expect(volume).toHaveValue('0.7');expect(volume).toHaveAttribute('min','0');expect(volume).toHaveAttribute('max','1');expect(volume).toHaveAttribute('step','0.05');
  expect(pan).toHaveValue('-0.2');expect(pan).toHaveAttribute('min','-1');expect(pan).toHaveAttribute('max','1');expect(pan).toHaveAttribute('step','0.05');
  fireEvent.click(screen.getByLabelText('Mute'));expect(player.setMute).toHaveBeenLastCalledWith(0,true);
  fireEvent.click(screen.getByLabelText('Solo'));expect(player.setSolo).toHaveBeenLastCalledWith(0,false);
  fireEvent.change(volume,{target:{value:'.55'}});expect(player.setTrackVolume).toHaveBeenLastCalledWith(0,.55);
  fireEvent.change(pan,{target:{value:'.25'}});expect(player.setPan).toHaveBeenLastCalledWith(0,.25);
  const channel=screen.getByRole('button',{name:'Track 1: Guitar'});expect(channel).toHaveAttribute('aria-pressed','true');
  fireEvent.click(channel);expect(onSelect).toHaveBeenLastCalledWith(0);
  emit({}, {mute:true,solo:false,volume:.55,pan:.25});expect(screen.getByLabelText('Mute')).toBeChecked();expect(volume).toHaveValue('0.55');expect(pan).toHaveValue('0.25');
  expect(volume).toHaveAttribute('aria-valuetext','0.55');expect(pan).toHaveAttribute('aria-valuetext','0.25');
});
it('subscribes once, memoizes score contents across ticks and passes only valid actual playback bars',()=>{
  const initial=props(),{player,emit,remove}=livePlayer(initial.score);const view=render(<TrackPanel {...initial} player={player}/>);
  expect(player.subscribe).toHaveBeenCalledTimes(1);expect(contract.project).toHaveBeenCalledTimes(1);expect(screen.getByText('Playback bar: 0')).toBeInTheDocument();
  emit({time:100});expect(contract.project).toHaveBeenCalledTimes(1);expect(player.subscribe).toHaveBeenCalledTimes(1);
  emit({ready:false});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({ready:true,error:'Output unavailable'});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({error:null,measure:99});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({measure:0,practice:{...player.getState().practice,phase:'countIn',countInRemaining:1}});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({practice:{...player.getState().practice,phase:'ended',countInRemaining:0}});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({practice:{...player.getState().practice,phase:'idle'}});expect(screen.getByText('Playback bar: none')).toBeInTheDocument();
  emit({playing:false,practice:{...player.getState().practice,phase:'paused'}});expect(screen.getByText('Playback bar: 0')).toBeInTheDocument();
  emit({playing:true,practice:{...player.getState().practice,phase:'playing'}});expect(screen.getByText('Playback bar: 0')).toBeInTheDocument();
  view.rerender(<TrackPanel {...initial} score={base()} player={player}/>);expect(contract.project).toHaveBeenCalledTimes(2);
  view.unmount();expect(remove).toHaveBeenCalledTimes(1);
});
it('keeps overview and mixer mounted across view switches with drafts, channels and full names intact',()=>{
  const initial=props(),name='Lead guitar with a long descriptive title for the arrangement';initial.score.tracks[0].name=name;
  const view=render(<TrackPanel {...initial}/>),volume=screen.getByLabelText(`Volume ${name}`),overview=screen.getByLabelText('Overview contract');
  expect(overview.closest('[hidden]')).not.toBeNull();expect(volume.closest('[hidden]')).toBeNull();
  view.rerender(<TrackPanel {...initial} view="overview"/>);expect(overview.closest('[hidden]')).toBeNull();expect(volume.closest('[hidden]')).not.toBeNull();
  const draft=screen.getByLabelText('Overview local draft');fireEvent.change(draft,{target:{value:'Keep my location'}});
  fireEvent.click(screen.getByRole('button',{name:'Select written measure'}));expect(initial.onSelectPosition).toHaveBeenLastCalledWith(0,0);
  fireEvent.click(screen.getByRole('button',{name:'Exit overview'}));expect(initial.onExitOverview).toHaveBeenCalledTimes(1);
  view.rerender(<TrackPanel {...initial}/>);expect(screen.getByLabelText(`Volume ${name}`)).toBe(volume);
  expect(screen.getByRole('button',{name:`Track 1: ${name}`})).toHaveAttribute('title',name);expect(screen.getByText('Selected')).toBeVisible();
  view.rerender(<TrackPanel {...initial} view="overview"/>);expect(screen.getByLabelText('Overview local draft')).toBe(draft);expect(draft).toHaveValue('Keep my location');
});
it('disables all mix changes when busy or without a player while retaining channel selection',()=>{
  const initial=props(),{player}=livePlayer(initial.score),view=render(<TrackPanel {...initial} player={player} busy/>);
  for(const label of ['Mute','Solo','Volume Guitar','Pan Guitar'])expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toBeDisabled();
  view.rerender(<TrackPanel {...initial}/>);
  for(const label of ['Mute','Solo','Volume Guitar','Pan Guitar'])expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toBeEnabled();
});
