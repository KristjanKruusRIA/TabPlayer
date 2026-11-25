// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import './plugin-test-support';
import { SoundPanel, soundPreset } from './SoundPanel';
import { NativePlaybackController } from './NativePlaybackController';
import { useSoundEditing } from './useSoundEditing';
import type { NativeAudioBridge } from './bridge';

const players:NativePlaybackController[]=[];
afterEach(()=>{cleanup();for(const player of players)player.destroy();players.length=0;});
function nativePlayer(overrides:Partial<NativeAudioBridge>={}) {
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[{id:'speakers',name:'Studio speakers',isDefault:false}]),diagnostics:vi.fn(async()=>({deviceName:'Studio speakers',sampleRate:48000,bufferSize:512})),testTone:vi.fn(async()=>{}),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null),...overrides};
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

it('allows busy rack inspection while refusing sound changes without disabling anything that can hold focus',async()=>{
  const {player,bridge}=nativePlayer(),onEdit=vi.fn();render(<SoundPanel trackId="guitar" onEdit={onEdit} playback={player} busy/>);
  fireEvent.click(screen.getByText('Gate',{exact:true}));
  expect(screen.getByLabelText('Enable gate')).toBeVisible();
  // Busy is `aria-disabled` on each group, never the `disabled` attribute, which would drop focus from the control that holds it.
  expect(document.querySelectorAll('fieldset[disabled]')).toHaveLength(0);
  for(const fieldset of document.querySelectorAll('fieldset'))expect(fieldset).toHaveAttribute('aria-disabled','true');
  for(const label of ['Sound source','Sound preset','gate Threshold (dB)','Enable gate'])expect(screen.getByLabelText(label)).toBeEnabled();
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
  fireEvent.click(screen.getByText('Gate',{exact:true}));
  const source=screen.getByLabelText('Sound source');source.focus();expect(document.activeElement).toBe(source);
  rerender(<SoundPanel trackId="guitar" sound={sound} onEdit={onEdit} playback={player} busy/>);
  expect(document.activeElement).toBe(source);
  for(const target of [screen.getByRole('button',{name:'Restore preset'}),screen.getByLabelText('Enable gate'),screen.getByRole('button',{name:'Copy sound'})]) {
    await userEvent.click(target);expect(document.activeElement).toBe(source);
  }
  fireEvent.change(source,{target:{value:'black-guitar'}});
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

it('keeps audio output controls out of track sound settings (moved to Preferences)', async () => {
  const { player, bridge } = nativePlayer();
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByLabelText('Audio output')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Test tone' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Audio diagnostics' })).toBeNull();
  expect(bridge.diagnostics).not.toHaveBeenCalled();
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

it('reads the device diagnostics only where the readout is shown', async () => {
  const { player, bridge } = nativePlayer();
  renderHook(() => useSoundEditing({ trackId: 'guitar', onEdit: () => {}, playback: player }));
  await act(async () => { await Promise.resolve(); });
  expect(bridge.diagnostics).not.toHaveBeenCalled();
  renderHook(() => useSoundEditing({ trackId: 'guitar', onEdit: () => {}, playback: player, diagnostics: true }));
  await act(async () => { await Promise.resolve(); });
  expect(bridge.diagnostics).toHaveBeenCalledTimes(1);
});

const pluginSlot={format:'vst3' as const,classId:'A'.repeat(32),name:'Amp Rig',vendor:'Vendor',active:true,inputDb:0,outputDb:0,state:''};
it.each([['guitar',false],['drums',true]])('has no plug-in slot, drum map or plug-in choice: they are in the Plug-in dialog (%s)',(_name,percussion)=>{
  const view=render(<SoundPanel trackId="track" percussion={percussion} sound={{...soundPreset(percussion?'gm':'lead'),plugin:{...pluginSlot,kind:percussion?'instrument':undefined}}} onEdit={vi.fn()}/>);
  expect(view.container.querySelector('.sound-plugin-slot')).toBeNull();expect(screen.queryByRole('combobox',{name:'VST3 plug-in'})).toBeNull();expect(screen.queryByRole('button',{name:'Add plug-in…'})).toBeNull();expect(screen.queryByRole('combobox',{name:'Drum map'})).toBeNull();
  expect(screen.getByLabelText('Sound source')).toBeInTheDocument();expect(screen.getByText('My sounds')).toBeInTheDocument();expect(screen.getByText('Signal chain')).toBeInTheDocument();
});
it('an effect plug-in keeps the Replaced markers and a one-line note with a Plug-in… button that asks for the Plug-in dialog',()=>{
  const open=vi.fn();
  const view=render(<SoundPanel trackId="guitar" sound={{...soundPreset('lead'),plugin:pluginSlot}} onEdit={vi.fn()} onOpenPlugin={open}/>);
  expect(Array.from(view.container.querySelectorAll('.sound-block>summary')).filter(summary=>/Replaced/.test(summary.textContent??'')).length).toBe(3);
  const note=view.container.querySelector('.sound-plugin-link') as HTMLElement;expect(note).toHaveTextContent('Drive, Amp and Cabinet are replaced by the plug-in.');
  fireEvent.click(within(note).getByRole('button',{name:'Plug-in…'}));expect(open).toHaveBeenCalledTimes(1);
  view.rerender(<SoundPanel trackId="guitar" sound={{...soundPreset('lead'),plugin:{...pluginSlot,active:false}}} onEdit={vi.fn()} onOpenPlugin={open}/>);
  expect(view.container.querySelector('.sound-plugin-link')).toBeNull();
  view.rerender(<SoundPanel trackId="guitar" sound={{...soundPreset('lead'),plugin:{...pluginSlot,kind:'instrument'}}} onEdit={vi.fn()} onOpenPlugin={open}/>);
  expect(view.container.querySelector('.sound-plugin-link')).toBeNull();
});
it('a drum instrument keeps the kit note in the sound editor with a Plug-in… route to the Plug-in dialog',()=>{
  const open=vi.fn();
  render(<SoundPanel trackId="drums" percussion sound={{...soundPreset('gm'),plugin:{...pluginSlot,kind:'instrument'}}} onEdit={vi.fn()} onOpenPlugin={open}/>);
  const note=screen.getByText(/The kit and its mix apply to the built-in kit/);fireEvent.click(within(note).getByRole('button',{name:'Plug-in…'}));expect(open).toHaveBeenCalledTimes(1);
});
