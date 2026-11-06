// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { previewEdit } from './engine';
import { blankProject } from './project';
import { DEFAULT_PRACTICE } from './audio/practice-types';
import type { PlaybackState } from './audio/types';
import { TrackPanel } from './TrackPanel';

beforeEach(()=>{
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(140);
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};

function setup(busy=false,extra:{shown?:number[];onToggleShown?:(track:number)=>void;master?:object;setMaster?:(next:object)=>unknown;onAddTrack?:()=>void}={}){
  const score=previewEdit(previewEdit(blankProject(),{type:'setRest',target}).project,{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  let state={ready:true,playing:false,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null} as PlaybackState;
  const listeners=new Set<()=>void>();const mixes=new Map<string,{mute:boolean;solo:boolean;volume:number;pan:number}>();
  const mixOf=(track:model.Track)=>mixes.get(track.name)??{mute:false,solo:false,volume:1,pan:0};
  const player={subscribe:vi.fn((fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}),getState:()=>state,mix:vi.fn(mixOf),
    setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn(),focus:()=>null,setFocus:vi.fn(async()=>{}),
    ...(extra.setMaster?{master:()=>extra.master,setMaster:extra.setMaster}:{})};
  const emit=(name:string,mix:Partial<{mute:boolean;solo:boolean;volume:number;pan:number}>)=>{
    const track=score.tracks.find(t=>t.name===name)!;mixes.set(name,{...mixOf(track),...mix});state={...state};act(()=>{for(const fn of listeners)fn();});
  };
  const panel=(onAddTrack?:()=>void)=><TrackPanel score={score} selected={0} busy={busy} view="overview" target={target} onExitOverview={vi.fn()} onSelect={vi.fn()} onSelectPosition={vi.fn()} player={player as never} shown={extra.shown} onToggleShown={extra.onToggleShown} onAddTrack={onAddTrack}/>;
  const view=render(panel(extra.onAddTrack));
  return {score,player,emit,rerender:(onAddTrack?:()=>void)=>view.rerender(panel(onAddTrack))};
}

it('puts mute, solo, volume and pan beside each track in the overview dock',()=>{
  const {score,player,emit}=setup();const guitar=score.tracks[0].name;
  expect(screen.getByRole('button',{name:`Mute ${guitar}`})).toHaveAttribute('aria-pressed','false');
  fireEvent.click(screen.getByRole('button',{name:'Solo Bass'}));expect(player.setSolo).toHaveBeenCalledWith(1,true);
  fireEvent.click(screen.getByRole('button',{name:`Mute ${guitar}`}));expect(player.setMute).toHaveBeenCalledWith(0,true);
  fireEvent.change(screen.getByRole('slider',{name:'Bass volume'}),{target:{value:'0.4'}});expect(player.setTrackVolume).toHaveBeenCalledWith(1,0.4);
  fireEvent.keyDown(screen.getByRole('slider',{name:'Bass pan'}),{key:'ArrowLeft'});expect(player.setPan).toHaveBeenLastCalledWith(1,-0.05);
  // A mix change reported by the player reaches the row.
  emit('Bass',{mute:true,pan:.25});
  expect(screen.getByRole('button',{name:'Mute Bass'})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('slider',{name:'Bass pan'})).toHaveAttribute('aria-valuetext','R25');
});

it('shows or hides a track with its eye and never hides the last shown track',()=>{
  const onToggleShown=vi.fn();const {score}=setup(false,{shown:[0],onToggleShown});const guitar=score.tracks[0].name;
  const guitarEye=screen.getByRole('button',{name:`Show ${guitar} in the score`}),bassEye=screen.getByRole('button',{name:'Show Bass in the score'});
  expect(guitarEye).toHaveAttribute('aria-pressed','true');expect(guitarEye).toHaveAttribute('aria-disabled','true');
  expect(bassEye).toHaveAttribute('aria-pressed','false');
  fireEvent.click(guitarEye);expect(onToggleShown).not.toHaveBeenCalled();
  fireEvent.click(bassEye);expect(onToggleShown).toHaveBeenCalledWith(1);
});

it('sets master level in the dock as one change per gesture',()=>{
  const setMaster=vi.fn(async(_next:object)=>{});setup(false,{setMaster,master:undefined});
  const master=screen.getByRole('group',{name:'Master'});
  const level=screen.getByRole('slider',{name:'Master level'});expect(master).toContainElement(level);
  fireEvent.change(level,{target:{value:'-3'}});fireEvent.change(level,{target:{value:'-6'}});
  expect(setMaster).not.toHaveBeenCalled();
  fireEvent.pointerUp(level);
  expect(setMaster).toHaveBeenCalledTimes(1);expect(setMaster.mock.calls[0][0]).toMatchObject({gainDb:-6,balance:0});
});

it('keeps dock mix controls disabled while busy',()=>{
  setup(true);
  expect(screen.getByRole('button',{name:'Solo Bass'})).toBeDisabled();
  expect(screen.getByRole('slider',{name:'Bass volume'})).toBeDisabled();
});

it('keeps the row controls mounted when the add-track handler changes, and + calls the latest one',()=>{
  const first=vi.fn(),second=vi.fn();const {rerender}=setup(false,{onAddTrack:first});
  const pan=screen.getByRole('slider',{name:'Bass pan'});pan.focus();
  rerender(second);
  expect(screen.getByRole('slider',{name:'Bass pan'})).toBe(pan);expect(pan).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'Add a track'}));expect(second).toHaveBeenCalledOnce();expect(first).not.toHaveBeenCalled();
});
