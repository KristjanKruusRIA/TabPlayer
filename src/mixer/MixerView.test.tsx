// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { model } from '@coderline/alphatab';
import { factorySound } from '../audio/factory-sounds';
import { DEFAULT_PRACTICE } from '../audio/practice-types';
import { soundPreset } from '../audio/sound-model';
import type { PlaybackState } from '../audio/types';
import type { MasterSettings, TrackSound } from '../edit-types';
import { previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';
import { midiPrograms } from '../midi-programs';
import { MixerView, describeTrackSound } from './MixerView';

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
    setTrackVolume:vi.fn(async()=>{}),
    setPan:vi.fn(async()=>{}),
    previewMix:vi.fn(async()=>{}),
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
  expect(screen.getAllByText('Selected')).toEqual([within(strip1).getByText('Selected')]);

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

it('dispatches exact live mix values through the volume Fader, pan Knob and switches, and selects the canonical channel', async()=>{
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

  // Dragging the vertical volume fader is heard while it moves and saved as one edit at pointerUp.
  sized(volume);
  const thumb=volume.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:168,pointerId:1});
  // 18 px down of 120 px of travel across 1.0 is -0.15: 0.70 - 0.15 = 0.55.
  expect(player.previewMix).toHaveBeenLastCalledWith(0,{gain:.55});
  expect(player.setTrackVolume).not.toHaveBeenCalled();
  fireEvent.pointerUp(thumb,{clientY:168,pointerId:1});
  expect(player.setTrackVolume).toHaveBeenCalledTimes(1);
  expect(player.setTrackVolume).toHaveBeenLastCalledWith(0,.55);
  // The player ends the preview when the edit lands, so the view does not end it early and step back.
  expect(player.previewMix).not.toHaveBeenCalledWith(0,null);

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

it('refuses mix changes while busy without dropping focus, and keeps channel selection when only the player is missing', ()=>{
  const initial=props(),{player}=livePlayer(initial.score),onSelect=vi.fn();
  const view=render(<MixerView {...initial} player={player} busy onSelect={onSelect}/>);
  // A control that may hold focus is refused with aria-disabled, never the disabled attribute.
  const mute=screen.getByLabelText('Mute'),solo=screen.getByLabelText('Solo'),select=screen.getByRole('button',{name:'Track 1: Guitar'});
  for(const control of [mute,solo,select,screen.getByRole('button',{name:'Reset focus'})]){
    expect(control).toHaveAttribute('aria-disabled','true');expect(control).not.toHaveAttribute('disabled');
  }
  for(const label of ['Volume Guitar','Pan Guitar','Focus selected track'])expect(screen.getByRole('slider',{name:label})).toHaveAttribute('aria-disabled','true');
  mute.focus();fireEvent.click(mute);fireEvent.click(solo);fireEvent.click(select);
  expect(mute).toHaveFocus();expect(mute).not.toBeChecked();
  const volume=screen.getByRole('slider',{name:'Volume Guitar'});volume.focus();fireEvent.keyDown(volume,{key:'ArrowDown'});
  fireEvent.keyDown(screen.getByRole('slider',{name:'Pan Guitar'}),{key:'ArrowUp'});
  expect(volume).toHaveFocus();
  expect([player.setMute,player.setSolo,player.setTrackVolume,player.setPan,player.previewMix,player.setFocus,onSelect].map(fn=>fn.mock.calls.length)).toEqual([0,0,0,0,0,0,0]);

  // Without a player the controls are unavailable, but a track can still be chosen.
  view.rerender(<MixerView {...initial} onSelect={onSelect}/>);
  for(const label of ['Mute','Solo'])expect(screen.getByLabelText(label)).toHaveAttribute('aria-disabled','true');
  for(const label of ['Volume Guitar','Pan Guitar','Focus selected track'])expect(screen.getByRole('slider',{name:label})).toHaveAttribute('aria-disabled','true');
  expect(select).not.toHaveAttribute('aria-disabled');
  fireEvent.click(select);expect(onSelect).toHaveBeenCalledWith(0);
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
  expect(screen.getByRole('button',{name:'Reset focus'})).toHaveAttribute('aria-disabled','true');

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

it('keeps one strip per track, in order, in a row that scrolls sideways rather than squeezing the strips', ()=>{
  let current=blankProject();
  for(let i=2;i<=7;i++)current=previewEdit(current,{type:'addTrack',name:`Track ${i}`,tuning:[64,59,55,50,45,40],program:25}).project;
  current=previewEdit(current,{type:'addPercussionTrack',name:'Drums',program:0}).project;
  const score=previewEdit(current,{type:'setRest',target}).score;
  const {container}=render(<MixerView {...props(score)}/>);
  const strips=[...container.querySelectorAll('.mixer-strips > .mixer-strip')];
  expect(strips.map(strip=>strip.getAttribute('aria-label'))).toEqual(score.tracks.map(track=>`Channel ${track.index+1}: ${track.name}`));
  expect(strips).toHaveLength(8);
  // jsdom applies no stylesheet, so read the rules that make the row scroll and keep every strip its width.
  const css=readFileSync('src/mixer/mixer.css','utf8');
  expect(css).toMatch(/\.mixer-strips\s*\{[^}]*overflow-x:auto/);
  expect(css).toMatch(/\.mixer-strip\s*\{[^}]*flex:0 0 156px/);
});

it('selecting a track changes no strip layout: the Selected slot is always there and the strip keeps its structure', ()=>{
  const score=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).score;
  const view=render(<MixerView {...props(score)}/>);
  const shape=()=>[...document.querySelectorAll('.mixer-strip')].map(strip=>[...strip.querySelectorAll('*')].map(node=>node.tagName+'.'+node.className).join('|'));
  const slots=()=>[...document.querySelectorAll('.mixer-strip-status')];
  const before=shape();
  expect(slots()).toHaveLength(2);
  expect(slots().map(slot=>slot.textContent)).toEqual(['Selected','']);
  view.rerender(<MixerView {...props(score)} selected={1}/>);
  expect(slots().map(slot=>slot.textContent)).toEqual(['','Selected']);
  // Same elements in the same order whichever strip is selected: only text and the selected flag differ.
  expect(shape().map(item=>item.replace(/ ?selected/g,''))).toEqual(before.map(item=>item.replace(/ ?selected/g,'')));
  // The slot has a fixed height in the stylesheet, empty or not.
  expect(readFileSync('src/mixer/mixer.css','utf8')).toMatch(/\.mixer-strip-status\s*\{[^}]*height:16px/);
});

it('names the sound a track really plays when no instrument is chosen, by program, as the native player does', ()=>{
  const track=(program:number,percussion=false)=>({isPercussion:percussion,playbackInfo:{program}}) as unknown as model.Track;
  const voice=(program:number,percussion=false)=>describeTrackSound(track(program,percussion)).voice;
  // The table in voices.rs: 24-25 green guitar, 26-31 black guitar, 33 babyblue bass, 32 and 34-39 darkblack bass.
  expect([24,25].map(p=>voice(p))).toEqual(['Green Guitar','Green Guitar']);
  expect([26,29,31].map(p=>voice(p))).toEqual(['Black Guitar','Black Guitar','Black Guitar']);
  expect(voice(33)).toBe('Babyblue Bass');
  expect([32,34,39].map(p=>voice(p))).toEqual(['Darkblack Bass','Darkblack Bass','Darkblack Bass']);
  // Anything else is the General MIDI sound for that program; percussion is its own.
  expect(voice(0)).toBe(midiPrograms[0]);expect(voice(40)).toBe(midiPrograms[40]);expect(voice(23)).toBe(midiPrograms[23]);
  expect(voice(33,true)).toBe('Percussion');
  // A chosen instrument wins over the program, and General MIDI is named as such.
  expect(describeTrackSound(track(24),{voiceId:'black-guitar',presetId:'gm',effects:soundPreset('gm').effects}).voice).toBe('Black Guitar');
  expect(describeTrackSound(track(24),soundPreset('gm','gm')).voice).toBe('General MIDI');
});

it('reads a tweaked sound as edited, and a restored one as its preset or factory sound again', ()=>{
  const [guitar]=base().tracks;
  const tone=(sound:TrackSound)=>describeTrackSound(guitar,sound).tone;
  expect(tone(soundPreset('crunch'))).toBe('Crunch');
  expect(tone(factorySound('rock-lead')!)).toBe('Rock lead');
  const tweakedPreset=soundPreset('crunch');tweakedPreset.effects.amp.drive=.9;
  expect(tone(tweakedPreset)).toBe('Crunch (edited)');
  const tweakedFactory=factorySound('rock-lead')!;tweakedFactory.effects.reverb.mix=.01;
  expect(tone(tweakedFactory)).toMatch(/\(edited\)$/);
  const bypassTweaked=soundPreset('gm');bypassTweaked.effects.drive.enabled=true;
  expect(tone(bypassTweaked)).toBe('Bypass (edited)');
  expect(tone(soundPreset('gm'))).toBe('Bypass');
  // The strip shows it too.
  render(<MixerView {...props(base(),{[trackIdentity(guitar)]:tweakedPreset})}/>);
  expect(within(screen.getByRole('group',{name:'Sound Guitar'})).getByText('Crunch (edited)')).toBeInTheDocument();
});

it('puts the master output in the mixer and sends its changes through setMaster, not the track mix', async()=>{
  const initial=props(),{player}=livePlayer(initial.score);
  const setMaster=vi.fn(async(_master:MasterSettings)=>{});
  const withMaster={...player,master:()=>undefined,setMaster};
  render(<MixerView {...initial} player={withMaster}/>);
  const master=screen.getByRole('region',{name:'Master'});
  expect(within(screen.getByRole('region',{name:'Mixer'})).getByRole('region',{name:'Master'})).toBe(master);
  const level=within(master).getByRole('slider',{name:'Master level'});
  fireEvent.change(level,{target:{value:'-6'}});fireEvent.pointerUp(level);
  await vi.waitFor(()=>expect(setMaster).toHaveBeenCalledTimes(1));
  expect(setMaster.mock.calls[0][0]).toMatchObject({gainDb:-6});
  expect(player.setTrackVolume).not.toHaveBeenCalled();expect(player.setPan).not.toHaveBeenCalled();
  // No setMaster on the player: the master is shown but cannot be changed.
  cleanup();
  render(<MixerView {...initial} player={player}/>);
  expect(within(screen.getByRole('region',{name:'Master'})).getByRole('slider',{name:'Master level'})).toHaveAttribute('aria-disabled','true');
});

it('ends the heard drag without saving when it is cancelled or ends where it began', async()=>{
  const initial=props(),{player}=livePlayer(initial.score);
  render(<MixerView {...initial} player={player}/>);
  const volume=screen.getByRole('slider',{name:'Volume Guitar'});sized(volume);
  const thumb=volume.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:168,pointerId:1});
  expect(player.previewMix).toHaveBeenLastCalledWith(0,{gain:.55});
  fireEvent.keyDown(volume,{key:'Escape'});
  await vi.waitFor(()=>expect(player.previewMix).toHaveBeenLastCalledWith(0,null));
  expect(player.setTrackVolume).not.toHaveBeenCalled();
  // Back where it began: heard on the way, nothing to save, the saved level restored.
  player.previewMix.mockClear();
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:2});
  fireEvent.pointerMove(thumb,{clientY:168,pointerId:2});
  fireEvent.pointerMove(thumb,{clientY:150,pointerId:2});
  fireEvent.pointerUp(thumb,{clientY:150,pointerId:2});
  await vi.waitFor(()=>expect(player.previewMix).toHaveBeenLastCalledWith(0,null));
  expect(player.setTrackVolume).not.toHaveBeenCalled();
});

