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

function setup(initialBusy=false,extra:{shown?:number[];onToggleShown?:(track:number)=>void;master?:object;setMaster?:(next:object)=>unknown;onAddTrack?:()=>void}={}){
  let busy=initialBusy;const onSelect=vi.fn();
  const project=previewEdit(previewEdit(blankProject(),{type:'setRest',target}).project,{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project;
  let score=previewEdit(project,{type:'setRest',target}).score;
  let state={ready:true,playing:false,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,loopNotice:null,range:null,loop:null,error:null} as PlaybackState;
  const listeners=new Set<()=>void>();const mixes=new Map<string,{mute:boolean;solo:boolean;volume:number;pan:number}>();
  const mixOf=(track:model.Track)=>mixes.get(track.name)??{mute:false,solo:false,volume:1,pan:0};
  const player={subscribe:vi.fn((fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}),getState:()=>state,mix:vi.fn(mixOf),
    setMute:vi.fn(),setSolo:vi.fn(),setTrackVolume:vi.fn(),setPan:vi.fn(),focus:()=>null,setFocus:vi.fn(async()=>{}),
    ...(extra.setMaster?{master:()=>extra.master,setMaster:extra.setMaster}:{})};
  const emit=(name:string,mix:Partial<{mute:boolean;solo:boolean;volume:number;pan:number}>)=>{
    const track=score.tracks.find(t=>t.name===name)!;mixes.set(name,{...mixOf(track),...mix});state={...state};act(()=>{for(const fn of listeners)fn();});
  };
  const panel=(onAddTrack?:()=>void)=><TrackPanel score={score} selected={0} busy={busy} view="overview" target={target} onExitOverview={vi.fn()} onSelect={onSelect} onSelectPosition={vi.fn()} player={player as never} shown={extra.shown} onToggleShown={extra.onToggleShown} onAddTrack={onAddTrack}/>;
  const view=render(panel(extra.onAddTrack));
  return {get score(){return score;},player,onSelect,emit,rerender:(onAddTrack?:()=>void)=>view.rerender(panel(onAddTrack)),rerenderBusy:(next:boolean)=>{busy=next;view.rerender(panel(extra.onAddTrack));},withoutFirstTrack:()=>{score=previewEdit(project,{type:'removeTrack',track:0}).score;view.rerender(panel(extra.onAddTrack));}};
}

it('puts mute, solo, volume and pan beside each track in the overview dock',()=>{
  const {score,player,emit}=setup();const guitar=score.tracks[0].name;
  expect(screen.getByRole('button',{name:`Mute ${guitar}`})).toHaveAttribute('aria-pressed','false');
  fireEvent.click(screen.getByRole('button',{name:'Solo Bass'}));expect(player.setSolo).toHaveBeenCalledWith(1,true);
  fireEvent.click(screen.getByRole('button',{name:`Mute ${guitar}`}));expect(player.setMute).toHaveBeenCalledWith(0,true);
  fireEvent.change(screen.getByRole('slider',{name:'Bass volume'}),{target:{value:'0.4'}});fireEvent.pointerUp(screen.getByRole('slider',{name:'Bass volume'}));expect(player.setTrackVolume).toHaveBeenCalledWith(1,0.4);
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

it('keeps dock mix buttons disabled while busy',()=>{
  setup(true);
  expect(screen.getByRole('button',{name:'Solo Bass'})).toBeDisabled();
});

it('keeps the row controls mounted when the add-track handler changes, and + calls the latest one',()=>{
  const first=vi.fn(),second=vi.fn();const {rerender}=setup(false,{onAddTrack:first});
  const pan=screen.getByRole('slider',{name:'Bass pan'});pan.focus();
  rerender(second);
  expect(screen.getByRole('slider',{name:'Bass pan'})).toBe(pan);expect(pan).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'Add a track'}));expect(second).toHaveBeenCalledOnce();expect(first).not.toHaveBeenCalled();
});

it('previews a dock volume drag and records it once at the release, though the app turns busy mid-drag',()=>{
  const preview=vi.fn(async(_index:number,_patch:object|null)=>{});
  const view=setup(false);(view.player as unknown as Record<string,unknown>).previewMix=preview;
  const range=screen.getByRole('slider',{name:'Bass volume'});
  fireEvent.pointerDown(range,{pointerId:1,button:0});
  fireEvent.change(range,{target:{value:'0.8'}});fireEvent.change(range,{target:{value:'0.6'}});
  view.rerenderBusy(true);
  expect(range).not.toBeDisabled();
  fireEvent.change(range,{target:{value:'0.3'}});
  expect(view.player.setTrackVolume).not.toHaveBeenCalled();expect(preview).toHaveBeenCalled();expect(preview.mock.calls[0][0]).toBe(1);
  fireEvent.pointerUp(range,{pointerId:1});
  expect(view.player.setTrackVolume).toHaveBeenCalledExactlyOnceWith(1,.3);
});
it('previews a dock pan drag and records it once, never from the move events',()=>{
  const preview=vi.fn(async(_index:number,_patch:object|null)=>{});
  const view=setup(false);(view.player as unknown as Record<string,unknown>).previewMix=preview;
  const pan=screen.getByRole('slider',{name:'Bass pan'});
  fireEvent.pointerDown(pan,{clientY:200,pointerId:1,button:0});
  for(const y of [190,170,150])fireEvent.pointerMove(pan,{clientY:y,pointerId:1,buttons:1});
  view.rerenderBusy(true);
  fireEvent.pointerMove(pan,{clientY:140,pointerId:1,buttons:1});
  expect(view.player.setPan).not.toHaveBeenCalled();
  fireEvent.pointerUp(pan,{clientY:140,pointerId:1});
  expect(view.player.setPan).toHaveBeenCalledTimes(1);expect(view.player.setPan.mock.calls[0][0]).toBe(1);expect(view.player.setPan.mock.calls[0][1]).toBeGreaterThan(.2);
});
it('refuses a dock gesture that starts while busy but keeps the controls focusable and enabled',()=>{
  const view=setup(true);const range=screen.getByRole('slider',{name:'Bass volume'}),pan=screen.getByRole('slider',{name:'Bass pan'});
  expect(range).not.toBeDisabled();expect(range).toHaveAttribute('aria-disabled','true');expect(pan).toHaveAttribute('aria-disabled','true');
  fireEvent.change(range,{target:{value:'0.2'}});fireEvent.pointerUp(range,{pointerId:1});
  fireEvent.keyDown(pan,{key:'ArrowLeft'});
  expect(view.player.setTrackVolume).not.toHaveBeenCalled();expect(view.player.setPan).not.toHaveBeenCalled();
});

it('makes a track active from a click or Enter on its name, busy or not, and says which is active',()=>{
  const view=setup(true);
  const guitar=screen.getByRole('button',{name:/^Select track .*/,pressed:true}),bass=screen.getByRole('button',{name:'Select track Bass'});
  expect(bass).toHaveAttribute('aria-pressed','false');expect(bass).not.toBeDisabled();expect(guitar).not.toBe(bass);
  fireEvent.click(bass);expect(view.onSelect).toHaveBeenLastCalledWith(1);
  // Enter and Space on a focused name reach the button's own activation, not the grid's cell keys.
  bass.focus();expect(bass).toHaveFocus();
  const notPrevented=fireEvent.keyDown(bass,{key:'Enter'});expect(notPrevented).toBe(true);
  expect(view.player.setSolo).not.toHaveBeenCalled();
});

it('drops a dock drag when the track list changes under it, and never saves it onto the track that took its place',()=>{
  const view=setup(false);
  const range=screen.getByRole('slider',{name:'Bass volume'});
  fireEvent.pointerDown(range,{pointerId:1,button:0});fireEvent.change(range,{target:{value:'0.3'}});
  view.withoutFirstTrack();
  fireEvent.pointerUp(range,{pointerId:1});fireEvent.pointerUp(document.body,{pointerId:1});
  expect(view.player.setTrackVolume).not.toHaveBeenCalled();
  cleanup();
  const pan=setup(false);
  const knob=screen.getByRole('slider',{name:'Bass pan'});
  fireEvent.pointerDown(knob,{clientY:200,pointerId:1,button:0});fireEvent.pointerMove(knob,{clientY:150,pointerId:1,buttons:1});
  pan.withoutFirstTrack();
  fireEvent.pointerUp(document.body,{clientY:150,pointerId:1});
  expect(pan.player.setPan).not.toHaveBeenCalled();
});
it('lets Ctrl+Z, Ctrl+S and other shortcuts through a focused track name, and Enter still presses it',()=>{
  const view=setup(false);const seen:string[]=[];const spy=(event:KeyboardEvent)=>seen.push(`${event.ctrlKey?'Ctrl+':''}${event.key}`);
  document.addEventListener('keydown',spy);
  try{
    const name=screen.getByRole('button',{name:'Select track Bass'});name.focus();
    fireEvent.keyDown(name,{key:'z',ctrlKey:true});fireEvent.keyDown(name,{key:'s',ctrlKey:true});
    expect(seen).toEqual(['Ctrl+z','Ctrl+s']);
    expect(fireEvent.keyDown(name,{key:'Enter'})).toBe(true);expect(fireEvent.keyDown(name,{key:' '})).toBe(true);
    expect(seen).toContain('Enter');expect(view.player.setSolo).not.toHaveBeenCalled();
  }finally{document.removeEventListener('keydown',spy);}
});
