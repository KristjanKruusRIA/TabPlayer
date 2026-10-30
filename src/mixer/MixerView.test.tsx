// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { factorySound } from '../audio/factory-sounds';
import { DEFAULT_PRACTICE } from '../audio/practice-types';
import { soundPreset } from '../audio/sound-model';
import type { PlaybackState } from '../audio/types';
import type { TrackSound } from '../edit-types';
import { previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { MixerView } from './MixerView';

afterEach(cleanup);

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const base=()=>previewEdit(blankProject(),{type:'setRest',target}).score;
/** A fader 134 px high has 120 px of travel for its thumb. */
const sized=(element:HTMLElement)=>{element.getBoundingClientRect=()=>({top:100,left:0,right:36,bottom:234,height:134,width:36,x:0,y:100,toJSON:()=>({})});};

function livePlayer(score:model.Score) {
  let state:PlaybackState={ready:true,playing:true,time:0,endTime:1000,measure:0,speed:100,metronome:false,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'playing',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},practicePending:false,practiceNotice:null,range:null,loop:null,error:null};
  const listeners=new Set<()=>void>(),remove=vi.fn();
  let mix={mute:false,solo:true,volume:.7,pan:-.2};
  const player={
    subscribe:vi.fn((fn:()=>void)=>{listeners.add(fn);return()=>{remove();listeners.delete(fn);};}),
    getState:()=>state,
    mix:vi.fn((_track:model.Track)=>mix),
    setMute:vi.fn(),
    setSolo:vi.fn(),
    setTrackVolume:vi.fn(),
    setPan:vi.fn(),
    focus:()=>null,
    setFocus:vi.fn(async()=>{}),
  };
  return {
    player,
    remove,
    emit:(patch:Partial<PlaybackState>={},mixPatch:Partial<typeof mix>={})=>{
      state={...state,...patch};
      mix={...mix,...mixPatch};
      act(()=>{for(const fn of listeners)fn();});
    },
    score,
  };
}

function props(score=base(),sounds?:Record<string,TrackSound>) {
  return {score,sounds,selected:0,busy:false,onSelect:vi.fn(),player:null};
}

it('shows one channel strip per track with its color swatch, name and current sound', ()=>{
  const withColor=previewEdit(blankProject(),{type:'setTrackColor',track:0,color:'#ff8800'});
  const withBass=previewEdit(withColor.project,{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  const withDrums=previewEdit(withBass.project,{type:'addPercussionTrack',name:'Drums',program:0});
  const score=withDrums.score;
  const [guitarId,bassId]=score.tracks.map(trackIdentity);
  const sounds:Record<string,TrackSound>={
    [guitarId]:factorySound('rock-lead','green-guitar')!,
    [bassId]:soundPreset('bass','darkblack-bass'),
  };
  render(<MixerView {...props(score,sounds)}/>);

  const mixer=screen.getByRole('region',{name:'Mixer'});
  expect(mixer).toBeInTheDocument();

  const strip1=within(mixer).getByRole('region',{name:'Channel 1: Guitar'});
  const swatch=within(strip1).getByRole('button',{name:'Track 1: Guitar'}).querySelector('.track-color-swatch') as HTMLElement;
  expect(swatch).toHaveAttribute('aria-hidden','true');
  expect(swatch.style.backgroundColor).toBe('rgb(255, 136, 0)');
  expect(within(strip1).getByText('Green Guitar')).toBeVisible();
  expect(within(strip1).getByText('Rock lead')).toBeVisible();
  expect(within(strip1).getByText('Selected')).toBeVisible();

  const strip2=within(mixer).getByRole('region',{name:'Channel 2: Bass'});
  expect(within(strip2).getByText('Darkblack Bass')).toBeVisible();
  expect(within(strip2).getByText('Bass')).toBeVisible();

  const strip3=within(mixer).getByRole('region',{name:'Channel 3: Drums'});
  expect(within(strip3).getByText('Percussion')).toBeVisible();
  expect(within(strip3).getByText('Bypass')).toBeVisible();
});

it('shows the current instrument mix after deletion and undo change its index', ()=>{
  const added=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});
  let score=added.score;
  const state={};
  const player={
    subscribe:()=>()=>{},
    getState:()=>state,
    focus:()=>null,
    mix:(value:number|model.Track)=>{
      const track=typeof value==='number'?score.tracks[value]:value;
      return {mute:track.name==='Bass',solo:false,volume:track.name==='Bass'?.5:1,pan:0};
    },
  };
  const currentProps=()=>({...props(score),player:player as never});
  const view=render(<MixerView {...currentProps()}/>);
  expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();

  score=previewEdit(added.project,{type:'removeTrack',track:0}).score;
  view.rerender(<MixerView {...currentProps()}/>);
  expect(screen.getByLabelText('Mute')).toBeChecked();
  expect(screen.getByRole('slider',{name:'Volume Bass'})).toHaveAttribute('aria-valuenow','0.5');
  expect(screen.getByRole('slider',{name:'Volume Bass'})).toHaveAttribute('aria-valuetext','0.50');

  score=added.score;
  view.rerender(<MixerView {...currentProps()}/>);
  expect(screen.getAllByLabelText('Mute')[0]).not.toBeChecked();
  expect(screen.getAllByLabelText('Mute')[1]).toBeChecked();
});

