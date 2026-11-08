// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// These tests drive the whole rig with real typing and pointer input. Under a loaded machine a default one-second wait for an
// async result, or five seconds for a whole test, is too tight, so both are raised.
configure({asyncUtilTimeout:8000});vi.setConfig({testTimeout:60000});
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import type { EditCommand, TrackSound } from '../edit-types';
import { effectBlocks } from '../document-settings';
import { blockNames, soundPreset } from '../audio/sound-model';
import { factoryCategories, factorySound, factorySounds } from '../audio/factory-sounds';
import { forgetSessionSoundLibrary, saveSoundPreset, copyPedal, copySound } from '../audio/sound-library';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { SoundRig } from './SoundRig';

beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();forgetSessionSoundLibrary();localStorage.clear();});

/** A stand-in for the native playback controller's preview and device surface. */
function playback() {
  let preview:{track:string;sound:TrackSound}|null=null;const listeners=new Set<()=>void>();let state:{error?:string}|null=null;
  const fake={
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},getState:()=>state,
    devices:vi.fn(async()=>[{id:'speakers',name:'Studio speakers',isDefault:false}]),deviceId:()=>null,selectDevice:vi.fn(),
    soundPreview:()=>preview,
    fail:(message:string)=>{state={error:message};listeners.forEach(listener=>listener());},
    previewSound:vi.fn(async(track:string,sound:TrackSound|null)=>{preview=sound?{track,sound:structuredClone(sound)}:null;listeners.forEach(listener=>listener());}),
  };
  return fake;
}
type Fake=ReturnType<typeof playback>;
interface Options {busy?:boolean;player?:Fake|null;edit?:(command:EditCommand)=>void|Promise<void>;cabinetResponse?:()=>React.ReactNode;ampCapture?:()=>React.ReactNode;master?:React.ReactNode}
/** The rig over a sound it keeps, as the app does, recording every edit it is asked for. */
function mount(initial:TrackSound=soundPreset('lead','green-guitar'),{busy=false,player=playback(),edit,cabinetResponse,ampCapture,master}:Options={}) {
  const edits:EditCommand[]=[];
  function Host() {
    const [sound,setSound]=useState(initial),[track,setTrack]=useState('guitar');
    return <SoundRig trackId={track} sound={sound} busy={busy} playback={player as unknown as NativePlaybackController|null} cabinetResponse={cabinetResponse} ampCapture={ampCapture} master={master}
      tracks={[{id:'guitar',name:'Lead Guitar',program:29},{id:'bass',name:'Bass',program:33},{id:'drums',name:'Drums',program:0,percussion:true},{id:'piano',name:'Piano',program:0}]} onTrack={setTrack}
      onEdit={async command=>{edits.push(command);await edit?.(command);if(command.type==='setTrackSound')setSound(command.sound);}}/>;
  }
  const view=render(<Host/>);
  return {edits,player,view,last:()=>(edits.at(-1) as Extract<EditCommand,{type:'setTrackSound'}>).sound};
}
const tab=(block:keyof typeof blockNames)=>screen.getByRole('tab',{name:new RegExp(`^${blockNames[block]}, `)});
const choose=async(block:keyof typeof blockNames)=>{await userEvent.click(tab(block));};
const drag=(element:HTMLElement,from:number,to:number)=>{
  fireEvent.pointerDown(element,{clientY:from,pointerId:1});
  for(const y of [from-(from-to)*.25,from-(from-to)*.5,to])fireEvent.pointerMove(element,{clientY:y,pointerId:1});
  fireEvent.pointerUp(element,{clientY:to,pointerId:1});
};

it('shows all eighteen blocks as a horizontal chain, with the amp chosen and its state in each name', ()=>{
  mount();
  const chain=screen.getByRole('tablist',{name:'Signal chain'});
  const tabs=within(chain).getAllByRole('tab');
  expect(tabs).toHaveLength(18);
  expect(tabs.map(item=>item.getAttribute('aria-label')?.split(',')[0])).toEqual(effectBlocks.map(block=>blockNames[block]));
  expect(tab('amp')).toHaveAttribute('aria-selected','true');expect(tab('amp')).toHaveAccessibleName('Amp, enabled');
  expect(tab('gate')).toHaveAccessibleName('Gate, bypassed');
  expect(screen.getByRole('tabpanel',{name:'Amp'})).toBeInTheDocument();
});

it('shows each block\'s own stage when it is chosen', async()=>{
  mount();
  for(const block of effectBlocks){await choose(block);expect(screen.getByRole('tabpanel',{name:blockNames[block]})).toBeVisible();expect(tab(block)).toHaveAttribute('aria-selected','true');}
});

it('is a single tab stop whose arrow keys move between blocks without choosing them', async()=>{
  const user=userEvent.setup();mount();
  const tabs=screen.getAllByRole('tab');
  expect(tabs.filter(item=>item.tabIndex===0)).toEqual([tab('amp')]);
  tab('amp').focus();
  await user.keyboard('{ArrowRight}');expect(tab('cabinet')).toHaveFocus();expect(tab('amp')).toHaveAttribute('aria-selected','true');
  await user.keyboard('{Enter}');expect(tab('cabinet')).toHaveAttribute('aria-selected','true');
  await user.keyboard('{Home}');expect(tab('microphone')).toHaveFocus();
  await user.keyboard('{End}');expect(tab('reverb')).toHaveFocus();
  await user.keyboard('{ArrowLeft}');expect(tab('delay')).toHaveFocus();
});

it('switches a block on or off with Space, as one edit, without choosing it', async()=>{
  const user=userEvent.setup(),{edits,last}=mount();
  tab('gate').focus();await user.keyboard(' ');
  expect(edits).toHaveLength(1);expect(last().effects.gate.enabled).toBe(true);
  expect(tab('amp')).toHaveAttribute('aria-selected','true');
  await user.keyboard(' ');expect(last().effects.gate.enabled).toBe(false);expect(edits).toHaveLength(2);
});

it('keeps the chain footswitch out of the accessibility tree and switches with a click', ()=>{
  const {edits,last,view}=mount();
  const switches=view.container.querySelectorAll('.rig-chain-switch');
  expect(switches.length).toBeGreaterThan(0);for(const item of switches)expect(item).toHaveAttribute('aria-hidden','true');
  fireEvent.click(tab('drive').parentElement!.querySelector('.rig-chain-switch')!);
  expect(edits).toHaveLength(1);expect(last().effects.drive.enabled).toBe(true);
});

it('moves a block along the chain with Alt and the arrow keys, as one edit, and keeps focus on it', async()=>{
  const user=userEvent.setup(),{edits,last}=mount();
  tab('amp').focus();
  await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
  expect(edits).toHaveLength(1);
  const names=last().effects.order!;expect(names.indexOf('amp')).toBe(effectBlocks.indexOf('amp')-1);expect(names.indexOf('drive')).toBe(effectBlocks.indexOf('amp'));
  expect(screen.getByRole('status')).toHaveTextContent('Amp is now 7 of 18 in the chain.');
  expect(tab('amp')).toHaveFocus();
  await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
  expect(edits).toHaveLength(2);expect(last().effects.order).toBeUndefined();
});

it('moves a block by dragging it, as one edit', ()=>{
  const {edits,last,view}=mount();
  const items=[...view.container.querySelectorAll<HTMLElement>('.rig-chain-tab')];
  // Lay the tabs out 50 px apart for the hit test.
  items.forEach((item,index)=>{item.getBoundingClientRect=()=>({left:index*50,right:index*50+48,width:48,top:0,bottom:60,height:60,x:index*50,y:0,toJSON:()=>({})});});
  const amp=tab('amp');
  fireEvent.pointerDown(amp,{clientX:7*50+20,pointerId:1,button:0});
  fireEvent.pointerMove(amp,{clientX:7*50+20-3,pointerId:1});
  expect(edits).toHaveLength(0);
  fireEvent.pointerMove(amp,{clientX:2*50+30,pointerId:1});fireEvent.pointerMove(amp,{clientX:2*50+30,pointerId:1});
  fireEvent.pointerUp(amp,{clientX:2*50+30,pointerId:1});
  expect(edits).toHaveLength(1);expect(last().effects.order!.indexOf('amp')).toBe(2);
  // The click that ends a drag does not choose the block again.
  fireEvent.click(amp);
});

it('moves blocks earlier and later with its buttons, which stop at the ends', async()=>{
  const user=userEvent.setup(),{edits,last}=mount();
  await choose('microphone');
  {const b=screen.getByRole('button',{name:'Move Microphone earlier'});expect(b).toHaveAttribute('aria-disabled','true');expect(b).not.toBeDisabled();}
  await user.click(screen.getByRole('button',{name:'Move Microphone later'}));
  expect(last().effects.order!.slice(0,2)).toEqual(['gate','microphone']);expect(edits).toHaveLength(1);
  await choose('reverb');{const b=screen.getByRole('button',{name:'Move Reverb later'});expect(b).toHaveAttribute('aria-disabled','true');expect(b).not.toBeDisabled();}
});

