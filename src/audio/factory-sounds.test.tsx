// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {factoryCategories,factorySound,factorySounds} from './factory-sounds';
import {defaultEffects,effectBlocks,soundProblem} from '../document-settings';
import type {NativePlaybackController} from './NativePlaybackController';
import type {TrackSound} from '../edit-types';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
afterEach(()=>{cleanup();localStorage.clear();});

it('covers every kind of playing with several distinct, valid sounds',()=>{
  expect(new Set(factorySounds.map(sound=>sound.id)).size).toBe(factorySounds.length);
  expect(new Set(factorySounds.map(sound=>sound.name)).size).toBe(factorySounds.length);
  for(const category of factoryCategories)expect(factorySounds.filter(sound=>sound.category===category).length,category).toBeGreaterThanOrEqual(2);
  const chains=new Set<string>();
  for(const entry of factorySounds){
    const sound=factorySound(entry.id,'green-guitar');
    expect(sound,entry.id).not.toBeNull();
    expect(soundProblem(sound!),entry.id).toBeNull();
    expect(sound!.voiceId).toBe('green-guitar');
    expect(sound!.presetId).toBe(entry.presetId);
    expect(entry.description.length,entry.id).toBeGreaterThan(10);
    // No two factory sounds are the same chain, and none is just its preset.
    const chain=JSON.stringify(sound!.effects);
    expect(chains.has(chain),entry.id).toBe(false);chains.add(chain);
    expect(chain,entry.id).not.toBe(JSON.stringify(soundPreset(entry.presetId).effects));
  }
  expect(factorySound('missing')).toBeNull();
});

it('starts each block from its defaults and switches on only the blocks it names',()=>{
  const sound=factorySound('chorus-clean')!,defaults=defaultEffects();
  expect(sound.effects.chorus).toEqual({...defaults.chorus,enabled:true,rateHz:.8,depthMs:6,mix:.35});
  const enabled=effectBlocks.filter(block=>sound.effects[block].enabled);
  expect(enabled.sort()).toEqual(['amp','cabinet','chorus','compressor','delay','reverb']);
  expect(sound.effects.order).toBeUndefined();
  // Each call gives a fresh sound.
  sound.effects.chorus.mix=1;expect(factorySound('chorus-clean')!.effects.chorus.mix).toBe(.35);
});

it('applies a factory sound as one undoable edit that keeps the track voice',async()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('clean','black-guitar')} onEdit={onEdit}/>);
  const select=screen.getByLabelText('Factory sound');
  expect([...select.querySelectorAll('optgroup')].map(group=>group.label)).toEqual([...factoryCategories]);
  expect(screen.getByRole('button',{name:'Apply factory sound'})).toBeDisabled();
  fireEvent.change(select,{target:{value:'metal-rhythm'}});
  expect(select).toHaveAccessibleDescription('Tight, gated high gain with scooped mids. Factory sounds set the effects; the track keeps its instrument.');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Apply factory sound'}));});
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0]).toEqual({type:'setTrackSound',trackId:'base/0',sound:factorySound('metal-rhythm','black-guitar')});
  expect(screen.getByRole('status')).toHaveTextContent('Applied “Metal rhythm”.');
});

it('clears the factory sound choice on another track',()=>{
  const {rerender}=render(<SoundPanel trackId="base/0" sound={soundPreset('clean')} onEdit={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Factory sound'),{target:{value:'surf-tremolo'}});
  rerender(<SoundPanel trackId="base/1" sound={soundPreset('bass')} onEdit={vi.fn()}/>);
  expect(screen.getByLabelText('Factory sound')).toHaveValue('');
  expect(screen.getByRole('button',{name:'Apply factory sound'})).toBeDisabled();
});

it('previews factory sounds beside the presets and saved sounds',async()=>{
  let preview:{track:string;sound:TrackSound}|null=null;const state={};
  const fake={subscribe:()=>()=>{},getState:()=>state,devices:async()=>[],deviceId:()=>null,selectDevice:vi.fn(),soundPreview:()=>preview,
    previewSound:vi.fn(async(track:string,sound:TrackSound|null)=>{preview=sound?{track,sound}:null;})};
  const onEdit=vi.fn();
  render(<SoundPanel trackId="base/0" sound={soundPreset('bass','babyblue-bass')} onEdit={onEdit} playback={fake as unknown as NativePlaybackController}/>);
  const select=screen.getByLabelText('Preview sound');
  expect([...select.querySelectorAll('optgroup')].map(group=>group.label)).toEqual(['Factory presets',...factoryCategories.map(category=>`${category} sounds`)]);
  await act(async()=>{fireEvent.change(select,{target:{value:'factory:slap-bass'}});});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',factorySound('slap-bass','babyblue-bass'));
  expect(screen.getByRole('status')).toHaveTextContent('Previewing “Slap bass”.');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Keep previewed sound'}));});
  expect(onEdit.mock.calls[0][0]).toEqual({type:'setTrackSound',trackId:'base/0',sound:factorySound('slap-bass','babyblue-bass')});
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('matches the catalog the native tests play',()=>{
  // UPDATE_FACTORY_SOUNDS=1 rewrites the catalog after a factory sound changes.
  const catalog=factorySounds.map(entry=>({id:entry.id,presetId:entry.presetId,effects:factorySound(entry.id)!.effects}));
  const file=resolve(__dirname,'../../tests/factory-sounds.json');
  if(process.env.UPDATE_FACTORY_SOUNDS)writeFileSync(file,`[\n${catalog.map(entry=>JSON.stringify(entry)).join(',\n')}\n]\n`);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(catalog);
});

it('applies a factory sound keeping the track plug-in',async()=>{
  const onEdit=vi.fn();
  const plug={format:'vst3' as const,classId:'A'.repeat(32),name:'Amp',vendor:'Vendor',active:true,inputDb:0,outputDb:0,state:'s'.repeat(64)};
  const soundWithPlugin={...soundPreset('clean','black-guitar'),plugin:plug};
  render(<SoundPanel trackId="base/0" sound={soundWithPlugin} onEdit={onEdit}/>);
  const select=screen.getByLabelText('Factory sound');
  fireEvent.change(select,{target:{value:'metal-rhythm'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Apply factory sound'}));});
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0].sound.plugin).toEqual(plug);
});

it('marks Drive, Amp and Cabinet as replaced in the inspector chain when the plug-in is active',()=>{
  const plug={format:'vst3' as const,classId:'A'.repeat(32),name:'Amp',vendor:'Vendor',active:true,inputDb:0,outputDb:0,state:'s'.repeat(64)};
  const {container,rerender}=render(<SoundPanel trackId="base/0" sound={{...soundPreset('clean','black-guitar'),plugin:plug}} onEdit={vi.fn()}/>);
  const states=(root:HTMLElement)=>[...root.querySelectorAll('.sound-chain>details.sound-block')].filter(block=>/Replaced/.test(block.querySelector('summary')!.textContent??'')).map(block=>block.querySelector('.sound-block-name')!.textContent);
  expect(states(container).sort()).toEqual(['Amp','Cabinet','Drive']);
  rerender(<SoundPanel trackId="base/0" sound={{...soundPreset('clean','black-guitar'),plugin:{...plug,active:false}}} onEdit={vi.fn()}/>);
  expect(states(container)).toEqual([]);
});
