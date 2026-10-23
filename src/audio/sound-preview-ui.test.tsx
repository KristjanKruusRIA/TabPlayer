// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {deleteSoundPreset,forgetSessionSoundLibrary,saveSoundPreset} from './sound-library';
import type {NativePlaybackController} from './NativePlaybackController';
import type {TrackSound} from '../edit-types';
beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();forgetSessionSoundLibrary();localStorage.clear();});

/** A stand-in for the native playback controller's preview and device surface. */
function playback(){
  let preview:{track:string;sound:TrackSound}|null=null;const listeners=new Set<()=>void>();let state={};
  const fake={
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},getState:()=>state,
    devices:vi.fn(async()=>[]),deviceId:()=>null,selectDevice:vi.fn(),
    soundPreview:()=>preview,
    /** Ends the preview as the controller does when its track or document goes away. */
    drop:()=>{preview=null;state={};listeners.forEach(listener=>listener());},
    previewSound:vi.fn(async(track:string,sound:TrackSound|null)=>{preview=sound?{track,sound:structuredClone(sound)}:null;state={};listeners.forEach(listener=>listener());}),
  };
  return fake;
}
const panel=(trackId:string,sound:TrackSound,onEdit:Parameters<typeof SoundPanel>[0]['onEdit'],fake:ReturnType<typeof playback>,shown=true)=><SoundPanel trackId={trackId} sound={sound} onEdit={onEdit} playback={fake as unknown as NativePlaybackController} shown={shown}/>;

it('previews factory presets and saved sounds without recording an edit, and cancels back to the track sound',async()=>{
  const crunch=soundPreset('crunch');crunch.effects.tremolo.enabled=true;saveSoundPreset('Wobble',crunch);
  const own=soundPreset('clean','green-guitar'),onEdit=vi.fn(),fake=playback();
  render(panel('base/0',own,onEdit,fake));
  const preview=screen.getByLabelText('Preview sound');
  expect([...preview.querySelectorAll('optgroup')].map(group=>group.label)).toEqual(['Factory presets','My sounds']);
  await act(async()=>{fireEvent.change(preview,{target:{value:'preset:lead'}});});
  // A factory preset keeps the track's instrument voice.
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',soundPreset('lead','green-guitar'));
  expect(screen.getByRole('status')).toHaveTextContent('Previewing Lead. Keep it or cancel to go back to this track’s sound.');
  await act(async()=>{fireEvent.change(preview,{target:{value:'saved:Wobble'}});});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',crunch);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel preview'}));});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'Keep previewed sound'})).toBeNull();
  expect(screen.getByLabelText('Preview sound')).toHaveValue('');
});

it('keeps a previewed sound as one undoable edit',async()=>{
  const onEdit=vi.fn(),fake=playback();render(panel('base/0',soundPreset('gm'),onEdit,fake));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value:'preset:bass'}});});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Keep previewed sound'}));});
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0]).toEqual({type:'setTrackSound',trackId:'base/0',sound:soundPreset('bass')});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);
  expect(screen.getByRole('status')).toHaveTextContent('Kept Bass.');
});

it('ends a preview when the track changes, the panel closes or the sound is edited',async()=>{
  const onEdit=vi.fn(),fake=playback();const {rerender,unmount}=render(panel('base/0',soundPreset('gm'),onEdit,fake));
  const choose=async(value:string)=>{await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value}});});};
  await choose('preset:lead');
  await act(async()=>{rerender(panel('base/1',soundPreset('bass'),onEdit,fake));});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);
  expect(screen.queryByRole('button',{name:'Cancel preview'})).toBeNull();
  await choose('preset:crunch');
  // Editing the sound while previewing ends the preview first, so the edit is heard.
  await act(async()=>{fireEvent.click(screen.getByLabelText('Enable tremolo'));});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/1',null);
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit.mock.calls[0][0].sound.effects.tremolo.enabled).toBe(true);
  await choose('preset:clean');
  await act(async()=>{unmount();});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/1',null);
});