it('records one undoable edit for a whole knob drag', async()=>{
  const {edits,last}=mount();
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  fireEvent.pointerDown(gain,{clientY:300,pointerId:1});
  for(const y of [290,270,250,240])fireEvent.pointerMove(gain,{clientY:y,pointerId:1});
  expect(edits).toHaveLength(0);
  fireEvent.pointerUp(gain,{clientY:240,pointerId:1});
  expect(edits).toHaveLength(1);
  expect(last().effects.amp.gainDb).toBe(18);// 60 px of 160 across 48 dB
  expect(edits[0]).toMatchObject({type:'setTrackSound',trackId:'guitar'});
  // Everything else about the sound is untouched.
  const expected=structuredClone(soundPreset('lead','green-guitar'));expected.effects.amp.gainDb=18;expect(last()).toEqual(expected);
});

it('changes every amp field and the model through the faceplate, keeping the same accessible names', async()=>{
  const {last,edits}=mount();
  const fields:[string,string,number,(sound:TrackSound)=>number|undefined][]=[
    ['amp Drive','ArrowUp',.76,sound=>sound.effects.amp.drive],['amp Gain (dB)','ArrowUp',.1,sound=>sound.effects.amp.gainDb],['amp Bass (dB)','ArrowUp',.5,sound=>sound.effects.amp.bassDb],
    ['amp Mid (dB)','ArrowDown',-.5,sound=>sound.effects.amp.midDb],['amp Treble (dB)','ArrowUp',.5,sound=>sound.effects.amp.trebleDb],['amp Presence (dB)','ArrowDown',-.5,sound=>sound.effects.amp.presenceDb]];
  for(const [name,key,expected,read] of fields){fireEvent.keyDown(screen.getByRole('slider',{name}),{key});expect(read(last())).toBeCloseTo(expected,5);}
  expect(edits).toHaveLength(6);
  const group=screen.getByRole('radiogroup',{name:'Amp model'});
  expect(within(group).getAllByRole('radio').map(radio=>radio.textContent)).toEqual(['Clean','Crunch','Lead','Metal','Bass','Bass drive']);
  await userEvent.click(within(group).getByRole('radio',{name:'Bass drive'}));
  expect(last().effects.amp.model).toBe('bassDrive');
});

it('leaves a tone-stack field out of the saved sound while it is flat, as the inspector does', ()=>{
  const sound=soundPreset('lead');sound.effects.amp.bassDb=3;
  const {last}=mount(sound);
  fireEvent.keyDown(screen.getByRole('slider',{name:'amp Bass (dB)'}),{key:'Home'});
  fireEvent.doubleClick(screen.getByRole('slider',{name:'amp Bass (dB)'}));
  expect(last().effects.amp.bassDb).toBeUndefined();
});

it('switches the chosen block on and off with a named switch', async()=>{
  const {last}=mount();
  await choose('gate');
  const gate=screen.getByRole('switch',{name:'Enable gate'});
  expect(gate).toHaveAttribute('aria-checked','false');
  await userEvent.click(gate);expect(last().effects.gate.enabled).toBe(true);expect(gate).toHaveAttribute('aria-checked','true');
});

it('gives each pedal knobs for every field and the right limits', async()=>{
  mount();
  await choose('compressor');
  for(const name of ['compressor Threshold (dB)','compressor Ratio','compressor Attack (ms)','compressor Release (ms)','compressor Makeup (dB)'])expect(screen.getByRole('slider',{name})).toBeInTheDocument();
  const ratio=screen.getByRole('slider',{name:'compressor Ratio'});
  expect(ratio).toHaveAttribute('aria-valuemin','1');expect(ratio).toHaveAttribute('aria-valuemax','20');expect(ratio).toHaveAttribute('aria-valuetext','4.0');
  expect(screen.getByRole('slider',{name:'compressor Threshold (dB)'})).toHaveAttribute('aria-valuetext','−18 dB');
});

it('sets a pedal\'s models with radio groups', async()=>{
  const {last}=mount();
  await choose('drive');await userEvent.click(within(screen.getByRole('radiogroup',{name:'Drive model'})).getByRole('radio',{name:'Fuzz'}));expect(last().effects.drive.model).toBe('fuzz');
  await choose('reverb');await userEvent.click(within(screen.getByRole('radiogroup',{name:'Reverb model'})).getByRole('radio',{name:'Spring'}));expect(last().effects.reverb.model).toBe('spring');
  await choose('delay');
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Delay model'})).getByRole('radio',{name:'Tape'}));expect(last().effects.delay.model).toBe('tape');
  fireEvent.change(screen.getByRole('combobox',{name:'Delay time'}),{target:{value:'1.5'}});expect(last().effects.delay.quarterNotes).toBe(1.5);
  expect(screen.getByText('Delay times are limited to 16 seconds.')).toBeInTheDocument();
  await choose('tremolo');await userEvent.click(within(screen.getByRole('radiogroup',{name:'Tremolo shape'})).getByRole('radio',{name:'Square'}));expect(last().effects.tremolo.shape).toBe('square');
  await choose('phaser');await userEvent.click(within(screen.getByRole('radiogroup',{name:'Phaser stages'})).getByRole('radio',{name:'8'}));expect(last().effects.phaser.stages).toBe(8);
});

it('offers the wah\'s four models and two modes, and switches off the knob the mode does not use', async()=>{
  const {last}=mount();
  await choose('wah');
  expect(within(screen.getByRole('radiogroup',{name:'Wah model'})).getAllByRole('radio').map(radio=>radio.textContent)).toEqual(['Classic','Vintage (vocal)','Wide range','Bass']);
  expect(screen.getByRole('slider',{name:'wah Sensitivity'})).toHaveAttribute('aria-disabled','true');
  expect(screen.getByRole('slider',{name:'wah Pedal position'})).not.toHaveAttribute('aria-disabled');
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Wah mode'})).getByRole('radio',{name:'Auto (follows playing)'}));
  expect(last().effects.wah.mode).toBe('auto');
  expect(screen.getByRole('slider',{name:'wah Pedal position'})).toHaveAttribute('aria-disabled','true');
  expect(screen.getByRole('slider',{name:'wah Sensitivity'})).not.toHaveAttribute('aria-disabled');
});

it('syncs a modulation pedal\'s rate to the tempo and switches off its free rate', async()=>{
  const {last}=mount();
  await choose('chorus');
  const rate=screen.getByRole('slider',{name:'chorus Rate (Hz)'});expect(rate).not.toHaveAttribute('aria-disabled');
  await act(async()=>{fireEvent.change(screen.getByRole('combobox',{name:'Chorus tempo sync'}),{target:{value:'1'}});});
  expect(last().effects.chorus.syncQuarterNotes).toBe(1);expect(rate).toHaveAttribute('aria-disabled','true');
  await act(async()=>{fireEvent.change(screen.getByRole('combobox',{name:'Chorus tempo sync'}),{target:{value:'0'}});});
  expect(last().effects.chorus).not.toHaveProperty('syncQuarterNotes');expect(rate).not.toHaveAttribute('aria-disabled');
});

it('draws the microphone\'s four placements as spots over the cabinet and changes the placement', async()=>{
  const {last}=mount();
  await choose('cabinet');
  const spots=screen.getByRole('radiogroup',{name:'Microphone placement'});
  expect(within(spots).getAllByRole('radio').map(radio=>radio.textContent)).toEqual(['Close','Standard','Edge','Room']);
  expect(within(spots).getByRole('radio',{name:'Standard'})).toBeChecked();
  await userEvent.click(within(spots).getByRole('radio',{name:'Edge'}));
  expect(last().effects.microphone.placement).toBe('edge');expect(within(spots).getByRole('radio',{name:'Edge'})).toBeChecked();
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Microphone output'})).getByRole('radio',{name:'Mono'}));expect(last().effects.microphone.output).toBe('mono');
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Cabinet model'})).getByRole('radio',{name:'Bass stack'}));expect(last().effects.cabinet.model).toBe('bassStack');
  expect(within(screen.getByRole('radiogroup',{name:'Cabinet model'})).getAllByRole('radio')).toHaveLength(5);
  await userEvent.click(screen.getByRole('switch',{name:'Enable microphone'}));expect(last().effects.microphone.enabled).toBe(true);
  expect(screen.getByRole('switch',{name:'Enable cabinet'})).toBeInTheDocument();
});

it('moves between the four placements with the arrow keys', async()=>{
  const {last}=mount();
  await choose('microphone');
  expect(screen.getByRole('tabpanel',{name:'Microphone'})).toBeInTheDocument();
  within(screen.getByRole('radiogroup',{name:'Microphone placement'})).getByRole('radio',{name:'Standard'}).focus();
  await userEvent.keyboard('{ArrowRight}');expect(last().effects.microphone.placement).toBe('edge');
  expect(screen.queryByRole('switch',{name:'Enable cabinet'})).toBeNull();
});

