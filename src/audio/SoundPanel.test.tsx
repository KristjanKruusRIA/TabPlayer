// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SoundPanel, soundPreset } from './SoundPanel';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge } from './bridge';

const players:NativePlaybackController[]=[];
afterEach(()=>{cleanup();for(const player of players)player.destroy();players.length=0;});
function nativePlayer() {
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[{id:'speakers',name:'Studio speakers',isDefault:false}]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const player=new NativePlaybackController({bridge,onEdit:()=>{}});players.push(player);return {bridge,player};
}

it('reports the real state of the eight fixed blocks and opens their controls without changing sound',()=>{
  const sound=soundPreset('lead'),onEdit=vi.fn();render(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit}/>);
  for(const [name,status] of [['Gate','Bypassed'],['Compressor','Bypassed'],['Amp','Enabled'],['Cabinet','Enabled'],['EQ','Bypassed'],['Chorus','Bypassed'],['Delay','Enabled'],['Reverb','Enabled']]) {
    const summary=screen.getByText(name,{exact:true}).closest('summary')!;
    expect(summary).toHaveTextContent(status);fireEvent.click(summary);
    expect(within(summary.parentElement!).getByRole('checkbox')).toBeVisible();
    fireEvent.click(summary);
  }
  expect(onEdit).not.toHaveBeenCalled();
});

it('changes one actual parameter while preserving the complete chain and source settings',()=>{
  const sound=soundPreset('lead','green-guitar'),onEdit=vi.fn();render(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit}/>);
  fireEvent.click(screen.getByText('Amp',{exact:true}));
  fireEvent.change(screen.getByLabelText('amp Gain (dB)'),{target:{value:'4.5'}});
  const expected=structuredClone(sound);expected.effects.amp.gainDb=4.5;
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({type:'setTrackSound',trackId:'guitar',sound:expected});
  expect(sound.effects.amp.gainDb).toBe(0);
  fireEvent.change(screen.getByLabelText('amp Gain (dB)'),{target:{value:'25'}});
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('allows busy rack inspection while disabling sound and output changes',async()=>{
  const {player,bridge}=nativePlayer(),onEdit=vi.fn();render(<SoundPanel trackId="guitar" onEdit={onEdit} playback={player} busy/>);
  await screen.findByRole('option',{name:'Studio speakers'});
  fireEvent.click(screen.getByText('Gate',{exact:true}));
  expect(screen.getByLabelText('Enable gate')).toBeVisible();
  for(const label of ['Sound source','Sound preset','gate Threshold (dB)','Enable gate','Audio output'])expect(screen.getByLabelText(label)).toBeDisabled();
  expect(screen.getByRole('button',{name:'Restore preset'})).toBeDisabled();
  expect(onEdit).not.toHaveBeenCalled();expect(bridge.command).not.toHaveBeenCalled();
});

it('keeps preset failure visible outside the collapsed rack',async()=>{
  render(<SoundPanel trackId="guitar" onEdit={async()=>{throw new Error('Preset could not be applied');}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Restore preset'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Preset could not be applied');
});

it('shows a real output failure and keeps device selection reachable',async()=>{
  const {player,bridge}=nativePlayer();bridge.command=vi.fn(async()=>{throw new Error('Output is unavailable');});
  render(<SoundPanel trackId="guitar" onEdit={()=>{}} playback={player}/>);
  await screen.findByRole('option',{name:'Studio speakers'});
  await act(async()=>{fireEvent.change(screen.getByLabelText('Audio output'),{target:{value:'speakers'}});});
  expect(await screen.findByRole('alert')).toHaveTextContent('Output is unavailable');
  expect(screen.getByLabelText('Audio output')).toBeVisible();expect(screen.getByLabelText('Audio output')).toBeEnabled();
  expect(bridge.command).toHaveBeenCalledWith({type:'selectDevice',deviceId:'speakers',generation:player.generation});
});

it('shows device enumeration failure without hiding the default output',async()=>{
  const {player,bridge}=nativePlayer();bridge.devices=vi.fn(async()=>{throw new Error('Devices could not be read');});
  render(<SoundPanel trackId="guitar" onEdit={()=>{}} playback={player}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Devices could not be read');
  expect(screen.getByLabelText('Audio output')).toBeVisible();
});
