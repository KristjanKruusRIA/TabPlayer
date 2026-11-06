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

function setup(busy=false){
  const score=previewEdit(previewEdit(blankProject(),{type:'setRest',target}).project,{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  let state={ready:true,playing:false,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null} as PlaybackState;
  const listeners=new Set<()=>void>();const mixes=new Map<string,{mute:boolean;solo:boolean;volume:number;pan:number}>();
  const mixOf=(track:model.Track)=>mixes.get(track.name)??{mute:false,solo:false,volume:1,pan:0};
  const player={subscribe:vi.fn((fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}),getState:()=>state,mix:vi.fn(mixOf),
    setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn(),focus:()=>null,setFocus:vi.fn(async()=>{})};
  const emit=(name:string,mix:Partial<{mute:boolean;solo:boolean;volume:number;pan:number}>)=>{
    const track=score.tracks.find(t=>t.name===name)!;mixes.set(name,{...mixOf(track),...mix});state={...state};act(()=>{for(const fn of listeners)fn();});
  };
  render(<TrackPanel score={score} selected={0} busy={busy} view="overview" target={target} onExitOverview={vi.fn()} onSelect={vi.fn()} onSelectPosition={vi.fn()} player={player as never}/>);
  return {score,player,emit};
}

it('puts mute, solo, volume and pan beside each track in the overview dock',()=>{
  const {score,player,emit}=setup();const guitar=score.tracks[0].name;
  expect(screen.getByRole('button',{name:`Mute ${guitar}`})).toHaveAttribute('aria-pressed','false');
  fireEvent.click(screen.getByRole('button',{name:'Solo Bass'}));expect(player.setSolo).toHaveBeenCalledWith(1,true);
  fireEvent.click(screen.getByRole('button',{name:`Mute ${guitar}`}));expect(player.setMute).toHaveBeenCalledWith(0,true);
  fireEvent.change(screen.getByRole('slider',{name:'Bass volume'}),{target:{value:'0.4'}});expect(player.setTrackVolume).toHaveBeenCalledWith(1,0.4);
  fireEvent.change(screen.getByRole('slider',{name:'Bass pan'}),{target:{value:'-0.5'}});expect(player.setPan).toHaveBeenCalledWith(1,-0.5);
  // A mix change reported by the player reaches the row.
  emit('Bass',{mute:true,pan:.25});
  expect(screen.getByRole('button',{name:'Mute Bass'})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('slider',{name:'Bass pan'})).toHaveAttribute('aria-valuetext','R25');
});

it('keeps dock mix controls disabled while busy',()=>{
  setup(true);
  expect(screen.getByRole('button',{name:'Solo Bass'})).toBeDisabled();
  expect(screen.getByRole('slider',{name:'Bass volume'})).toBeDisabled();
});