it('has ten faders for the graphic EQ and flattens them in one edit', async()=>{
  const sound=soundPreset('clean');sound.effects.graphicEq.enabled=true;sound.effects.graphicEq.gainsDb=[1,2,3,4,5,6,-1,-2,-3,-4];
  const {last,edits}=mount(sound);
  await choose('graphicEq');
  const group=screen.getByRole('group',{name:'Graphic EQ bands'});
  expect(within(group).getAllByRole('slider')).toHaveLength(10);
  const band=within(group).getByRole('slider',{name:'Graphic EQ 1k Hz (dB)'});
  expect(band).toHaveAttribute('aria-valuenow','6');expect(band).toHaveAttribute('aria-valuemin','-12');expect(band).toHaveAttribute('aria-valuemax','12');
  fireEvent.keyDown(band,{key:'ArrowUp'});
  expect(last().effects.graphicEq.gainsDb).toEqual([1,2,3,4,5,6.5,-1,-2,-3,-4].map((gain,index)=>index===5?6.5:gain));expect(edits).toHaveLength(1);
  fireEvent.keyDown(within(group).getByRole('slider',{name:'Graphic EQ 31 Hz (dB)'}),{key:'End'});expect(last().effects.graphicEq.gainsDb[0]).toBe(12);
  await userEvent.click(screen.getByRole('button',{name:'Flatten graphic EQ'}));
  expect(last().effects.graphicEq.gainsDb).toEqual(new Array(10).fill(0));expect(edits).toHaveLength(3);
  fireEvent.keyDown(screen.getByRole('slider',{name:'graphicEq Level (dB)'}),{key:'ArrowUp'});expect(last().effects.graphicEq.levelDb).toBe(.5);
});

it('records one edit for a fader drag', async()=>{
  const sound=soundPreset('clean');
  const {edits,last}=mount(sound);
  await choose('graphicEq');
  const band=screen.getByRole('slider',{name:'Graphic EQ 250 Hz (dB)'});
  band.getBoundingClientRect=()=>({top:0,left:0,right:36,bottom:134,height:134,width:36,x:0,y:0,toJSON:()=>({})});
  const thumb=band.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:67,pointerId:1});fireEvent.pointerMove(thumb,{clientY:50,pointerId:1});fireEvent.pointerMove(thumb,{clientY:37,pointerId:1});
  expect(edits).toHaveLength(0);fireEvent.pointerUp(thumb,{clientY:37,pointerId:1});
  expect(edits).toHaveLength(1);expect(last().effects.graphicEq.gainsDb[3]).toBe(6);
});

it('duplicates a pedal onto a second pedalboard, shows it after the chain and removes it again', async()=>{
  const {edits,last}=mount();
  await choose('drive');
  await userEvent.click(screen.getByRole('button',{name:'Duplicate pedal: Drive'}));
  expect(last().effects.second!.drive).toEqual({...soundPreset('lead').effects.drive,enabled:true});
  expect(screen.getByRole('status')).toHaveTextContent('Duplicated the Drive pedal onto the second pedalboard.');
  {const dup=screen.getByRole('button',{name:'Duplicate pedal: Drive'});expect(dup).toHaveAttribute('aria-disabled','true');expect(dup).not.toBeDisabled();expect(dup).toHaveFocus();await userEvent.click(dup);expect(edits.filter(edit=>edit.type==='setTrackSound')).toHaveLength(1);}
  const second=screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'});
  await userEvent.click(second);
  expect(screen.getByRole('tabpanel',{name:'Second pedalboard: Drive'})).toBeInTheDocument();
  // Its controls edit the second board only.
  fireEvent.keyDown(screen.getByRole('slider',{name:'Second pedalboard: drive Drive'}),{key:'ArrowUp'});
  expect(last().effects.second!.drive.drive).toBe(.51);expect(last().effects.drive.drive).toBe(.5);
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Second pedalboard: Drive model'})).getByRole('radio',{name:'Fuzz'}));
  expect(last().effects.second!.drive.model).toBe('fuzz');expect(last().effects.drive.model).toBe('overdrive');
  expect(screen.queryByRole('button',{name:/^Move Drive/})).toBeNull();
  await userEvent.click(screen.getByRole('button',{name:'Remove duplicate: Drive'}));
  expect(last().effects.second).toBeUndefined();
  // With the board gone, the first board's pedal is shown.
  expect(screen.getByRole('tabpanel',{name:'Drive'})).toBeInTheDocument();expect(screen.queryByRole('tab',{name:/Second pedalboard/})).toBeNull();
});

it('copies a pedal and pastes it on the same kind of pedal, and copies and pastes a whole sound', async()=>{
  const {last}=mount(soundPreset('lead','green-guitar'));
  await choose('amp');
  const paste=screen.getByRole('button',{name:'Paste pedal: Amp'});expect(paste).toHaveAttribute('aria-disabled','true');expect(paste).not.toBeDisabled();
  const source=soundPreset('crunch');source.effects.amp.drive=.9;
  copyPedal('amp',source.effects.amp);
  await userEvent.click(screen.getByRole('button',{name:'Copy pedal: Amp'}));
  expect(screen.getByRole('status')).toHaveTextContent('Copied the Amp pedal.');
  copyPedal('amp',source.effects.amp);
  await userEvent.click(screen.getByRole('button',{name:'Paste pedal: Amp'}));
  expect(last().effects.amp.drive).toBe(.9);
  await choose('gate');{const b=screen.getByRole('button',{name:'Paste pedal: Gate'});expect(b).toHaveAttribute('aria-disabled','true');expect(b).not.toBeDisabled();}
  {const b=screen.getByRole('button',{name:'Paste sound'});expect(b).toHaveAttribute('aria-disabled','true');expect(b).not.toBeDisabled();}
  await userEvent.click(screen.getByRole('button',{name:'Copy sound'}));
  expect(screen.getByRole('status')).toHaveTextContent('Copied this track’s sound.');
  copySound(soundPreset('bass'));
  await userEvent.click(screen.getByRole('button',{name:'Paste sound'}));
  expect(last().presetId).toBe('bass');
});

it('sets the sound source, applies presets and restores the preset, each as one edit', async()=>{
  const {last,edits}=mount(soundPreset('lead','green-guitar'));
  const sources=screen.getByRole('radiogroup',{name:'Sound source'});
  await userEvent.click(within(sources).getByRole('radio',{name:'Darkblack Bass'}));
  expect(last().voiceId).toBe('darkblack-bass');expect(last().presetId).toBe('lead');
  await userEvent.click(within(sources).getByRole('radio',{name:/^Automatic instrument/}));expect(last().voiceId).toBeNull();
  const presets=screen.getByRole('radiogroup',{name:'Sound preset'});
  expect(within(presets).getAllByRole('radio').map(radio=>radio.textContent)).toEqual(['Bypass','Clean','Crunch','Lead','Bass']);
  await userEvent.click(within(presets).getByRole('radio',{name:'Crunch'}));
  expect(last()).toEqual(soundPreset('crunch',null));
  fireEvent.keyDown(screen.getByRole('slider',{name:'amp Drive'}),{key:'ArrowUp'});
  await userEvent.click(screen.getByRole('button',{name:'Restore preset'}));
  expect(last()).toEqual(soundPreset('crunch',null));expect(edits).toHaveLength(5);
});

it('lists the audio outputs and selects one', async()=>{
  const {player}=mount();
  const output=await screen.findByRole('option',{name:'Studio speakers'});expect(output).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Audio output'}),{target:{value:'speakers'}});
  expect(player!.selectDevice).toHaveBeenCalledWith('speakers');
  fireEvent.change(screen.getByRole('combobox',{name:'Audio output'}),{target:{value:''}});expect(player!.selectDevice).toHaveBeenLastCalledWith(null);
});

