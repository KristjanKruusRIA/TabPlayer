// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {model} from '@coderline/alphatab';
import {SoundPanel,soundPreset} from './SoundPanel';
import {applySettingsEdit,completeSound,defaultDocumentSettings,defaultEffects,soundProblem} from '../document-settings';
import type {TrackSound} from '../edit-types';
afterEach(cleanup);

it('defaults to the room reverb, as the native player does',()=>{
  expect(defaultEffects().reverb).toEqual({enabled:false,model:'room',room:.5,damping:.5,mix:.12});
});

it('reads reverbs saved before the models as the room, keeping their settings',()=>{
  const settings=defaultDocumentSettings(),older=soundPreset('lead') as unknown as {effects:{reverb:Record<string,unknown>}};
  delete older.effects.reverb.model;older.effects.reverb.room=.8;
  expect(soundProblem(older as unknown as TrackSound)).toBeNull();
  expect(completeSound(older as unknown as TrackSound).effects.reverb).toEqual({enabled:true,model:'room',room:.8,damping:.5,mix:.12});
  applySettingsEdit(settings,{type:'setTrackSound',trackId:'base/0',sound:older as unknown as TrackSound},new model.Score(),['base/0']);
  expect(settings.sounds['base/0'].effects.reverb).toEqual({enabled:true,model:'room',room:.8,damping:.5,mix:.12});
  // A model left undefined is dropped from JSON, so the native player reads it as the room too.
  const unset=structuredClone(older);unset.effects.reverb.model=undefined;
  expect(soundProblem(unset as unknown as TrackSound)).toBeNull();
  expect(completeSound(unset as unknown as TrackSound).effects.reverb.model).toBe('room');
});

it('chooses the reverb model in the Reverb block',()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  const kind=screen.getByLabelText('Reverb model');
  expect(kind).toHaveValue('room');
  expect([...kind.querySelectorAll('option')].map(option=>[option.getAttribute('value'),option.textContent])).toEqual([['room','Room'],['hall','Hall'],['plate','Plate'],['spring','Spring']]);
  fireEvent.change(kind,{target:{value:'spring'}});
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.reverb).toEqual({enabled:false,model:'spring',room:.5,damping:.5,mix:.12});
});

it('refuses reverb models the native player would reject',()=>{
  const sound=soundPreset('gm'),with_=(value:unknown)=>{const next=structuredClone(sound);(next.effects.reverb as unknown as Record<string,unknown>).model=value;return soundProblem(next);};
  expect(with_('cathedral')).toBe('Invalid effect parameter.');
  expect(with_(3)).toBe('Invalid effect parameter.');
  for(const kind of ['room','hall','plate','spring'])expect(with_(kind)).toBeNull();
});