it('dispatches exact live mix values through the volume Fader, pan Knob and switches, and selects the canonical channel', ()=>{
  const initial=props(),{player,emit}=livePlayer(initial.score),onSelect=vi.fn();
  render(<MixerView {...initial} player={player} onSelect={onSelect}/>);

  expect(screen.getByLabelText('Mute')).not.toBeChecked();
  expect(screen.getByLabelText('Solo')).toBeChecked();

  const volume=screen.getByRole('slider',{name:'Volume Guitar'});
  const pan=screen.getByRole('slider',{name:'Pan Guitar'});
  expect(volume).toHaveAttribute('aria-orientation','vertical');
  expect(volume).toHaveAttribute('aria-valuenow','0.7');
  expect(volume).toHaveAttribute('aria-valuemin','0');
  expect(volume).toHaveAttribute('aria-valuemax','1');
  expect(volume).toHaveAttribute('aria-valuetext','0.70');

  expect(pan).toHaveAttribute('aria-valuenow','-0.2');
  expect(pan).toHaveAttribute('aria-valuemin','-1');
  expect(pan).toHaveAttribute('aria-valuemax','1');
  expect(pan).toHaveAttribute('aria-valuetext','-0.20');

  fireEvent.click(screen.getByLabelText('Mute'));
  expect(player.setMute).toHaveBeenLastCalledWith(0,true);
  fireEvent.click(screen.getByLabelText('Solo'));
  expect(player.setSolo).toHaveBeenLastCalledWith(0,false);

  // Dragging the vertical volume fader commits one edit at pointerUp.
  sized(volume);
  const thumb=volume.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:168,pointerId:1});
  expect(player.setTrackVolume).not.toHaveBeenCalled();
  fireEvent.pointerUp(thumb,{clientY:168,pointerId:1});
  // 18 px down of 120 px of travel across 1.0 is -0.15: 0.70 - 0.15 = 0.55.
  expect(player.setTrackVolume).toHaveBeenLastCalledWith(0,.55);

  // Arrow keys and double-click reset on the pan knob.
  fireEvent.keyDown(pan,{key:'ArrowUp'});
  expect(player.setPan).toHaveBeenLastCalledWith(0,-.15);
  fireEvent.doubleClick(pan);
  expect(player.setPan).toHaveBeenLastCalledWith(0,0);

  const channel=screen.getByRole('button',{name:'Track 1: Guitar'});
  expect(channel).toHaveAttribute('aria-pressed','true');
  fireEvent.click(channel);
  expect(onSelect).toHaveBeenLastCalledWith(0);

  emit({},{mute:true,solo:false,volume:.55,pan:.25});
  expect(screen.getByLabelText('Mute')).toBeChecked();
  expect(volume).toHaveAttribute('aria-valuenow','0.55');
  expect(volume).toHaveAttribute('aria-valuetext','0.55');
  expect(pan).toHaveAttribute('aria-valuenow','0.25');
  expect(pan).toHaveAttribute('aria-valuetext','0.25');
});

it('disables all mix changes when busy or without a player while retaining channel selection', ()=>{
  const initial=props(),{player}=livePlayer(initial.score);
  const view=render(<MixerView {...initial} player={player} busy/>);
  for(const label of ['Mute','Solo'])expect(screen.getByLabelText(label)).toBeDisabled();
  for(const label of ['Volume Guitar','Pan Guitar','Focus selected track'])expect(screen.getByRole('slider',{name:label})).toHaveAttribute('aria-disabled','true');
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toBeDisabled();

  view.rerender(<MixerView {...initial}/>);
  for(const label of ['Mute','Solo'])expect(screen.getByLabelText(label)).toBeDisabled();
  for(const label of ['Volume Guitar','Pan Guitar','Focus selected track'])expect(screen.getByRole('slider',{name:label})).toHaveAttribute('aria-disabled','true');
  expect(screen.getByRole('button',{name:'Track 1: Guitar'})).toBeEnabled();
});