it('shows an edit that fails and a playback error as alerts, and keeps the control at the sound', async()=>{
  const {player}=mount(soundPreset('lead'),{edit:async()=>{throw new Error('Preset could not be applied');}});
  await userEvent.click(screen.getByRole('button',{name:'Restore preset'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Preset could not be applied');
  act(()=>player!.fail('Output is unavailable'));
  expect(screen.getAllByRole('alert').map(alert=>alert.textContent)).toEqual(['Error: Preset could not be applied','Output is unavailable']);
});

it('disables every edit while busy but still lets the player look at any block', async()=>{
  const {edits}=mount(soundPreset('lead'),{busy:true});
  await choose('gate');
  expect(screen.getByRole('tabpanel',{name:'Gate'})).toBeVisible();
  expect(screen.getByRole('switch',{name:'Enable gate'})).toHaveAttribute('aria-disabled','true');
  expect(screen.getByRole('switch',{name:'Enable gate'})).not.toBeDisabled();
  expect(screen.getByRole('slider',{name:'gate Threshold (dB)'})).toHaveAttribute('aria-disabled','true');
  fireEvent.keyDown(screen.getByRole('slider',{name:'gate Threshold (dB)'}),{key:'ArrowUp'});
  for(const name of ['Restore preset','Copy pedal: Gate','Duplicate pedal: Gate']){const btn=screen.getByRole('button',{name});expect(btn).toHaveAttribute('aria-disabled','true');expect(btn).not.toBeDisabled();await userEvent.click(btn);}
  for(const radio of within(screen.getByRole('radiogroup',{name:'Sound source'})).getAllByRole('radio')){expect(radio).toHaveAttribute('aria-disabled','true');expect(radio).not.toBeDisabled();await userEvent.click(radio);}const output=screen.getByRole('combobox',{name:'Audio output'});expect(output).toHaveAttribute('aria-disabled','true');expect(output).not.toBeDisabled();fireEvent.change(output,{target:{value:'speakers'}});
  tab('gate').focus();await userEvent.keyboard(' ');
  expect(edits).toHaveLength(0);
});

it('keeps focus on source options across consecutive arrow edits while busy, and on footswitch across Space', async()=>{
  const user=userEvent.setup();
  const edits:Extract<EditCommand,{type:'setTrackSound'}>[]=[];
  function Host() {
    const [sound,setSound]=useState(soundPreset('lead')),[busy,setBusy]=useState(false);
    return <SoundRig trackId="guitar" sound={sound} tracks={[{id:'guitar',name:'Lead Guitar',program:29}]} onTrack={()=>{}} busy={busy}
      onEdit={async command=>{
        if(command.type==='setTrackSound'){
          edits.push(command);
          setBusy(true);
          setSound(command.sound);
          await Promise.resolve();
          setBusy(false);
        }
      }}/>;
  }
  render(<Host/>);
  const sources=within(screen.getByRole('radiogroup',{name:'Sound source'})).getAllByRole('radio');
  sources[0].focus();expect(sources[0]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(sources[1]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(sources[2]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(sources[3]).toHaveFocus();
  expect(edits.map(e=>e.sound.voiceId)).toEqual(['green-guitar','black-guitar','darkblack-bass']);
  const footswitch=screen.getByRole('switch',{name:/Enable amp/});
  footswitch.focus();expect(footswitch).toHaveFocus();
  await user.keyboard(' ');
  expect(footswitch).toHaveFocus();
});

it('keeps a clear place for the cabinet response and the master panel, and nothing there until they exist', async()=>{
  const first=mount();await choose('cabinet');
  expect(document.querySelector('[data-slot="cabinet-response"]')).toBeEmptyDOMElement();expect(document.querySelector('[data-slot="master"]')).toBeNull();
  first.view.unmount();
  mount(soundPreset('lead'),{cabinetResponse:()=><button>Load cabinet response</button>,master:<p>Master output</p>});await choose('cabinet');
  expect(within(document.querySelector<HTMLElement>('[data-slot="cabinet-response"]')!).getByRole('button',{name:'Load cabinet response'})).toBeInTheDocument();
  expect(within(document.querySelector<HTMLElement>('[data-slot="master"]')!).getByText('Master output')).toBeInTheDocument();
});

it('leaves a slot for the amp capture, empty until one is given',async()=>{
  const first=mount();await choose('amp');
  expect(document.querySelector('[data-slot="amp-capture"]')).toBeEmptyDOMElement();
  first.view.unmount();
  mount(soundPreset('lead'),{ampCapture:()=><button>Pick capture</button>});await choose('amp');
  expect(within(document.querySelector<HTMLElement>('[data-slot="amp-capture"]')!).getByRole('button',{name:'Pick capture'})).toBeInTheDocument();
});

it('changes the track the rig edits', async()=>{
  const {view}=mount();
  const strip=screen.getByRole('radiogroup',{name:'Track'});
  expect(within(strip).getAllByRole('radio').map(radio=>radio.getAttribute('aria-label'))).toEqual(['Lead Guitar','Bass','Drums','Piano']);
  expect(within(strip).getByRole('radio',{name:'Lead Guitar'})).toBeChecked();
  await userEvent.click(within(strip).getByRole('radio',{name:'Bass'}));
  expect(within(strip).getByRole('radio',{name:'Bass'})).toBeChecked();
  expect(view.container.querySelector('.sound-view')).toBeInTheDocument();
});

// The sound browser.
it('lists factory sounds by category and the player\'s own, and filters them by search', async()=>{
  saveSoundPreset('Practice tone',soundPreset('clean'));
  mount();
  const browser=screen.getByRole('complementary',{name:'Sound browser'});
  for(const group of ['Factory presets',...factoryCategories,'My sounds'])expect(within(browser).getByRole('region',{name:group})).toBeInTheDocument();
  for(const item of factorySounds)expect(within(browser).getByRole('button',{name:`Apply “${item.name}”`})).toBeInTheDocument();
  expect(within(browser).getByRole('button',{name:'Apply “Practice tone”'})).toBeInTheDocument();
  await userEvent.type(within(browser).getByRole('searchbox',{name:'Search sounds'}),'tremolo');
  expect(within(browser).getByRole('button',{name:'Apply “Surf tremolo”'})).toBeInTheDocument();
  expect(within(browser).queryByRole('button',{name:'Apply “Warm jazz clean”'})).toBeNull();
  expect(within(browser).queryByRole('region',{name:'My sounds'})).toBeNull();
  await userEvent.clear(within(browser).getByRole('searchbox'));await userEvent.type(within(browser).getByRole('searchbox'),'zzzz');
  expect(within(browser).getByText('No sounds match.')).toBeInTheDocument();
  await userEvent.clear(within(browser).getByRole('searchbox'));
  await userEvent.click(within(within(browser).getByRole('radiogroup',{name:'Show sounds'})).getByRole('radio',{name:'My sounds'}));
  expect(within(browser).getAllByRole('region').map(region=>region.getAttribute('aria-label'))).toEqual(['My sounds']);
  await userEvent.click(within(within(browser).getByRole('radiogroup',{name:'Show sounds'})).getByRole('radio',{name:'Factory'}));
  expect(within(browser).queryByRole('region',{name:'My sounds'})).toBeNull();expect(within(browser).getAllByRole('region').length).toBe(1+factoryCategories.length);
});

it('applies a factory sound, keeping the instrument, and a saved sound, as one edit each', async()=>{
  saveSoundPreset('Practice tone',soundPreset('clean'));
  const {last,edits}=mount(soundPreset('lead','green-guitar'));
  const item=factorySounds[0];
  expect(item).toBeDefined();
  await userEvent.click(screen.getByRole('button',{name:`Apply “${item.name}”`}));
  expect(last()).toEqual(factorySound(item.id,'green-guitar'));expect(edits).toHaveLength(1);
  expect(await screen.findByText(`Applied “${item.name}”.`)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'Apply “Practice tone”'}));
  expect(last()).toEqual(soundPreset('clean'));expect(screen.getByRole('status')).toHaveTextContent('Applied “Practice tone”.');
  await userEvent.click(screen.getByRole('button',{name:'Apply “Crunch”'}));
  // A saved sound is the whole sound, so it brought its own instrument; a factory preset keeps the one the track has.
  expect(last()).toEqual(soundPreset('crunch',null));
});

it('walks the list with the arrow keys, applies with Enter and hears with Space', async()=>{
  const user=userEvent.setup(),{edits,player}=mount();
  const rows=()=>[...document.querySelectorAll<HTMLButtonElement>('[data-row-main]')];
  expect(rows().filter(row=>row.tabIndex===0)).toHaveLength(1);
  rows()[0].focus();
  await user.keyboard('{ArrowDown}{ArrowDown}');expect(rows()[2]).toHaveFocus();
  await user.keyboard('{ArrowUp}');expect(rows()[1]).toHaveFocus();
  await user.keyboard('{End}');expect(rows().at(-1)).toHaveFocus();await user.keyboard('{Home}');expect(rows()[0]).toHaveFocus();
  await user.keyboard(' ');
  expect(player!.previewSound).toHaveBeenCalledWith('guitar',soundPreset('gm','green-guitar'));expect(edits).toHaveLength(0);
  await user.keyboard('{Enter}');
  expect(edits).toHaveLength(1);
});

it('previews with Hear without recording an edit, keeps or cancels, and ends on Escape', async()=>{
  saveSoundPreset('Wobble',soundPreset('crunch'));
  const own=soundPreset('clean','green-guitar'),{edits,player,last}=mount(own);
  await userEvent.click(screen.getByRole('button',{name:'Hear “Lead”'}));
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',soundPreset('lead','green-guitar'));
  const strip=await screen.findByRole('group',{name:'Sound preview'});
  expect(strip).toHaveTextContent('Previewing Lead');expect(screen.getByRole('status')).toHaveTextContent('Previewing Lead. Keep it or cancel to go back to this track’s sound.');
  expect(screen.getByRole('button',{name:'Hear “Lead”'})).toHaveAttribute('aria-pressed','true');
  expect(edits).toHaveLength(0);
  // Another sound replaces it.
  await userEvent.click(screen.getByRole('button',{name:'Hear “Wobble”'}));
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',soundPreset('crunch'));
  // Escape cancels and goes back to the track's sound.
  await userEvent.keyboard('{Escape}');
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',null);
  await waitForNoPreview();expect(screen.getByRole('status')).toHaveTextContent('Back to this track’s sound.');expect(edits).toHaveLength(0);
  // Keep records the previewed sound as one edit.
  await userEvent.click(screen.getByRole('button',{name:'Hear “Wobble”'}));
  await userEvent.click(await screen.findByRole('button',{name:'Keep previewed sound'}));
  expect(edits).toHaveLength(1);expect(last()).toEqual(soundPreset('crunch'));
  await waitForNoPreview();expect(screen.getByRole('status')).toHaveTextContent('Kept “Wobble”.');
  // Cancel goes back.
  await userEvent.click(screen.getByRole('button',{name:'Hear “Bass”'}));
  await userEvent.click(await screen.findByRole('button',{name:'Cancel preview'}));
  await waitForNoPreview();expect(edits).toHaveLength(1);
});
async function waitForNoPreview() {await act(async()=>{await Promise.resolve();});expect(screen.queryByRole('group',{name:'Sound preview'})).toBeNull();}

it('ends a preview when another edit is made, so the edit is what plays', async()=>{
  const {edits,player}=mount(soundPreset('lead'));
  await userEvent.click(screen.getByRole('button',{name:'Hear “Clean”'}));
  await screen.findByRole('group',{name:'Sound preview'});
  fireEvent.keyDown(screen.getByRole('slider',{name:'amp Drive'}),{key:'ArrowUp'});
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',null);expect(edits).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('Preview ended.');
});

it('has no Hear buttons where the host cannot preview', ()=>{
  mount(soundPreset('lead'),{player:null});
  expect(screen.queryByRole('button',{name:/^Hear/})).toBeNull();expect(screen.queryByRole('combobox',{name:'Audio output'})).toBeNull();
  expect(screen.getByRole('button',{name:'Apply “Clean”'})).toBeInTheDocument();
});

it('saves, renames and deletes saved sounds, with a confirmation before the delete', async()=>{
  const user=userEvent.setup(),{edits}=mount(soundPreset('lead'));
  const name=screen.getByRole('textbox',{name:'Saved sound name'}),save=screen.getByRole('button',{name:'Save sound'});
  expect(save).toHaveAttribute('aria-disabled','true');expect(save).not.toBeDisabled();expect(screen.queryByRole('button',{name:'Rename saved sound'})).toBeNull();
  await user.type(name,'Practice tone');await user.click(save);
  expect(screen.getByRole('status')).toHaveTextContent('Saved “Practice tone”.');expect(name).toHaveValue('');
  expect(screen.getByRole('button',{name:'Apply “Practice tone”'})).toBeInTheDocument();
  // Saving the same name replaces it.
  await user.type(name,'practice tone');await user.click(save);expect(screen.getByRole('status')).toHaveTextContent('Replaced “practice tone”.');
  // Rename.
  await user.click(screen.getByRole('button',{name:/^Rename saved sound “/}));
  expect(name).toHaveValue('practice tone');expect(name).toHaveFocus();
  await user.clear(name);await user.type(name,'Warm');await user.click(screen.getByRole('button',{name:'Rename saved sound'}));
  expect(screen.getByRole('status')).toHaveTextContent('Renamed “practice tone” to “Warm”.');
  expect(screen.getByRole('button',{name:'Apply “Warm”'})).toBeInTheDocument();
  // Delete asks first and Cancel keeps it.
  await user.click(screen.getByRole('button',{name:'Delete saved sound “Warm”'}));
  const dialog=screen.getByRole('dialog',{name:'Delete “Warm”?'});
  expect(within(dialog).getByRole('button',{name:'Cancel'})).toHaveFocus();
  await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('button',{name:'Apply “Warm”'})).toBeInTheDocument();
  // Escape closes it too, and Delete removes the sound.
  await user.click(screen.getByRole('button',{name:'Delete saved sound “Warm”'}));await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button',{name:'Delete saved sound “Warm”'}));
  await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete'}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('button',{name:'Apply “Warm”'})).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Deleted “Warm”.');
  // The library is not the track's sound: none of this was an edit.
  expect(edits).toHaveLength(0);
});

it('does not take Space or the arrows from a text field', async()=>{
  const user=userEvent.setup(),{edits}=mount();
  await user.type(screen.getByRole('searchbox',{name:'Search sounds'}),'a b');
  expect(screen.getByRole('searchbox')).toHaveValue('a b');expect(edits).toHaveLength(0);
});

// Hearing a drag.
const wait=(ms:number)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
it('plays the sound being dragged, at a limited rate, and records one edit when the drag ends', async()=>{
  const {edits,player,last}=mount(soundPreset('lead','green-guitar'));
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'}),previewed=()=>player!.previewSound.mock.calls.filter(call=>call[1]!==null);
  fireEvent.pointerDown(gain,{clientY:300,pointerId:1});
  fireEvent.pointerMove(gain,{clientY:290,pointerId:1});
  await act(async()=>{});
  // The first move is heard at once, on the track, as a copy of the whole sound with only that field changed.
  expect(previewed()).toHaveLength(1);
  const expected=structuredClone(soundPreset('lead','green-guitar'));expected.effects.amp.gainDb=3;
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',expected);
  // A burst of moves does not send one request each.
  for(const y of [285,280,275,270,265,260,255,250])fireEvent.pointerMove(gain,{clientY:y,pointerId:1});
  expect(previewed().length).toBeLessThanOrEqual(2);
  await wait(120);
  // The newest value is what ends up playing.
  expect((previewed().at(-1)![1] as TrackSound).effects.amp.gainDb).toBe(15);
  expect(edits).toHaveLength(0);expect(screen.queryByRole('group',{name:'Sound preview'})).toBeNull();
  fireEvent.pointerUp(gain,{clientY:250,pointerId:1});
  await act(async()=>{});
  expect(edits).toHaveLength(1);expect(last().effects.amp.gainDb).toBe(15);
  // The preview ends after the edit is recorded, and never goes back to the old sound in between.
  const calls=player!.previewSound.mock.calls.map(call=>call[1]===null?null:(call[1] as TrackSound).effects.amp.gainDb);
  expect(calls.at(-1)).toBeNull();expect(calls.filter(value=>value===0)).toHaveLength(0);
  expect(player!.soundPreview()).toBeNull();
});

it('puts the sound back and records nothing when Escape ends a drag', async()=>{
  const {edits,player}=mount(soundPreset('lead','green-guitar'));
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  fireEvent.pointerDown(gain,{clientY:300,pointerId:1});fireEvent.pointerMove(gain,{clientY:260,pointerId:1});
  await act(async()=>{});expect(player!.soundPreview()).not.toBeNull();
  fireEvent.keyDown(gain,{key:'Escape'});
  await wait(10);
  expect(player!.soundPreview()).toBeNull();expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',null);
  expect(gain).toHaveAttribute('aria-valuenow','0');
  fireEvent.pointerUp(gain,{clientY:260,pointerId:1});await act(async()=>{});
  expect(edits).toHaveLength(0);
});

it('ends a heard drag that finishes where it began, and when the view goes away', async()=>{
  const first=mount(soundPreset('lead','green-guitar')),gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  fireEvent.pointerDown(gain,{clientY:300,pointerId:1});fireEvent.pointerMove(gain,{clientY:260,pointerId:1});await act(async()=>{});
  fireEvent.pointerMove(gain,{clientY:300,pointerId:1});fireEvent.pointerUp(gain,{clientY:300,pointerId:1});await wait(100);
  expect(first.edits).toHaveLength(0);expect(first.player!.soundPreview()).toBeNull();
  first.view.unmount();
  const second=mount(soundPreset('lead','green-guitar')),other=screen.getByRole('slider',{name:'amp Gain (dB)'});
  fireEvent.pointerDown(other,{clientY:300,pointerId:1});fireEvent.pointerMove(other,{clientY:260,pointerId:1});await act(async()=>{});
  expect(second.player!.soundPreview()).not.toBeNull();
  second.view.unmount();await act(async()=>{});
  expect(second.player!.soundPreview()).toBeNull();
});

it('hears a graphic EQ fader drag the same way', async()=>{
  const {edits,player}=mount(soundPreset('clean'));
  await choose('graphicEq');
  const band=screen.getByRole('slider',{name:'Graphic EQ 1k Hz (dB)'});
  band.getBoundingClientRect=()=>({top:0,left:0,right:36,bottom:134,height:134,width:36,x:0,y:0,toJSON:()=>({})});
  const thumb=band.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:67,pointerId:1});fireEvent.pointerMove(thumb,{clientY:37,pointerId:1});await act(async()=>{});
  expect((player!.soundPreview()!.sound).effects.graphicEq.gainsDb[5]).toBe(6);expect(edits).toHaveLength(0);
  fireEvent.pointerUp(thumb,{clientY:37,pointerId:1});await act(async()=>{});await wait(10);
  expect(edits).toHaveLength(1);expect(player!.soundPreview()).toBeNull();
});

