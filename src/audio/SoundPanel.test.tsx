// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { SoundPanel, soundPreset } from './SoundPanel';
import { NativePlaybackController } from './NativePlaybackController';
import { useSoundEditing } from './useSoundEditing';
import type { NativeAudioBridge, NativeAudioStatus } from './bridge';
import { DEFAULT_PRACTICE } from './practice-types';

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

it('displays diagnostics readout of device name, sample rate, and buffer size from backend', async () => {
  const { player } = nativePlayer();
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const diagGroup = await screen.findByRole('group', { name: 'Audio diagnostics' });
  expect(diagGroup).toHaveTextContent('Device: Studio speakers');
  expect(diagGroup).toHaveTextContent('Sample rate: 48000 Hz');
  expect(diagGroup).toHaveTextContent('Buffer size: 512 frames');
});

it('reads unknown when diagnostic values are unreported and never uses defaults', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => ({}));
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const diagGroup = await screen.findByRole('group', { name: 'Audio diagnostics' });
  expect(diagGroup).toHaveTextContent('Device: Unknown');
  expect(diagGroup).toHaveTextContent('Sample rate: Unknown');
  expect(diagGroup).toHaveTextContent('Buffer size: Unknown');
});

it('triggers test tone on button click and keeps control focusable while busy', async () => {
  const { player, bridge } = nativePlayer();
  const { rerender } = render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const btn = screen.getByRole('button', { name: 'Test tone' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(bridge.testTone).toHaveBeenCalledTimes(1);

  // While busy: stays focusable, click refused
  rerender(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} busy />);
  expect(btn).not.toBeDisabled();
  btn.focus();
  expect(document.activeElement).toBe(btn);
  fireEvent.click(btn);
  expect(bridge.testTone).toHaveBeenCalledTimes(1);
});

it('shows plain message when test tone is refused during playback', async () => {
  const { player, bridge } = nativePlayer();
  bridge.testTone = vi.fn(async () => {
    throw 'audio_test_tone_playback';
  });
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const btn = screen.getByRole('button', { name: 'Test tone' });
  await act(async () => {
    fireEvent.click(btn);
  });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The test tone is unavailable during playback.');
});

it('shows plain message when device diagnostics fail and leaves output selectable', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => {
    throw 'audio_output_unavailable';
  });
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The audio output is unavailable.');
  expect(screen.getByLabelText('Audio output')).toBeVisible();
});

it('readout follows a device change that completes after selectOutput returns', async () => {
  let current = { deviceName: 'Speakers', sampleRate: 44100, bufferSize: 441 };
  let finish: () => void = () => {};
  const { player, bridge } = nativePlayer();
  bridge.command = vi.fn((command) => command.type === 'selectDevice'
    ? new Promise<void>((resolve) => { finish = () => { current = { deviceName: 'Headphones', sampleRate: 48000, bufferSize: 512 }; resolve(); }; })
    : Promise.resolve());
  bridge.devices = vi.fn(async () => [{ id: 'phones', name: 'Headphones', isDefault: false }]);
  bridge.diagnostics = vi.fn(async () => current);
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  const group = await screen.findByRole('group', { name: 'Audio diagnostics' });
  await screen.findByRole('option', { name: 'Headphones' });
  await vi.waitFor(() => expect(group).toHaveTextContent('Device: Speakers'));
  fireEvent.change(screen.getByLabelText('Audio output'), { target: { value: 'phones' } });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(group).toHaveTextContent('Device: Speakers');
  await act(async () => { finish(); await new Promise((r) => setTimeout(r, 50)); });
  expect(group).toHaveTextContent('Device: Headphones');
  expect(group).toHaveTextContent('Sample rate: 48000 Hz');
});

it('ignores a slow earlier readout that answers after a newer one', async () => {
  const { player, bridge } = nativePlayer();
  const answers: Array<(value: { deviceName: string }) => void> = [];
  bridge.diagnostics = vi.fn(() => new Promise<{ deviceName: string }>((resolve) => { answers.push(resolve); }));
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Test tone' }));
  await vi.waitFor(() => expect(bridge.testTone).toHaveBeenCalled());
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  await act(async () => { answers[1]({ deviceName: 'Newer' }); });
  await act(async () => { answers[0]({ deviceName: 'Older' }); });
  expect(screen.getByRole('group', { name: 'Audio diagnostics' })).toHaveTextContent('Device: Newer');
});

it('clears the playback refusal when playback stops', async () => {
  let receive: (status: NativeAudioStatus) => void = () => {};
  const { player, bridge } = nativePlayer({ subscribe: vi.fn(async (listener) => { receive = listener; return () => {}; }) });
  const emit = (change: Partial<NativeAudioStatus>) => receive({ generation: player.generation, ready: true, playing: false, tick: 0, seconds: 0, durationSeconds: 8, speed: 1, metronome: false, error: null, deviceId: null, range: null, loop: null, practice: { settings: structuredClone(DEFAULT_PRACTICE), phase: change.playing ? 'playing' : 'paused', countInRemaining: 0, completedPasses: 0, effectiveRatio: 1, currentBpm: 120, pulse: null }, ...change } as NativeAudioStatus);
  bridge.testTone = vi.fn(async () => { throw 'audio_test_tone_playback'; });
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { emit({ playing: true }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test tone' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('The test tone is unavailable during playback.');
  await act(async () => { emit({ playing: false }); });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('words an unknown refusal code generically instead of showing it raw', async () => {
  const { player, bridge } = nativePlayer();
  bridge.diagnostics = vi.fn(async () => { throw 'something_new'; });
  render(<SoundPanel trackId="guitar" onEdit={() => {}} playback={player} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('The audio output could not be read.');
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
