// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,defaultDocumentSettings,defaultEffects,soundProblem} from '../document-settings';
import type {TrackSound} from '../edit-types';
afterEach(cleanup);

it('defaults match the native drive pedal and are off',()=>{
  expect(defaultEffects().drive).toEqual({enabled:false,model:'overdrive',drive:.5,tone:.5,levelDb:0});
});

it('fills the drive pedal into sounds saved before it',()=>{
  const settings=defaultDocumentSettings(),older=soundPreset('crunch') as unknown as {effects:Record<string,unknown>};
  delete older.effects.drive;
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:older as unknown as TrackSound},new model.Score(),['base/0']);
  expect(settings.sounds['base/0'].effects.drive).toEqual(defaultEffects().drive);
});

it('places the drive pedal between the pitch shift and the amp with its controls',()=>{
  const onEdit=vi.fn();const {container}=render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  expect([...container.querySelectorAll('.sound-block-name')].map(node=>node.textContent).slice(4,7)).toEqual(['Pitch shift','Drive','Amp']);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects;
  fireEvent.click(screen.getByLabelText('Enable drive'));expect(last().drive.enabled).toBe(true);
  const kind=screen.getByLabelText('Drive model');
  expect([...kind.querySelectorAll('option')].map(option=>[option.getAttribute('value'),option.textContent])).toEqual([['overdrive','Overdrive'],['distortion','Distortion'],['fuzz','Fuzz']]);
  fireEvent.change(kind,{target:{value:'fuzz'}});expect(last().drive.model).toBe('fuzz');
  fireEvent.change(screen.getByLabelText('drive Drive'),{target:{value:'0.9'}});expect(last().drive.drive).toBe(.9);
  fireEvent.change(screen.getByLabelText('drive Tone'),{target:{value:'0.2'}});expect(last().drive.tone).toBe(.2);
  const level=screen.getByLabelText('drive Level (dB)');
  expect(level).toHaveAttribute('min','-24');expect(level).toHaveAttribute('max','12');
  fireEvent.change(level,{target:{value:'-6'}});expect(last().drive.levelDb).toBe(-6);
  // Out-of-range values are not sent.
  const count=onEdit.mock.calls.length;fireEvent.change(level,{target:{value:'20'}});expect(onEdit.mock.calls.length).toBe(count);
});

it('refuses drive values the native player would reject',()=>{
  const sound=soundPreset('gm'),bad=(patch:(drive:Record<string,unknown>)=>void)=>{const next=structuredClone(sound);patch(next.effects.drive as unknown as Record<string,unknown>);return soundProblem(next);};
  expect(bad(drive=>{drive.model='boost';})).toBe('Invalid effect parameter.');
  expect(bad(drive=>{drive.drive=1.2;})).toBe('Invalid effect parameter.');
  expect(bad(drive=>{drive.tone=-0.1;})).toBe('Invalid effect parameter.');
  expect(bad(drive=>{drive.levelDb=13;})).toBe('Invalid effect parameter.');
  expect(bad(drive=>{drive.model='distortion';drive.levelDb=-24;drive.drive=1;drive.tone=0;})).toBeNull();
});