it('does not try to play a drag when the host cannot preview, and still records it', ()=>{
  const {edits}=mount(soundPreset('lead'),{player:null});
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  fireEvent.pointerDown(gain,{clientY:300,pointerId:1});fireEvent.pointerMove(gain,{clientY:260,pointerId:1});fireEvent.pointerUp(gain,{clientY:260,pointerId:1});
  expect(edits).toHaveLength(1);
});

// A drag belongs to the track, board and block it began on.
/** Like `mount`, but the player can hold its previews in flight, and the host can set the sound as an undo would. */
function mountHeld(sounds:Record<string,TrackSound>,hold=false) {
  const edits:Extract<EditCommand,{type:'setTrackSound'}>[]=[],held:(()=>void)[]=[];
  let preview:{track:string;sound:TrackSound}|null=null;const listeners=new Set<()=>void>();
  const player={
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},getState:()=>null,devices:vi.fn(async()=>[]),deviceId:()=>null,selectDevice:vi.fn(),soundPreview:()=>preview,
    previewSound:vi.fn(async(track:string,sound:TrackSound|null)=>{preview=sound?{track,sound:structuredClone(sound)}:(preview?.track===track?null:preview);listeners.forEach(listener=>listener());if(hold&&sound)await new Promise<void>(resolve=>held.push(resolve));}),
    release:()=>held.splice(0).forEach(resolve=>resolve()),
  };
  let setAll=(_:(old:Record<string,TrackSound>)=>Record<string,TrackSound>)=>{},goTo=(_:string)=>{};
  function Host() {
    const [all,set]=useState(sounds),[track,setTrack]=useState('guitar');setAll=set;goTo=setTrack;
    return <SoundRig trackId={track} sound={all[track]} playback={player as unknown as NativePlaybackController} tracks={[{id:'guitar',name:'Lead Guitar',program:29},{id:'bass',name:'Bass',program:33}]} onTrack={setTrack}
      onEdit={async command=>{if(command.type==='setTrackSound'){edits.push(command);set(old=>({...old,[command.trackId]:command.sound}));}}}/>;
  }
  render(<Host/>);
  return {edits,player,goTo:(id:string)=>act(()=>goTo(id)),setSounds:(next:(old:Record<string,TrackSound>)=>Record<string,TrackSound>)=>act(()=>setAll(next))};
}
const press=(user:ReturnType<typeof userEvent.setup>,target:HTMLElement,y=300)=>user.pointer([{keys:'[MouseLeft>]',target,coords:{clientY:y}},{target,coords:{clientY:y-40}}]);