/** A fader drag begun on the Guitar strip of a two-track score, with the preview heard. */
function dragGuitar(player:ReturnType<typeof livePlayer>['player'],score:model.Score) {
  const view=render(<MixerView {...props(score)} player={player}/>);
  const volume=screen.getByRole('slider',{name:'Volume Guitar'});sized(volume);
  const thumb=volume.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:168,pointerId:1});
  expect(player.previewMix).toHaveBeenLastCalledWith(0,{gain:.55});
  expect(volume).toHaveAttribute('aria-valuenow','0.55');
  return {view,volume,thumb};
}
const twoTracks=()=>previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33});

it('drops a drag when its track is deleted, even after Ctrl+Z passes through the fader, and never saves it onto the track that took its place', async()=>{
  const added=twoTracks(),{player}=livePlayer(added.score);
  const {view,volume,thumb}=dragGuitar(player,added.score);
  fireEvent.keyDown(volume,{key:'z',ctrlKey:true});
  // The track list changes under the drag: Guitar is gone and Bass is now track 0.
  const removed=previewEdit(added.project,{type:'removeTrack',track:0}).score;
  view.rerender(<MixerView {...props(removed)} player={player}/>);
  expect(screen.queryByRole('slider',{name:'Volume Guitar'})).toBeNull();
  fireEvent.pointerUp(thumb,{clientY:168,pointerId:1});
  expect(player.setTrackVolume).not.toHaveBeenCalled();
  await vi.waitFor(()=>expect(player.previewMix).toHaveBeenLastCalledWith(expect.any(Number),null));
  const bass=screen.getByRole('slider',{name:'Volume Bass'});
  expect(bass).toHaveAttribute('aria-valuenow','0.7');
  // And a drag of the survivor is its own: it saves on index 0.
  sized(bass);const bassThumb=bass.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(bassThumb,{clientY:150,pointerId:2});fireEvent.pointerMove(bassThumb,{clientY:168,pointerId:2});fireEvent.pointerUp(bassThumb,{clientY:168,pointerId:2});
  expect(player.setTrackVolume).toHaveBeenCalledTimes(1);expect(player.setTrackVolume).toHaveBeenCalledWith(0,.55);
});

