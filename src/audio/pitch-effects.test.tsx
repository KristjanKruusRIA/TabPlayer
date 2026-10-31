// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,defaultDocumentSettings,defaultEffects} from '../document-settings';
import type {TrackSound} from '../edit-types';
afterEach(cleanup);

it('defaults match the native pitch blocks and are off',()=>{
  const fx=defaultEffects();
  expect({octaver:fx.octaver,pitch:fx.pitch}).toEqual({
    octaver:{enabled:false,octaveDown:.5,twoOctavesDown:0,direct:1},
    pitch:{enabled:false,semitones:12,mix:1},
  });
});

it('fills the pitch blocks into sounds saved before them',()=>{
  const settings=defaultDocumentSettings(),older=soundPreset('lead') as unknown as {effects:Record<string,unknown>};
  delete older.effects.octaver;delete older.effects.pitch;
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:older as unknown as TrackSound},new model.Score(),['base/0']);
  expect(settings.sounds['base/0'].effects.octaver).toEqual(defaultEffects().octaver);
  expect(settings.sounds['base/0'].effects.pitch).toEqual(defaultEffects().pitch);
});

it('places the octaver and pitch shift between the wah and the drive pedal with their controls',()=>{
  const onEdit=vi.fn();const {container}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  expect([...container.querySelectorAll('.sound-block-name')].map(node=>node.textContent).slice(1,8)).toEqual(['Gate','Compressor','Wah','Octaver','Pitch shift','Drive','Amp']);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects;
  fireEvent.click(screen.getByLabelText('Enable octaver'));expect(last().octaver.enabled).toBe(true);
  fireEvent.change(screen.getByLabelText('octaver Octave down'),{target:{value:'0.8'}});expect(last().octaver.octaveDown).toBe(.8);
  fireEvent.change(screen.getByLabelText('octaver Two octaves down'),{target:{value:'0.4'}});expect(last().octaver.twoOctavesDown).toBe(.4);
  fireEvent.change(screen.getByLabelText('octaver Direct'),{target:{value:'0.6'}});expect(last().octaver.direct).toBe(.6);
  fireEvent.click(screen.getByLabelText('Enable pitch'));expect(last().pitch.enabled).toBe(true);
  fireEvent.change(screen.getByLabelText('pitch Semitones'),{target:{value:'-7'}});expect(last().pitch.semitones).toBe(-7);
  fireEvent.change(screen.getByLabelText('pitch Mix'),{target:{value:'0.5'}});expect(last().pitch.mix).toBe(.5);
  const semitones=screen.getByLabelText('pitch Semitones');
  expect(semitones).toHaveAttribute('min','-24');expect(semitones).toHaveAttribute('max','24');expect(semitones).toHaveAttribute('step','1');
  // Out-of-range values are not sent.
  const count=onEdit.mock.calls.length;fireEvent.change(semitones,{target:{value:'30'}});expect(onEdit.mock.calls.length).toBe(count);
});

it('refuses effect values outside their ranges from saved or imported sounds',()=>{
  const settings=defaultDocumentSettings(),sound=soundPreset('gm');
  const bad=(patch:(effects:TrackSound['effects'])=>void)=>{const next=structuredClone(sound);patch(next.effects);return ()=>applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:next},new model.Score(),['base/0']);};
  expect(bad(fx=>{fx.pitch.semitones=30;})).toThrow('Invalid effect parameter.');
  expect(bad(fx=>{fx.octaver.octaveDown=2;})).toThrow('Invalid effect parameter.');
  expect(bad(fx=>{fx.wah.position=-0.1;})).toThrow('Invalid effect parameter.');
  expect(bad(fx=>{fx.pitch.semitones=-24;fx.octaver.direct=0;})).not.toThrow();
});
