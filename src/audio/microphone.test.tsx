// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {completeSound,defaultEffects,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});

it('defaults to a standard stereo microphone, switched off, as the native player does',()=>{
  expect(defaultEffects().microphone).toEqual({enabled:false,placement:'standard',output:'stereo'});
});

it('gives sounds saved before the microphone settings the default ones',()=>{
  const older=soundPreset('lead') as unknown as {effects:Record<string,unknown>};
  delete older.effects.microphone;
  expect(soundProblem(older as unknown as TrackSound)).toBeNull();
  expect(completeSound(older as unknown as TrackSound).effects.microphone).toEqual({enabled:false,placement:'standard',output:'stereo'});
});

it('lists the microphone first in the chain and chooses its placement and output',()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects.microphone;
  expect([...document.querySelectorAll('.sound-block-name')].map(node=>node.textContent)[0]).toBe('Microphone');
  const placement=screen.getByLabelText('Microphone placement'),output=screen.getByLabelText('Microphone output');
  expect([...placement.querySelectorAll('option')].map(option=>[option.getAttribute('value'),option.textContent])).toEqual([['standard','Standard'],['close','Close'],['edge','Edge'],['room','Room']]);
  expect([...output.querySelectorAll('option')].map(option=>[option.getAttribute('value'),option.textContent])).toEqual([['stereo','Stereo'],['mono','Mono']]);
  fireEvent.click(screen.getByLabelText('Enable microphone'));expect(last()).toEqual({enabled:true,placement:'standard',output:'stereo'});
  fireEvent.change(placement,{target:{value:'room'}});expect(last().placement).toBe('room');
  fireEvent.change(output,{target:{value:'mono'}});expect(last().output).toBe('mono');
});

it('refuses microphone settings the native player would reject',()=>{
  const sound=soundPreset('gm'),with_=(patch:Record<string,unknown>)=>{const next=structuredClone(sound);Object.assign(next.effects.microphone,patch);return soundProblem(next);};
  expect(with_({placement:'ribbon'})).toBe('Invalid effect parameter.');
  expect(with_({output:'surround'})).toBe('Invalid effect parameter.');
  for(const placement of ['standard','close','edge','room'])for(const output of ['stereo','mono'])expect(with_({placement,output})).toBeNull();
});

it('keeps the microphone through a saved sound',()=>{
  const sound=soundPreset('lead');Object.assign(sound.effects.microphone,{enabled:true,placement:'edge',output:'mono'});
  expect(saveSoundPreset('Edge mic',sound,localStorage).ok).toBe(true);
  expect(readSoundLibrary(localStorage).find(entry=>entry.name==='Edge mic')?.sound.effects.microphone).toEqual({enabled:true,placement:'edge',output:'mono'});
});