it('sweeps focus on the selected track by identity, follows the selection and resets', ()=>{
  const score=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  const [guitar,bass]=score.tracks.map(trackIdentity);
  let focus:{track:string;amount:number}|null=null;
  const listeners=new Set<()=>void>();
  let state={ready:true,error:null as string|null};
  const player={
    subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    getState:()=>state,
    mix:()=>undefined,
    setMute:vi.fn(),
    setSolo:vi.fn(),
    setTrackVolume:vi.fn(),
    setPan:vi.fn(),
    focus:()=>focus,
    setFocus:vi.fn(async(track:string,amount:number)=>{
      focus=amount?{track,amount}:null;
      state={...state};
      act(()=>{for(const fn of listeners)fn();});
    }),
  };
  const view=render(<MixerView {...props(score)} player={player as never}/>);
  const slider=screen.getByRole('slider',{name:'Focus selected track'});
  expect(slider).toHaveAttribute('aria-valuenow','0');
  expect(screen.getByText('Off')).toBeVisible();
  expect(screen.getByRole('button',{name:'Reset focus'})).toBeDisabled();

  // Click readout to type 60%.
  fireEvent.click(screen.getByText('Off'));
  const field=screen.getByRole('textbox',{name:'Focus selected track value'});
  fireEvent.change(field,{target:{value:'60'}});
  fireEvent.keyDown(field,{key:'Enter'});
  expect(player.setFocus).toHaveBeenLastCalledWith(guitar,.6);
  expect(screen.getByText('Focus 60%')).toBeVisible();

  view.rerender(<MixerView {...props(score)} selected={1} player={player as never}/>);
  expect(player.setFocus).toHaveBeenLastCalledWith(bass,.6);

  fireEvent.click(screen.getByText('Focus 60%'));
  const negField=screen.getByRole('textbox',{name:'Focus selected track value'});
  fireEvent.change(negField,{target:{value:'-40'}});
  fireEvent.keyDown(negField,{key:'Enter'});
  expect(player.setFocus).toHaveBeenLastCalledWith(bass,-.4);
  expect(screen.getByText('Unfocus 40%')).toBeVisible();

  fireEvent.click(screen.getByRole('button',{name:'Reset focus'}));
  expect(player.setFocus).toHaveBeenLastCalledWith(bass,0);
  expect(slider).toHaveAttribute('aria-valuenow','0');
  expect(player.setTrackVolume).not.toHaveBeenCalled();

  // A focus held by another track (not yet moved) does not show as the selected track's.
  focus={track:guitar,amount:.3};
  state={...state};
  act(()=>{for(const fn of listeners)fn();});
  expect(slider).toHaveAttribute('aria-valuenow','0');

  // Focus waits for ready, error-free playback.
  state={ready:false,error:null};
  act(()=>{for(const fn of listeners)fn();});
  expect(slider).toHaveAttribute('aria-disabled','true');
  state={ready:true,error:'Device lost'};
  act(()=>{for(const fn of listeners)fn();});
  expect(slider).toHaveAttribute('aria-disabled','true');
});

it('explains that focusing a silent track lowers everything you hear', ()=>{
  const score=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  const state={ready:true,error:null};
  const player={
    subscribe:()=>()=>{},
    getState:()=>state,
    mix:(track:model.Track)=>({mute:false,solo:track.index===1,volume:1,pan:0}),
    setMute:vi.fn(),
    setSolo:vi.fn(),
    setTrackVolume:vi.fn(),
    setPan:vi.fn(),
    focus:()=>null,
    setFocus:vi.fn(async()=>{}),
  };
  const view=render(<MixerView {...props(score)} player={player as never}/>);
  expect(screen.getByText('The selected track is silent, so focusing it lowers everything you hear.')).toBeVisible();
  view.rerender(<MixerView {...props(score)} selected={1} player={player as never}/>);
  expect(screen.queryByText(/selected track is silent/)).toBeNull();
});

it('renders a horizontally scrollable strip list when there are many tracks', ()=>{
  let current=blankProject();
  for(let i=2;i<=7;i++)current=previewEdit(current,{type:'addTrack',name:`Track ${i}`,tuning:[64,59,55,50,45,40],program:25}).project;
  current=previewEdit(current,{type:'addPercussionTrack',name:'Drums',program:0}).project;
  const score=previewEdit(current,{type:'setRest',target}).score;
  const {container}=render(<MixerView {...props(score)}/>);
  const strips=container.querySelector('.mixer-strips');
  expect(strips).not.toBeNull();
  expect(strips?.querySelectorAll('.mixer-strip')).toHaveLength(8);
});
