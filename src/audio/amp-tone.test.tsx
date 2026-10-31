// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {defaultEffects,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});
const controls=[['bassDb','Bass (dB)'],['midDb','Mid (dB)'],['trebleDb','Treble (dB)'],['presenceDb','Presence (dB)']] as const;
type Loose=Record<string,Record<string,unknown>>;
/** A crunch sound with one amp tone control set to `value`. */
const shaped=(field:string,value:unknown,block='amp')=>{const sound=soundPreset('crunch');(sound.effects as unknown as Loose)[block][field]=value;return sound;};

it('keeps a flat tone stack by default, so amps saved before it sound as they did',()=>{
  for(const [field] of controls)expect(Object.hasOwn(defaultEffects().amp,field)).toBe(false);
  expect(soundProblem(soundPreset('lead'))).toBeNull();
});

it('accepts the tone the native player accepts and refuses the rest',()=>{
  for(const [field] of controls){
    for(const value of [-12,-.5,0,6,12])expect(soundProblem(shaped(field,value)),`${field} ${value}`).toBeNull();
    for(const value of [12.5,-13,Number.NaN,Number.POSITIVE_INFINITY,'3',null])expect(soundProblem(shaped(field,value)),`${field} ${String(value)}`).toBe('Invalid effect parameter.');
  }
  expect(soundProblem(shaped('bassDb',3,'cabinet'))).toBe('Invalid effect parameter.');
});

it('edits each tone control on the amp, and a flat control saves nothing',()=>{
  const onEdit=vi.fn();
  const {rerender}=render(<SoundPanel trackId="base/0" sound={soundPreset('crunch')} onEdit={onEdit}/>);
  for(const [field,label] of controls){
    const input=screen.getByLabelText(`amp ${label}`);
    expect(input).toHaveValue(0);expect(input).toHaveAttribute('min','-12');expect(input).toHaveAttribute('max','12');
    fireEvent.change(input,{target:{value:'-4.5'}});
    const sound:TrackSound=onEdit.mock.calls.at(-1)?.[0].sound;
    expect((sound.effects.amp as unknown as Record<string,unknown>)[field]).toBe(-4.5);
    expect(sound.effects.amp.model).toBe('crunch');
    rerender(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
    expect(screen.getByLabelText(`amp ${label}`)).toHaveValue(-4.5);
    const calls=onEdit.mock.calls.length;
    fireEvent.change(screen.getByLabelText(`amp ${label}`),{target:{value:'13'}});
    expect(onEdit.mock.calls.length).toBe(calls);
    fireEvent.change(screen.getByLabelText(`amp ${label}`),{target:{value:'0'}});
    const flat:TrackSound=onEdit.mock.calls.at(-1)?.[0].sound;
    expect(Object.hasOwn(flat.effects.amp,field)).toBe(false);
    rerender(<SoundPanel trackId="base/0" sound={soundPreset('crunch')} onEdit={onEdit}/>);
  }
});

it('offers every amp and cabinet the native player knows, and refuses any other name',()=>{
  for(const model of ['clean','crunch','lead','metal','bass','bassDrive'])expect(soundProblem(shaped('model',model)),model).toBeNull();
  for(const model of ['open','closed','combo','bass','bassStack'])expect(soundProblem(shaped('model',model,'cabinet')),model).toBeNull();
  expect(soundProblem(shaped('model','nope'))).not.toBeNull();
  expect(soundProblem(shaped('model','nope','cabinet'))).not.toBeNull();
  const onEdit=vi.fn();
  render(<SoundPanel trackId="base/0" sound={soundPreset('crunch')} onEdit={onEdit}/>);
  expect(within(screen.getByLabelText('Amp model')).getByRole('option',{name:'bass drive'})).toHaveValue('bassDrive');
  expect(within(screen.getByLabelText('Cabinet model')).getByRole('option',{name:'bass stack'})).toHaveValue('bassStack');
  fireEvent.change(screen.getByLabelText('Amp model'),{target:{value:'metal'}});
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.amp.model).toBe('metal');
});

it('keeps the tone stack in saved sounds',()=>{
  expect(saveSoundPreset('Dark crunch',shaped('trebleDb',-6)).ok).toBe(true);
  expect((readSoundLibrary()[0].sound.effects.amp as unknown as Record<string,unknown>).trebleDb).toBe(-6);
});