it('keeps a drag with its track when the track list is reordered by an undo that adds a track before it', ()=>{
  const added=twoTracks(),{player}=livePlayer(added.score);
  const removed=previewEdit(added.project,{type:'removeTrack',track:0}).score;
  const view=render(<MixerView {...props(removed)} player={player}/>);
  const bass=screen.getByRole('slider',{name:'Volume Bass'});sized(bass);
  const thumb=bass.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});fireEvent.pointerMove(thumb,{clientY:168,pointerId:1});
  // Guitar comes back (undo): Bass is track 1 now, and the same strip goes on being dragged.
  view.rerender(<MixerView {...props(added.score)} player={player}/>);
  expect(screen.getByRole('slider',{name:'Volume Bass'})).toBe(bass);
  fireEvent.pointerUp(thumb,{clientY:168,pointerId:1});
  expect(player.setTrackVolume).toHaveBeenCalledTimes(1);expect(player.setTrackVolume).toHaveBeenCalledWith(1,.55);
});

it('ends a drag when the mixer turns busy: the level goes back, the sound goes back and release saves nothing', async()=>{
  const added=twoTracks(),{player}=livePlayer(added.score);
  const {view,volume,thumb}=dragGuitar(player,added.score);
  view.rerender(<MixerView {...props(added.score)} busy player={player}/>);
  expect(volume).toHaveAttribute('aria-valuenow','0.7');
  await vi.waitFor(()=>expect(player.previewMix).toHaveBeenLastCalledWith(0,null));
  player.previewMix.mockClear();
  fireEvent.pointerMove(thumb,{clientY:190,pointerId:1});
  fireEvent.pointerUp(thumb,{clientY:190,pointerId:1});
  expect(volume).toHaveAttribute('aria-valuenow','0.7');
  expect(player.setTrackVolume).not.toHaveBeenCalled();expect(player.previewMix).not.toHaveBeenCalledWith(0,{gain:expect.any(Number)});
});

it('ends a drag without saving when the fader loses focus or its pointer capture', async()=>{
  for(const lose of ['blur','capture'] as const){
    const added=twoTracks(),{player}=livePlayer(added.score);
    const {volume,thumb}=dragGuitar(player,added.score);
    if(lose==='blur')fireEvent.blur(volume);else fireEvent.lostPointerCapture(volume,{pointerId:1});
    expect(volume).toHaveAttribute('aria-valuenow','0.7');
    await vi.waitFor(()=>expect(player.previewMix).toHaveBeenLastCalledWith(0,null));
    fireEvent.pointerUp(thumb,{clientY:168,pointerId:1});
    expect(player.setTrackVolume).not.toHaveBeenCalled();
    cleanup();
  }
});