it('ends a drag without an edit when the track changes under it, and the new track\'s sound is untouched', async()=>{
  const user=userEvent.setup(),{edits,player,goTo}=mountHeld({guitar:soundPreset('lead','green-guitar'),bass:soundPreset('bass','babyblue-bass')});
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  await press(user,gain);
  expect(player.soundPreview()?.track).toBe('guitar');
  // The track changes with the pointer still held and focus still on the knob, as an undo does.
  await goTo('bass');
  await wait(20);
  expect(player.soundPreview()).toBeNull();
  // Releasing now, on whatever the pointer is over, records nothing anywhere.
  const bassGain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  await user.pointer([{keys:'[/MouseLeft]',target:bassGain}]);await wait(20);
  expect(edits).toEqual([]);expect(bassGain).toHaveAttribute('aria-valuenow','0');
});

it('ends a drag without an edit when an undo removes the second pedalboard it was on', async()=>{
  const user=userEvent.setup(),first=soundPreset('lead','green-guitar'),withSecond=structuredClone(first);withSecond.effects.second=structuredClone(first.effects);withSecond.effects.second.drive.enabled=true;
  const {edits,player,setSounds}=mountHeld({guitar:withSecond,bass:soundPreset('bass')});
  await user.click(screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'}));
  const drive=screen.getByRole('slider',{name:'Second pedalboard: drive Drive'});
  await press(user,drive);
  expect(player.soundPreview()?.sound.effects.second?.drive.drive).toBeGreaterThan(.5);
  // An undo puts the sound back without the second board.
  await setSounds(old=>({...old,guitar:first}));await wait(20);
  expect(player.soundPreview()).toBeNull();
  // With the board gone, the first board's drive is shown, and the release lands on it harmlessly.
  expect(screen.getByRole('tabpanel',{name:'Drive'})).toBeInTheDocument();
  await user.pointer([{keys:'[/MouseLeft]',target:screen.getByRole('slider',{name:'drive Drive'})}]);await wait(20);
  expect(edits).toEqual([]);
});

it('keeps focus on surviving controls when removing a duplicate or turning off a second-board pedal', async()=>{
  const user=userEvent.setup();
  const first=soundPreset('lead','green-guitar'),withSecond=structuredClone(first);
  withSecond.effects.second=structuredClone(first.effects);
  withSecond.effects.second.drive.enabled=true;
  mountHeld({guitar:withSecond,bass:soundPreset('bass')});
  await user.click(screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'}));
  const removeButton=screen.getByRole('button',{name:'Remove duplicate: Drive'});
  removeButton.focus();expect(removeButton).toHaveFocus();
  await user.click(removeButton);
  const dupButton=screen.getByRole('button',{name:'Duplicate pedal: Drive'});
  expect(dupButton).toHaveFocus();
  await user.click(dupButton);
  await user.click(screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'}));
  const switchBtn=screen.getByRole('switch',{name:'Second pedalboard: Enable drive'});
  switchBtn.focus();expect(switchBtn).toHaveFocus();
  await user.keyboard(' ');
  const firstSwitch=screen.getByRole('switch',{name:'Enable drive'});
  expect(firstSwitch).toHaveFocus();
});

it('ends a drag without an edit when a block change replaces the knob it was on', async()=>{
  const user=userEvent.setup(),{edits,player}=mountHeld({guitar:soundPreset('lead','green-guitar'),bass:soundPreset('bass')});
  const gain=screen.getByRole('slider',{name:'amp Gain (dB)'});
  await press(user,gain);
  expect(player.soundPreview()).not.toBeNull();
  await user.click(screen.getByRole('tab',{name:/^Drive, /}));await wait(20);
  expect(player.soundPreview()).toBeNull();
  await user.pointer([{keys:'[/MouseLeft]',target:screen.getByRole('slider',{name:'drive Drive'})}]);await wait(20);
  expect(edits).toEqual([]);
});

it('never sends one track\'s sound to another track when a request is still in flight at a track change', async()=>{
  const user=userEvent.setup(),{player}=mountHeld({guitar:soundPreset('lead','green-guitar'),bass:soundPreset('bass','babyblue-bass')},true);
  await press(user,screen.getByRole('slider',{name:'amp Gain (dB)'}));
  // The guitar's request is still out when the track changes and a gesture starts on the bass.
  await user.click(within(screen.getByRole('radiogroup',{name:'Track'})).getByRole('radio',{name:'Bass'}));
  await press(user,screen.getByRole('slider',{name:'amp Gain (dB)'}),280);
  for(let i=0;i<4;i++){await act(async()=>{player.release();await Promise.resolve();});await wait(90);}
  const sent=player.previewSound.mock.calls.filter(call=>call[1]).map(call=>[call[0],(call[1] as TrackSound).presetId]);
  // Each request carries the sound of the track it is for.
  expect(sent.length).toBeGreaterThan(0);
  for(const [track,preset] of sent)expect([track,preset]).toEqual(track==='guitar'?['guitar','lead']:['bass','bass']);
  await user.pointer([{keys:'[/MouseLeft]'}]);for(let i=0;i<3;i++){await act(async()=>{player.release();await Promise.resolve();});await wait(30);}
  expect(player.soundPreview()?.track==='guitar').toBe(false);
});

// The instrument picker.
it('draws every source the engine has, and Automatic, as a radio group named Sound source', ()=>{
  mount(soundPreset('lead','green-guitar'));
  const group=screen.getByRole('radiogroup',{name:'Sound source'});
  const radios=within(group).getAllByRole('radio');
  expect(radios.map(radio=>radio.getAttribute('aria-label'))).toEqual(['Automatic instrument, plays as Black Guitar','Green Guitar','Black Guitar','Darkblack Bass','Babyblue Bass','General MIDI']);
  expect(within(group).getByRole('radio',{name:'Green Guitar'})).toBeChecked();
  // Each is a drawing, not a form control.
  for(const radio of radios)expect(radio.querySelector('svg')).not.toBeNull();
});

it('says what Automatic plays the track as, by the track\'s program, and changes with the track', async()=>{
  mount(soundPreset('lead',null) as TrackSound);
  const group=screen.getByRole('radiogroup',{name:'Sound source'});
  expect(within(group).getByRole('radio',{name:'Automatic instrument, plays as Black Guitar'})).toBeChecked();
  expect(group).toHaveTextContent('Auto→Black');
  const strip=screen.getByRole('radiogroup',{name:'Track'});
  await userEvent.click(within(strip).getByRole('radio',{name:'Bass'}));
  expect(within(group).getByRole('radio',{name:'Automatic instrument, plays as Babyblue Bass'})).toBeInTheDocument();
  await userEvent.click(within(strip).getByRole('radio',{name:'Drums'}));
  // A drum track plays the recorded kit, unless the rig chose one of the sound bank's own kits.
  expect(within(group).getByRole('radio',{name:'Automatic instrument, plays as the recorded drum kit'})).toBeInTheDocument();
  expect(group).toHaveTextContent('Auto→Kit');
});

it('moves between sources with the arrow keys and chooses each as one edit', async()=>{
  const user=userEvent.setup(),{edits,last}=mount(soundPreset('lead','green-guitar'));
  const group=screen.getByRole('radiogroup',{name:'Sound source'});
  within(group).getByRole('radio',{name:'Green Guitar'}).focus();
  await user.keyboard('{ArrowRight}');
  expect(within(group).getByRole('radio',{name:'Black Guitar'})).toHaveFocus();expect(last().voiceId).toBe('black-guitar');
  await user.keyboard('{End}');expect(last().voiceId).toBe('gm');expect(edits).toHaveLength(2);
  expect(within(group).getAllByRole('radio').filter(radio=>radio.tabIndex===0)).toHaveLength(1);
});

it('previews a source with Hear without recording an edit, and keeps it or cancels', async()=>{
  const {edits,player,last}=mount(soundPreset('lead','green-guitar'));
  const babyblueHear=screen.getByRole('button',{name:'Hear Babyblue Bass'});
  await userEvent.click(babyblueHear);
  expect(player!.previewSound).toHaveBeenLastCalledWith('guitar',{...soundPreset('lead','green-guitar'),voiceId:'babyblue-bass'});
  expect(edits).toHaveLength(0);
  expect(await screen.findByRole('group',{name:'Sound preview'})).toHaveTextContent('Previewing Babyblue Bass');
  expect(babyblueHear).toHaveAttribute('aria-pressed','true');
  await userEvent.click(screen.getByRole('button',{name:'Keep previewed sound'}));
  expect(edits).toHaveLength(1);expect(last().voiceId).toBe('babyblue-bass');
});

it('gives each source option its own audition button in the same row without hover layout shifts', async()=>{
  const user=userEvent.setup();
  const {player}=mountHeld({guitar:soundPreset('lead','green-guitar'),bass:soundPreset('bass','babyblue-bass')});
  const greenHear=screen.getByRole('button',{name:'Hear Green Guitar'});
  const blackHear=screen.getByRole('button',{name:'Hear Black Guitar'});
  expect(greenHear).toBeVisible();
  expect(blackHear).toBeVisible();
  greenHear.focus();
  expect(greenHear).toHaveFocus();
  await user.keyboard(' ');
  expect(player.previewSound).toHaveBeenLastCalledWith('guitar',expect.objectContaining({voiceId:'green-guitar'}));
  const strip=screen.getByRole('radiogroup',{name:'Track'});
  await user.click(within(strip).getByRole('radio',{name:'Bass'}));
  const bassHear=screen.getByRole('button',{name:'Hear Babyblue Bass'});
  expect(bassHear).toBeVisible();
  await user.click(bassHear);
  expect(player.previewSound).toHaveBeenLastCalledWith('bass',expect.objectContaining({voiceId:'babyblue-bass'}));
});

/** The rig over a sound it keeps, with `busy` held by the test. With `park`, a sound edit sets busy and waits for `release()`, as the app does while it commits. */
function mountBusyable(initial:TrackSound=soundPreset('lead','green-guitar'),{park=false,player=playback()}:{park?:boolean;player?:Fake}={}) {
  const edits:EditCommand[]=[];let setBusyOuter!:(busy:boolean)=>void,release!:()=>void,gate:Promise<void>=Promise.resolve();
  if(park)gate=new Promise<void>(resolve=>{release=resolve;});
  function Host() {
    const [sound,setSound]=useState(initial),[busy,setBusy]=useState(false);setBusyOuter=setBusy;
    return <SoundRig trackId="guitar" sound={sound} busy={busy} playback={player as unknown as NativePlaybackController}
      tracks={[{id:'guitar',name:'Lead Guitar',program:29}]} onTrack={()=>{}}
      onEdit={async command=>{
        edits.push(command);
        if(command.type!=='setTrackSound')return;
        if(park){setBusy(true);await gate;}
        setSound(command.sound);if(park)setBusy(false);
      }}/>;
  }
  render(<Host/>);
  return {edits,player,holdBusy:(busy:boolean)=>act(()=>setBusyOuter(busy)),release:()=>act(async()=>{release();await gate;})};
}

it('keeps focus on Remove duplicate while busy and hands off focus to Duplicate pedal after removal', async()=>{
  const user=userEvent.setup();
  const first=soundPreset('lead','green-guitar'),withSecond=structuredClone(first);
  withSecond.effects.second=structuredClone(first.effects);
  withSecond.effects.second.drive.enabled=true;
  const {edits,release}=mountBusyable(withSecond,{park:true});
  await user.click(screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'}));
  const removeButton=screen.getByRole('button',{name:'Remove duplicate: Drive'});
  removeButton.focus();
  expect(removeButton).toHaveFocus();
  await user.click(removeButton);
  // The edit is held, so busy stays true until released: no sleep or timer is involved.
  await waitFor(()=>expect(removeButton).toHaveAttribute('aria-disabled','true'));
  expect(edits).toHaveLength(1);
  expect(removeButton).not.toBeDisabled();
  expect(removeButton).toHaveFocus();
  await release();
  const dupButton=await screen.findByRole('button',{name:'Duplicate pedal: Drive'});
  expect(dupButton).toHaveFocus();
  expect(document.activeElement).not.toBe(document.body);
});

it('keeps Duplicate pedal, Save sound and Rename saved sound focusable, and refuses their press while busy', async()=>{
  const user=userEvent.setup(),{edits,holdBusy}=mountBusyable();
  await choose('drive');
  const dup=screen.getByRole('button',{name:'Duplicate pedal: Drive'});
  await holdBusy(true);
  expect(dup).toHaveAttribute('aria-disabled','true');expect(dup).not.toBeDisabled();
  await user.click(dup);expect(edits).toHaveLength(0);
  await holdBusy(false);expect(dup).not.toHaveAttribute('aria-disabled');
  await user.click(dup);expect(edits).toHaveLength(1);
  // Unavailable now that a second board holds it, the button keeps the focus the press gave it.
  expect(dup).toHaveAttribute('aria-disabled','true');expect(dup).not.toBeDisabled();expect(dup).toHaveFocus();

  const name=screen.getByRole('textbox',{name:'Saved sound name'}),save=screen.getByRole('button',{name:'Save sound'});
  await user.type(name,'Tone');expect(save).not.toHaveAttribute('aria-disabled');
  await holdBusy(true);
  expect(save).toHaveAttribute('aria-disabled','true');expect(save).not.toBeDisabled();
  await user.click(save);expect(screen.queryByRole('button',{name:'Apply “Tone”'})).toBeNull();
  await holdBusy(false);await user.click(save);
  expect(screen.getByRole('button',{name:'Apply “Tone”'})).toBeInTheDocument();
  expect(save).toHaveAttribute('aria-disabled','true');expect(save).not.toBeDisabled();expect(save).toHaveFocus();

  const rename=screen.getByRole('button',{name:'Rename saved sound'});
  await user.type(name,'Tune');expect(rename).not.toHaveAttribute('aria-disabled');
  await holdBusy(true);
  expect(rename).toHaveAttribute('aria-disabled','true');expect(rename).not.toBeDisabled();
  await user.click(rename);expect(screen.queryByRole('button',{name:'Apply “Tune”'})).toBeNull();
  await holdBusy(false);await user.click(rename);
  expect(screen.getByRole('button',{name:'Apply “Tune”'})).toBeInTheDocument();
  expect(rename).toHaveAttribute('aria-disabled','true');expect(rename).not.toBeDisabled();expect(rename).toHaveFocus();
});

it('records one edit when Keep previewed sound is pressed twice, and none while busy', async()=>{
  const user=userEvent.setup(),{edits,player,holdBusy,release}=mountBusyable(soundPreset('clean','green-guitar'),{park:true});
  await user.click(screen.getByRole('button',{name:'Hear “Lead”'}));
  const keep=await screen.findByRole('button',{name:'Keep previewed sound'});
  await holdBusy(true);
  expect(keep).toHaveAttribute('aria-disabled','true');expect(keep).not.toBeDisabled();
  await user.click(keep);expect(edits).toHaveLength(0);expect(player.soundPreview()).not.toBeNull();
  await holdBusy(false);
  await user.click(keep);await user.click(keep);
  expect(edits).toHaveLength(1);
  await release();
  expect(edits).toHaveLength(1);
});

it('returns focus to the Hear button that started a preview after Keep, Cancel and Escape', async()=>{
  const user=userEvent.setup(),{edits}=mount(soundPreset('clean','green-guitar'));
  const hearBlack=screen.getByRole('button',{name:'Hear Black Guitar'});
  await user.click(hearBlack);
  await user.click(await screen.findByRole('button',{name:'Keep previewed sound'}));
  await waitForNoPreview();expect(edits).toHaveLength(1);expect(hearBlack).toHaveFocus();
  const hearGreen=screen.getByRole('button',{name:'Hear Green Guitar'});
  await user.click(hearGreen);
  await user.click(await screen.findByRole('button',{name:'Cancel preview'}));
  await waitForNoPreview();expect(hearGreen).toHaveFocus();
  await user.click(hearBlack);await screen.findByRole('group',{name:'Sound preview'});
  await user.keyboard('{Escape}');
  await waitForNoPreview();expect(hearBlack).toHaveFocus();expect(edits).toHaveLength(1);
});

it('falls back to the checked source when the Hear button that started a preview is gone', async()=>{
  const user=userEvent.setup(),{edits}=mount(soundPreset('clean','green-guitar'));
  await user.click(screen.getByRole('button',{name:'Hear “Lead”'}));
  await screen.findByRole('group',{name:'Sound preview'});
  await user.type(screen.getByRole('searchbox',{name:'Search sounds'}),'zzzz');
  expect(screen.queryByRole('button',{name:'Hear “Lead”'})).toBeNull();
  await user.click(screen.getByRole('button',{name:'Cancel preview'}));
  await waitForNoPreview();
  const checked=within(screen.getByRole('radiogroup',{name:'Sound source'})).getByRole('radio',{checked:true});
  expect(checked).toHaveFocus();expect(edits).toHaveLength(0);
  // The browser rows are not where focus lands.
  expect(document.activeElement?.hasAttribute('data-row-main')).toBe(false);
});

for(const how of ['Keep','Cancel','Escape'] as const) it(`falls back to the checked source when ${how} ends a preview begun in a browser that has since been hidden`, async()=>{
  const user=userEvent.setup(),{edits}=mount(soundPreset('clean','green-guitar'));
  const hear=screen.getByRole('button',{name:'Hear “Lead”'});
  await user.click(hear);
  await screen.findByRole('group',{name:'Sound preview'});
  // Below 1100px the browser is closed again with Sounds; its rows are still in the page but cannot take focus.
  const hidden=document.createElement('style');hidden.textContent='.rig-browser{display:none}';document.head.append(hidden);
  try {
    if(how==='Keep')await user.click(screen.getByRole('button',{name:'Keep previewed sound'}));
    else if(how==='Cancel')await user.click(screen.getByRole('button',{name:'Cancel preview'}));
    else{screen.getByRole('radio',{name:'Green Guitar',checked:true}).focus();await user.keyboard('{Escape}');}
    await waitForNoPreview();
    expect(hear.isConnected).toBe(true);
    expect(within(screen.getByRole('radiogroup',{name:'Sound source'})).getByRole('radio',{checked:true})).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(edits).toHaveLength(how==='Keep'?1:0);
  } finally {hidden.remove();}
});

it('hands focus to the first board\'s Paste pedal when a paste leaves the second board with no pedal on', async()=>{
  const user=userEvent.setup();mount(soundPreset('lead','green-guitar'));
  await choose('drive');
  await user.click(screen.getByRole('button',{name:'Duplicate pedal: Drive'}));
  await user.click(screen.getByRole('tab',{name:'Second pedalboard: Drive, enabled'}));
  copyPedal('drive',{...soundPreset('lead').effects.drive,enabled:false});
  const paste=screen.getByRole('button',{name:'Second pedalboard: Paste pedal: Drive'});
  expect(paste).not.toBeDisabled();
  await user.click(paste);
  expect(screen.queryByRole('tab',{name:/Second pedalboard/})).toBeNull();
  const first=screen.getByRole('button',{name:'Paste pedal: Drive'});
  expect(first).toHaveFocus();
});

it('keeps Move earlier, Move later, Paste pedal and Paste sound focusable and refuses them while unavailable or busy', async()=>{
  const user=userEvent.setup(),{edits,holdBusy}=mountBusyable();
  await choose('microphone');
  const earlier=screen.getByRole('button',{name:'Move Microphone earlier'}),later=screen.getByRole('button',{name:'Move Microphone later'});
  expect(earlier).toHaveAttribute('aria-disabled','true');expect(earlier).not.toBeDisabled();
  earlier.focus();await user.click(earlier);expect(edits).toHaveLength(0);expect(earlier).toHaveFocus();
  await user.click(later);expect(edits).toHaveLength(1);
  await holdBusy(true);await user.click(later);expect(edits).toHaveLength(1);await holdBusy(false);
  // The clipboard holds a Drive pedal, so Paste pedal on the Microphone has nothing to paste; Paste sound is covered with the copy and paste test.
  copyPedal('drive',soundPreset('lead').effects.drive);
  const pastePedal=await screen.findByRole('button',{name:'Paste pedal: Microphone'});
  expect(pastePedal).toHaveAttribute('aria-disabled','true');expect(pastePedal).not.toBeDisabled();await user.click(pastePedal);
  expect(edits).toHaveLength(1);
});

it('lays the preview strip out whether or not a preview runs, so starting one moves nothing', async()=>{
  const user=userEvent.setup();mount(soundPreset('clean','green-guitar'));
  const strip=document.querySelector<HTMLElement>('.rig-preview')!;
  expect(strip).not.toBeNull();expect(strip.style.visibility).toBe('hidden');expect(strip.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('button',{name:'Keep previewed sound'})).toBeNull();
  await user.click(screen.getByRole('button',{name:'Hear Black Guitar'}));
  await screen.findByRole('group',{name:'Sound preview'});
  expect(document.querySelector('.rig-preview')).toBe(strip);expect(strip.style.visibility).toBe('visible');expect(strip.hasAttribute('inert')).toBe(false);
});

it('puts the Hear buttons beside the source radios, not inside them, and the sources and presets in one wrapping row', ()=>{
  mount();
  const radios=screen.getByRole('radiogroup',{name:'Sound source'});
  expect(within(radios).getAllByRole('radio')).toHaveLength(6);expect(within(radios).queryAllByRole('button')).toHaveLength(0);
  const hears=screen.getByRole('group',{name:'Hear a source'});
  expect(within(hears).getAllByRole('button')).toHaveLength(6);expect(hears.contains(radios)).toBe(false);
  // Sources and presets are both in the header row, which wraps; neither is positioned out of the flow.
  const head=document.querySelector<HTMLElement>('.rig-head')!,presets=screen.getByRole('radiogroup',{name:'Sound preset'});
  const picker=radios.closest<HTMLElement>('.rig-source-picker')!;
  expect(picker.parentElement).toBe(head);expect(presets.parentElement).toBe(head);expect(picker.nextElementSibling).toBe(presets);
  const css=readFileSync(resolve(process.cwd(),'src/rig/rig.css'),'utf8');
  const rules=(selector:string)=>[...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(match=>match[1].split(',').some(part=>part.trim().endsWith(selector))).map(match=>match[2]).join(';');
  expect(rules('.rig-head').split(';').filter(rule=>rule.includes('flex-wrap')).at(-1)).toMatch(/flex-wrap:\s*wrap/);
  expect(rules('.rig-head>*')).toMatch(/min-width:\s*0/);expect(rules('.rig-presets')).toMatch(/min-width:\s*0/);expect(rules('.rig-source-picker')).toMatch(/max-width:\s*100%/);
  for(const selector of ['.rig-head','.rig-source-picker','.rig-presets','.rig-sources','.rig-hears'])expect(rules(selector)).not.toMatch(/position:\s*(absolute|fixed)|margin[a-z-]*:\s*-/);
  // A short window drops the drawings for text and keeps the foot on one line.
  expect(css).toMatch(/@media \(max-height:700px\)[\s\S]*\.rig-source-art[^}]*display:none/);
  expect(css).toMatch(/@container \(min-width:1100px\)\s*\{\s*@media \(max-height:700px\)[\s\S]*\.rig-messages\s*\{\s*flex-wrap:nowrap/);
  // The real proof that nothing overlaps at rig widths is a browser measurement, recorded in docs/validation.
});

it('has no Hear for sources where the host cannot preview', ()=>{
  mount(soundPreset('lead'),{player:null});
  expect(screen.queryByRole('button',{name:/^Hear /})).toBeNull();
});

it('leaves the chain footswitch undimmed by the shared aria-disabled dimming while busy', () => {
  const css = readFileSync(resolve(__dirname, '../ui/ui.css'), 'utf8');
  const rule = css.split('\n').find(line => line.startsWith(':is(button,select,summary)'))!;
  expect(rule).toContain(':not(.rig-footswitch)[aria-disabled=true]');
  expect(rule).toContain('button.is-disabled:not(.rig-footswitch)');
  expect(readFileSync(resolve(__dirname, 'rig.css'), 'utf8')).not.toMatch(/\.rig-footswitch[^{]*\{[^}]*opacity/);
});

it('puts the sound lock in the head, and one click or Space records one undoable edit', async()=>{
  const {edits,last}=mount(soundPreset('lead','green-guitar'));
  const lock=within(document.querySelector('.rig-head') as HTMLElement).getByRole('checkbox',{name:'Lock sound against automations'});
  expect(lock).not.toBeChecked();
  await userEvent.click(lock);
  expect(edits).toHaveLength(1);expect(last()).toEqual({...soundPreset('lead','green-guitar'),locked:true});
  expect(lock).toBeChecked();
  lock.focus();await userEvent.keyboard(' ');
  expect(edits).toHaveLength(2);expect(last()).toEqual(soundPreset('lead','green-guitar'));expect(last()).not.toHaveProperty('locked');
  expect(lock).not.toBeChecked();
});

it('keeps the track locked through a preset and a source change made in the rig', async()=>{
  const {last}=mount({...soundPreset('lead','green-guitar'),locked:true});
  await userEvent.click(within(screen.getByRole('radiogroup',{name:'Sound preset'})).getByRole('radio',{name:'Crunch'}));
  expect(last()).toEqual({...soundPreset('crunch','green-guitar'),locked:true});
  await userEvent.click(screen.getByRole('button',{name:'Restore preset'}));
  expect(last()).toEqual({...soundPreset('crunch','green-guitar'),locked:true});
});

it('refuses the lock while busy, keeps it focusable and records nothing', async()=>{
  const {edits}=mount(soundPreset('lead','green-guitar'),{busy:true});
  const lock=screen.getByRole('checkbox',{name:'Lock sound against automations'});
  expect(lock).toHaveAttribute('aria-disabled','true');expect(lock).not.toBeDisabled();
  lock.focus();expect(lock).toHaveFocus();
  await userEvent.click(lock);await userEvent.keyboard(' ');
  expect(edits).toHaveLength(0);expect(lock).not.toBeChecked();expect(lock).toHaveFocus();
});

it('keeps focus on the lock across the busy flicker its own edit causes', async()=>{
  const user=userEvent.setup(),edits:Extract<EditCommand,{type:'setTrackSound'}>[]=[];
  function Host() {
    const [sound,setSound]=useState(soundPreset('lead')),[busy,setBusy]=useState(false);
    return <SoundRig trackId="guitar" sound={sound} tracks={[{id:'guitar',name:'Lead Guitar',program:29}]} onTrack={()=>{}} busy={busy}
      onEdit={async command=>{if(command.type==='setTrackSound'){edits.push(command);setBusy(true);setSound(command.sound);await Promise.resolve();setBusy(false);}}}/>;
  }
  render(<Host/>);
  const lock=screen.getByRole('checkbox',{name:'Lock sound against automations'});
  lock.focus();await user.keyboard(' ');
  expect(lock).toHaveFocus();expect(lock).toBeChecked();
  await user.keyboard(' ');
  expect(lock).toHaveFocus();expect(lock).not.toBeChecked();
  expect(edits.map(edit=>!!edit.sound.locked)).toEqual([true,false]);
});
