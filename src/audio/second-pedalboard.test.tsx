// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {completeSound,defaultEffects,effectBlocks,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {FxSettings,TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});

/** A clean sound with a tremolo, and a second pedalboard with another tremolo. */
function doubled():TrackSound {
  const sound=soundPreset('clean');sound.effects.tremolo={...sound.effects.tremolo,enabled:true,depth:.9};
  const second=defaultEffects();second.tremolo={...second.tremolo,enabled:true,rateHz:7,shape:'square'};
  sound.effects.second=second;return sound;
}

it('accepts a second pedalboard only on the track’s own, checked as the native player checks it',()=>{
  expect(Object.hasOwn(defaultEffects(),'second')).toBe(false);
  expect(soundProblem(doubled())).toBeNull();
  const nested=doubled();nested.effects.second!.second=defaultEffects();
  expect(soundProblem(nested)).toBe('Invalid second pedalboard.');
  const wrong=doubled();wrong.effects.second!.tremolo.depth=2;
  expect(soundProblem(wrong)).toBe('Invalid effect parameter.');
  const odd=doubled();(odd.effects.second as unknown as Record<string,unknown>).fuzz={enabled:true};
  expect(soundProblem(odd)).toBe('Invalid effect parameter.');
  // A null board is none, as the native player reads it.
  const missing=doubled();(missing.effects as unknown as Record<string,unknown>).second=null;
  expect(soundProblem(missing)).toBeNull();expect(Object.hasOwn(completeSound(missing).effects,'second')).toBe(false);
  const scalar=doubled();(scalar.effects as unknown as Record<string,unknown>).second=3;
  expect(soundProblem(scalar)).toBe('Invalid second pedalboard.');
  // A second board saved before later blocks reads them as switched off.
  const older=doubled();delete (older.effects.second as Partial<FxSettings>).graphicEq;
  expect(completeSound(older).effects.second!.graphicEq).toEqual(defaultEffects().graphicEq);
  expect(soundProblem(older)).toBeNull();
});

it('duplicates a pedal onto a second pedalboard with its own settings',async()=>{
  const onEdit=vi.fn(),sound=soundPreset('clean');sound.effects.tremolo={...sound.effects.tremolo,enabled:true,depth:.9};
  const {rerender}=render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  expect(screen.queryByRole('region',{name:'Second pedalboard'})).toBeNull();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Duplicate pedal: Tremolo'}));});
  const next:TrackSound=onEdit.mock.calls[0][0].sound;
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(next.effects.tremolo).toEqual(sound.effects.tremolo);
  expect(next.effects.second!.tremolo).toEqual(sound.effects.tremolo);
  expect(effectBlocks.filter(block=>next.effects.second![block].enabled)).toEqual(['tremolo']);
  expect(soundProblem(next)).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Duplicated the Tremolo pedal onto the second pedalboard.');
  rerender(<SoundPanel trackId="base/0" sound={next} onEdit={onEdit}/>);
  const board=screen.getByRole('region',{name:'Second pedalboard'});
  expect(screen.getByRole('button',{name:'Duplicate pedal: Tremolo'})).toBeDisabled();
  // The duplicate's controls change only the duplicate.
  fireEvent.change(within(board).getByLabelText('Second pedalboard: tremolo Rate (Hz)'),{target:{value:'9'}});
  const edited:TrackSound=onEdit.mock.calls.at(-1)![0].sound;
  expect(edited.effects.second!.tremolo.rateHz).toBe(9);
  expect(edited.effects.tremolo).toEqual(sound.effects.tremolo);
  fireEvent.change(within(board).getByLabelText('Second pedalboard: Tremolo shape'),{target:{value:'square'}});
  expect(onEdit.mock.calls.at(-1)![0].sound.effects.second.tremolo.shape).toBe('square');
  expect(onEdit.mock.calls.at(-1)![0].sound.effects.tremolo.shape).toBe('sine');
  // Every control name on the second board is its own.
  for(const role of ['spinbutton','combobox','checkbox'] as const)for(const element of within(board).queryAllByRole(role))expect(element).toHaveAccessibleName(expect.stringMatching(/^Second pedalboard: /));
});

it('removes a duplicate, and the second pedalboard with its last pedal',async()=>{
  const onEdit=vi.fn(),sound=doubled();sound.effects.second!.delay={...sound.effects.second!.delay,enabled:true};
  const {rerender}=render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  const board=screen.getByRole('region',{name:'Second pedalboard'});
  expect(within(board).getAllByText(/^(Tremolo|Delay)$/).map(node=>node.textContent)).toEqual(['Tremolo','Delay']);
  fireEvent.click(within(board).getByRole('button',{name:'Remove duplicate: Delay'}));
  const fewer:TrackSound=onEdit.mock.calls.at(-1)![0].sound;
  expect(fewer.effects.second!.delay.enabled).toBe(false);expect(fewer.effects.second!.tremolo.enabled).toBe(true);
  rerender(<SoundPanel trackId="base/0" sound={fewer} onEdit={onEdit}/>);
  fireEvent.click(within(screen.getByRole('region',{name:'Second pedalboard'})).getByRole('button',{name:'Remove duplicate: Tremolo'}));
  const none:TrackSound=onEdit.mock.calls.at(-1)![0].sound;
  expect(Object.hasOwn(none.effects,'second')).toBe(false);
  expect(none.effects.tremolo).toEqual(sound.effects.tremolo);
});

it('keeps the second pedalboard in saved sounds',()=>{
  expect(saveSoundPreset('Two tremolos',doubled()).ok).toBe(true);
  expect(readSoundLibrary()[0].sound.effects.second!.tremolo).toEqual(doubled().effects.second!.tremolo);
});

it('drops a saved second pedalboard with nothing switched on',()=>{
  const empty=soundPreset('clean');empty.effects.second=defaultEffects();
  expect(saveSoundPreset('Empty board',empty).ok).toBe(true);
  expect(Object.hasOwn(readSoundLibrary()[0].sound.effects,'second')).toBe(false);
});
