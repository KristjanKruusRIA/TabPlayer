// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {completeSound,defaultEffects,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});

it('defaults to the digital delay, as the native player does',()=>{
  expect(defaultEffects().delay).toEqual({enabled:false,model:'digital',quarterNotes:1,feedback:.25,mix:.15});
});

it('reads delays saved before the models as digital, keeping their settings',()=>{
  const older=soundPreset('lead') as unknown as {effects:{delay:Record<string,unknown>}};
  delete older.effects.delay.model;older.effects.delay.feedback=.6;
  expect(soundProblem(older as unknown as TrackSound)).toBeNull();
  expect(completeSound(older as unknown as TrackSound).effects.delay).toEqual({enabled:true,model:'digital',quarterNotes:1,feedback:.6,mix:.15});
  const unset=structuredClone(older);unset.effects.delay.model=undefined;
  expect(completeSound(unset as unknown as TrackSound).effects.delay.model).toBe('digital');
});

it('chooses the delay model and a straight, dotted or triplet division',()=>{
  const onEdit=vi.fn(),{rerender}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects.delay;
  const kind=screen.getByLabelText('Delay model');
  expect(kind).toHaveValue('digital');
  expect([...kind.querySelectorAll('option')].map(option=>[option.getAttribute('value'),option.textContent])).toEqual([['digital','Digital'],['tape','Tape'],['analog','Analog']]);
  fireEvent.change(kind,{target:{value:'tape'}});expect(last().model).toBe('tape');
  const time=screen.getByLabelText('Delay time');
  expect([...time.querySelectorAll('option')].map(option=>option.textContent)).toEqual(['1/32','1/16','1/8 triplet','1/8','1/4 triplet','Dotted 1/8','1/4','Dotted 1/4','1/2','Whole']);
  expect(time).toHaveValue('1');
  fireEvent.change(time,{target:{value:String(.75)}});expect(last().quarterNotes).toBe(.75);
  fireEvent.change(time,{target:{value:String(1/3)}});expect(last().quarterNotes).toBe(1/3);
  // A triplet saved in a sound shows as its name.
  rerender(<SoundPanel trackId="base/0" sound={onEdit.mock.calls.at(-1)?.[0].sound} onEdit={onEdit}/>);
  expect((screen.getByLabelText('Delay time') as HTMLSelectElement).selectedOptions[0].textContent).toBe('1/8 triplet');
});

it('refuses delay models and divisions the native player would reject',()=>{
  const sound=soundPreset('gm'),with_=(patch:Record<string,unknown>)=>{const next=structuredClone(sound);Object.assign(next.effects.delay,patch);return soundProblem(next);};
  expect(with_({model:'lofi'})).toBe('Invalid effect parameter.');
  expect(with_({quarterNotes:.6})).toBe('Invalid effect parameter.');
  for(const model of ['digital','tape','analog'])expect(with_({model})).toBeNull();
  for(const quarterNotes of [.125,.25,1/3,.5,2/3,.75,1,1.5,2,4])expect(with_({quarterNotes})).toBeNull();
});

it('keeps the delay model and division through a saved sound',()=>{
  const sound=soundPreset('lead');Object.assign(sound.effects.delay,{model:'analog',quarterNotes:2/3});
  expect(saveSoundPreset('Slapback',sound,localStorage).ok).toBe(true);
  const saved=readSoundLibrary(localStorage).find(entry=>entry.name==='Slapback');
  expect(saved?.sound.effects.delay).toEqual({enabled:true,model:'analog',quarterNotes:2/3,feedback:.25,mix:.15});
});
