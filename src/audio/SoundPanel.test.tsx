// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
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

it('allows busy rack inspection while refusing sound and output changes without disabling anything that can hold focus',async()=>{
  const {player,bridge}=nativePlayer(),onEdit=vi.fn();render(<SoundPanel trackId="guitar" onEdit={onEdit} playback={player} busy/>);
  await screen.findByRole('option',{name:'Studio speakers'});
  fireEvent.click(screen.getByText('Gate',{exact:true}));
  expect(screen.getByLabelText('Enable gate')).toBeVisible();
  // Busy is `aria-disabled` on each group, never the `disabled` attribute, which would drop focus from the control that holds it.
  expect(document.querySelectorAll('fieldset[disabled]')).toHaveLength(0);
  for(const fieldset of document.querySelectorAll('fieldset'))expect(fieldset).toHaveAttribute('aria-disabled','true');
  for(const label of ['Sound source','Sound preset','gate Threshold (dB)','Enable gate','Audio output'])expect(screen.getByLabelText(label)).toBeEnabled();
  expect(screen.getByRole('button',{name:'Restore preset'})).toBeEnabled();
  expect(onEdit).not.toHaveBeenCalled();expect(bridge.command).not.toHaveBeenCalled();
});

it('refuses the wheel over a number field while busy, and lets it through otherwise',()=>{
  const wheel=()=>{const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100});screen.getByLabelText('amp Gain (dB)').dispatchEvent(event);return event.defaultPrevented;};
  const sound=soundPreset('lead','green-guitar'),{rerender}=render(<SoundPanel trackId="guitar" sound={sound} onEdit={vi.fn()} busy/>);
  fireEvent.click(screen.getByText('Amp',{exact:true}));
  expect(wheel()).toBe(true);
  rerender(<SoundPanel trackId="guitar" sound={sound} onEdit={vi.fn()}/>);
  expect(wheel()).toBe(false);
});

it('does nothing on a click or change while busy, and focus stays where it was',async()=>{
  const {player,bridge}=nativePlayer(),onEdit=vi.fn(),sound=soundPreset('lead','green-guitar');
  const {rerender}=render(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit} playback={player}/>);
  await screen.findByRole('option',{name:'Studio speakers'});
  fireEvent.click(screen.getByText('Gate',{exact:true}));
  const source=screen.getByLabelText('Sound source');source.focus();expect(document.activeElement).toBe(source);
  rerender(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit} playback={player} busy/>);
  expect(document.activeElement).toBe(source);
  for(const target of [screen.getByRole('button',{name:'Restore preset'}),screen.getByLabelText('Enable gate'),screen.getByRole('button',{name:'Copy sound'})]) {
    await userEvent.click(target);expect(document.activeElement).toBe(source);
  }
  fireEvent.change(source,{target:{value:'black-guitar'}});fireEvent.change(screen.getByLabelText('Audio output'),{target:{value:'speakers'}});
  await userEvent.type(screen.getByLabelText('gate Threshold (dB)'),'5');
  expect(onEdit).not.toHaveBeenCalled();expect(bridge.command).not.toHaveBeenCalled();
  expect(source).toHaveValue('green-guitar');expect(screen.getByLabelText('Enable gate')).not.toBeChecked();
  rerender(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit} playback={player}/>);
  await userEvent.click(screen.getByRole('button',{name:'Restore preset'}));
  expect(onEdit).toHaveBeenCalledTimes(1);
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


it('toggles track sound lock with one undoable edit and records nothing for unchanged value', () => {
  const onEdit = vi.fn();
  const { rerender } = render(<SoundPanel trackId="guitar" sound={soundPreset('lead')} onEdit={onEdit} />);
  const lockBox = screen.getByRole('checkbox', { name: 'Lock sound against automations' });
  expect(lockBox).not.toBeChecked();

  // Clicking checks it and calls onEdit once with locked: true
  fireEvent.click(lockBox);
  expect(onEdit).toHaveBeenCalledTimes(1);
  const recorded = onEdit.mock.calls[0][0];
  expect(recorded).toEqual({
    type: 'setTrackSound',
    trackId: 'guitar',
    sound: { ...soundPreset('lead'), locked: true },
  });

  // Re-render with locked sound
  rerender(<SoundPanel trackId="guitar" sound={recorded.sound} onEdit={onEdit} />);
  expect(screen.getByRole('checkbox', { name: 'Lock sound against automations' })).toBeChecked();

  // Clicking again unlocks with locked removed/omitted
  fireEvent.click(screen.getByRole('checkbox', { name: 'Lock sound against automations' }));
  expect(onEdit).toHaveBeenCalledTimes(2);
  const unlocked = onEdit.mock.calls[1][0];
  expect(unlocked.sound.locked).toBeUndefined();
});

it('keeps the lock control focusable while busy with aria-disabled and refuses clicks', () => {
  const onEdit = vi.fn();
  render(<SoundPanel trackId="guitar" sound={soundPreset('lead')} onEdit={onEdit} busy />);
  const lockBox = screen.getByRole('checkbox', { name: 'Lock sound against automations' });

  // Control stays focusable: not disabled attribute, but aria-disabled="true"
  expect(lockBox).not.toBeDisabled();
  expect(lockBox).toHaveAttribute('aria-disabled', 'true');

  lockBox.focus();
  expect(document.activeElement).toBe(lockBox);

  // Clicking while busy refuses and records nothing
  fireEvent.click(lockBox);
  expect(onEdit).not.toHaveBeenCalled();
});