it('reports a refused preview and offers no preview without native playback',async()=>{
  const onEdit=vi.fn(),fake=playback();fake.previewSound.mockRejectedValueOnce(new Error('Select an existing track.'));
  render(panel('base/0',soundPreset('gm'),onEdit,fake));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value:'preset:lead'}});});
  expect(screen.getByRole('alert')).toHaveTextContent('Select an existing track.');
  expect(screen.queryByRole('button',{name:'Keep previewed sound'})).toBeNull();
  cleanup();render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  expect(screen.queryByLabelText('Preview sound')).toBeNull();
});

it('drops a preview result that arrives after the track changed or the preview was canceled',async()=>{
  const onEdit=vi.fn(),fake=playback();let release!:()=>void;
  const real=fake.previewSound.getMockImplementation()!;
  fake.previewSound.mockImplementationOnce(async(track,sound)=>{await real(track,sound);await new Promise<void>(resolve=>{release=resolve;});});
  const {rerender}=render(panel('base/0',soundPreset('gm'),onEdit,fake));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value:'preset:lead'}});});
  await act(async()=>{rerender(panel('base/1',soundPreset('bass'),onEdit,fake));});
  await act(async()=>{release();});
  expect(fake.soundPreview()).toBeNull();
  expect(screen.queryByRole('group',{name:'Sound preview'})).toBeNull();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  expect(screen.getByLabelText('Preview sound')).toHaveValue('');
});

it('hides Keep and Cancel when the player ends the preview itself, and ends it when the Sound task is hidden',async()=>{
  const onEdit=vi.fn(),fake=playback();const {rerender}=render(panel('base/0',soundPreset('gm'),onEdit,fake));
  const choose=async(value:string)=>{await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value}});});};
  await choose('preset:lead');
  act(()=>fake.drop());
  expect(screen.queryByRole('group',{name:'Sound preview'})).toBeNull();expect(screen.getByLabelText('Preview sound')).toHaveValue('');
  // The next ordinary edit does not report a preview ending.
  await act(async()=>{fireEvent.click(screen.getByLabelText('Enable tremolo'));});
  expect(screen.getByRole('status')).not.toHaveTextContent('Preview ended.');expect(onEdit).toHaveBeenCalledTimes(1);onEdit.mockClear();
  await choose('preset:crunch');
  await act(async()=>{rerender(panel('base/0',soundPreset('gm'),onEdit,fake,false));});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);expect(fake.soundPreview()).toBeNull();
  expect(onEdit).not.toHaveBeenCalled();
});

it('cancels with Escape, returns focus to the list, and keeps a deleted saved sound named',async()=>{
  saveSoundPreset('Wobble',soundPreset('crunch'));
  const onEdit=vi.fn(),fake=playback();render(panel('base/0',soundPreset('gm'),onEdit,fake));
  const select=screen.getByLabelText('Preview sound');
  await act(async()=>{fireEvent.change(select,{target:{value:'saved:Wobble'}});});
  act(()=>{deleteSoundPreset('Wobble');});
  expect(select).toHaveValue('saved:Wobble');expect(screen.getByRole('option',{name:'“Wobble” (no longer saved)'})).toBeDisabled();
  screen.getByRole('button',{name:'Cancel preview'}).focus();
  await act(async()=>{fireEvent.keyDown(screen.getByRole('group',{name:'Sound preview'}),{key:'Escape'});});
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);expect(select).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Back to this track’s sound.');
});

it('records edits made during a preview at once and in order',async()=>{
  const onEdit=vi.fn(),fake=playback();render(panel('base/0',soundPreset('gm'),onEdit,fake));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Preview sound'),{target:{value:'preset:lead'}});});
  const rate=screen.getByLabelText('tremolo Rate (Hz)');
  act(()=>{fireEvent.change(rate,{target:{value:'6'}});fireEvent.change(rate,{target:{value:'7'}});});
  expect(onEdit.mock.calls.map(call=>call[0].sound.effects.tremolo.rateHz)).toEqual([6,7]);
  expect(fake.previewSound).toHaveBeenLastCalledWith('base/0',null);
  expect(screen.getByRole('status')).toHaveTextContent('Preview ended.');
});

it('offers no preview when the player cannot preview sounds',()=>{
  const fake=playback() as Partial<ReturnType<typeof playback>>;delete fake.soundPreview;delete fake.previewSound;
  render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={vi.fn()} playback={fake as unknown as NativePlaybackController}/>);
  expect(screen.queryByLabelText('Preview sound')).toBeNull();
});
