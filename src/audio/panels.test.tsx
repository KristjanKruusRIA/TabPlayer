// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {BackingPanel} from './BackingPanel';
import {defaultMix} from '../document-settings';
import {nativeAudioBridge} from './bridge';
afterEach(cleanup);
it('sound preset callbacks persist the complete finite effect settings',()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Sound preset'),{target:{value:'lead'}});
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackSound',trackId:'base/0',sound:soundPreset('lead')});
  fireEvent.change(screen.getByLabelText('Sound source'),{target:{value:'black-guitar'}});expect(onEdit.mock.calls.at(-1)?.[0].sound.voiceId).toBe('black-guitar');
  fireEvent.click(screen.getByLabelText('Enable chorus'));expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.chorus.enabled).toBe(true);
});
it('backing import stages a transactional candidate and removal explicitly selects score-only',async()=>{
  const onEdit=vi.fn();const candidate={token:'staged',assetId:'asset',info:{filename:'Clicks.wav',mediaType:'audio/wav',byteLength:40},durationMs:1000};
  render(<BackingPanel settings={null} assets={{}} onEdit={onEdit} stageBacking={async()=>candidate}/>);
  fireEvent.click(screen.getByRole('button',{name:'Import backing'}));await waitFor(()=>expect(onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{assetId:'asset',offsetMs:0,anchors:[],mix:defaultMix()}},candidate));
});
it('backing synchronization occurrence offset and mixer callbacks retain asset identity',()=>{
  const onEdit=vi.fn();const settings={assetId:'asset',offsetMs:50,anchors:[],mix:defaultMix()};
  render(<BackingPanel settings={settings} assets={{asset:{filename:'C:/Music/Clicks.wav',mediaType:'audio/wav',byteLength:40}}} onEdit={onEdit}/>);
  expect(screen.getByText('Clicks.wav')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Backing offset (ms)'),{target:{value:'120'}});expect(onEdit.mock.calls.at(-1)?.[0].backing.offsetMs).toBe(120);
  fireEvent.change(screen.getByLabelText('Anchor occurrence'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Anchor audio (ms)'),{target:{value:'3000'}});fireEvent.click(screen.getByRole('button',{name:'Add anchor'}));expect(onEdit.mock.calls.at(-1)?.[0].backing.anchors).toEqual([{bar:0,occurrence:1,ratio:0,audioMs:3000}]);
  fireEvent.click(screen.getByLabelText('Backing solo'));expect(onEdit.mock.calls.at(-1)?.[0].backing.mix.solo).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Remove backing'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setBacking',backing:null});
});
it('making embedded backing editable preserves its imported synchronization',async()=>{
  const candidate={token:'original',assetId:'asset',info:{filename:'Original.audio',mediaType:'audio/wav',byteLength:40}};
  const staging=vi.spyOn(nativeAudioBridge,'stageEmbeddedBacking').mockResolvedValue(candidate);
  const onEdit=vi.fn(),originalSettings={assetId:'embedded',offsetMs:120,anchors:[{bar:1,occurrence:1,ratio:.25,audioMs:2345}],mix:defaultMix()};
  render(<BackingPanel settings={undefined} assets={{}} embedded={new Uint8Array([1,2])} originalSettings={originalSettings} onEdit={onEdit}/>);
  fireEvent.click(screen.getByRole('button',{name:'Edit embedded backing'}));await waitFor(()=>expect(onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{...originalSettings,assetId:'asset'}},candidate));staging.mockRestore();
});
