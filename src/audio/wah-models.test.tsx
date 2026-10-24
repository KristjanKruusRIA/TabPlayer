// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {completeSound,defaultEffects,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});

/** A clean sound with the wah switched on as `model`. */
function wah(model:string):TrackSound {
  const sound=soundPreset('clean');sound.effects.wah={...sound.effects.wah,enabled:true,model:model as TrackSound['effects']['wah']['model']};return sound;
}

it('reads a wah saved before models as the classic and accepts only the native models',()=>{
  expect(defaultEffects().wah.model).toBe('classic');
  const older=wah('classic');delete (older.effects.wah as Partial<TrackSound['effects']['wah']>).model;
  expect(soundProblem(older)).toBeNull();
  expect(completeSound(older).effects.wah.model).toBe('classic');
  for(const model of ['classic','vintage','wide','bass'])expect(soundProblem(wah(model))).toBeNull();
  expect(soundProblem(wah('talk box'))).toBe('Invalid effect parameter.');
  // A wah on a second pedalboard is read and checked the same way.
  const doubled=wah('vintage');doubled.effects.second={...defaultEffects(),wah:{...defaultEffects().wah,enabled:true}};
  delete (doubled.effects.second.wah as Partial<TrackSound['effects']['wah']>).model;
  expect(completeSound(doubled).effects.second!.wah.model).toBe('classic');
  doubled.effects.second.wah.model='talk box' as never;
  expect(soundProblem(doubled)).toBe('Invalid effect parameter.');
});

it('chooses the wah model in the Sound task as one edit, on either pedalboard',()=>{
  const onEdit=vi.fn(),sound=wah('classic');
  const {rerender}=render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  const select=screen.getByLabelText('Wah model');
  expect(select).toHaveValue('classic');
  expect(within(select).getAllByRole('option').map(option=>option.textContent)).toEqual(['Classic','Vintage (vocal)','Wide range','Bass']);
  fireEvent.change(select,{target:{value:'bass'}});
  expect(onEdit).toHaveBeenCalledTimes(1);
  const next:TrackSound=onEdit.mock.calls[0][0].sound;
  expect(next.effects.wah).toEqual({...sound.effects.wah,model:'bass'});
  expect(soundProblem(next)).toBeNull();
  rerender(<SoundPanel trackId="base/0" sound={next} onEdit={onEdit}/>);
  expect(screen.getByLabelText('Wah model')).toHaveValue('bass');
  // The duplicate on the second pedalboard has its own model.
  fireEvent.click(screen.getByRole('button',{name:'Duplicate pedal: Wah'}));
  const doubled:TrackSound=onEdit.mock.calls.at(-1)![0].sound;
  expect(doubled.effects.second!.wah.model).toBe('bass');
  rerender(<SoundPanel trackId="base/0" sound={doubled} onEdit={onEdit}/>);
  fireEvent.change(within(screen.getByRole('region',{name:'Second pedalboard'})).getByLabelText('Second pedalboard: Wah model'),{target:{value:'wide'}});
  const edited:TrackSound=onEdit.mock.calls.at(-1)![0].sound;
  expect(edited.effects.second!.wah.model).toBe('wide');expect(edited.effects.wah.model).toBe('bass');
});

it('keeps the wah model in saved sounds',()=>{
  expect(saveSoundPreset('Vocal wah',wah('vintage')).ok).toBe(true);
  expect(readSoundLibrary()[0].sound.effects.wah.model).toBe('vintage');
});
