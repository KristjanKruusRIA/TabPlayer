// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,defaultDocumentSettings,defaultEffects} from '../document-settings';
import type {TrackSound} from '../edit-types';
afterEach(cleanup);

it('defaults match the native wah and are off',()=>{
  expect(defaultEffects().wah).toEqual({enabled:false,mode:'manual',position:.5,resonance:.5,sensitivity:.5,mix:1});
});

it('fills the wah into sounds saved before it and refuses unknown modes',()=>{
  const settings=defaultDocumentSettings(),older=soundPreset('crunch') as unknown as {effects:Record<string,unknown>};
  delete older.effects.wah;
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:older as unknown as TrackSound},new model.Score(),['base/0']);
  expect(settings.sounds['base/0'].effects.wah).toEqual(defaultEffects().wah);
  const bad=structuredClone(soundPreset('gm'));(bad.effects.wah as {mode:string}).mode='pedal';
  expect(()=>applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:bad},new model.Score(),['base/0'])).toThrow('Invalid effect parameter.');
});

it('places the wah before the amp with its pedal, mode and level controls',()=>{
  const onEdit=vi.fn();const {container,rerender}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  expect([...container.querySelectorAll('.sound-block-name')].map(node=>node.textContent).slice(0,6)).toEqual(['Gate','Compressor','Wah','Octaver','Pitch shift','Amp']);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects.wah;
  fireEvent.click(screen.getByLabelText('Enable wah'));expect(last().enabled).toBe(true);
  // Sensitivity only applies to auto mode, and the pedal position only to manual mode.
  expect(screen.getByLabelText('wah Sensitivity')).toBeDisabled();expect(screen.getByLabelText('wah Pedal position')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('wah Pedal position'),{target:{value:'0.8'}});expect(last().position).toBe(.8);
  fireEvent.change(screen.getByLabelText('wah Resonance'),{target:{value:'0.9'}});expect(last().resonance).toBe(.9);
  fireEvent.change(screen.getByLabelText('Wah mode'),{target:{value:'auto'}});expect(last().mode).toBe('auto');
  rerender(<SoundPanel trackId="base/0" sound={onEdit.mock.calls.at(-1)?.[0].sound} onEdit={onEdit}/>);
  expect(screen.getByLabelText('wah Pedal position')).toBeDisabled();expect(screen.getByLabelText('wah Sensitivity')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('wah Sensitivity'),{target:{value:'0.3'}});expect(last().sensitivity).toBe(.3);
  fireEvent.change(screen.getByLabelText('wah Mix'),{target:{value:'0.6'}});expect(last().mix).toBe(.6);
  expect(screen.getByLabelText('wah Pedal position')).toHaveAttribute('max','1');
});
