// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {BackingPanel} from './BackingPanel';
import {defaultMix} from '../document-settings';
import type {BackingCandidate} from './bridge';
const stagingProps={stageBacking:async()=>null,stageEmbeddedBacking:async()=>null,beginOperation:()=>()=>{}};
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
  render(<BackingPanel {...stagingProps} settings={null} assets={{}} onEdit={onEdit} stageBacking={async()=>candidate}/>);
  fireEvent.click(screen.getByRole('button',{name:'Import backing'}));await waitFor(()=>expect(onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{assetId:'asset',offsetMs:0,anchors:[],mix:defaultMix()}},candidate));
});
it('backing synchronization occurrence offset and mixer callbacks retain asset identity',()=>{
  const onEdit=vi.fn();const settings={assetId:'asset',offsetMs:50,anchors:[],mix:defaultMix()};
  render(<BackingPanel {...stagingProps} settings={settings} assets={{asset:{filename:'C:/Music/Clicks.wav',mediaType:'audio/wav',byteLength:40}}} onEdit={onEdit}/>);
  expect(screen.getByText('Clicks.wav')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Backing offset (ms)'),{target:{value:'120'}});expect(onEdit.mock.calls.at(-1)?.[0].backing.offsetMs).toBe(120);
  fireEvent.change(screen.getByLabelText('Anchor occurrence'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Anchor audio (ms)'),{target:{value:'3000'}});fireEvent.click(screen.getByRole('button',{name:'Add anchor'}));expect(onEdit.mock.calls.at(-1)?.[0].backing.anchors).toEqual([{bar:0,occurrence:1,ratio:0,audioMs:3000}]);
  fireEvent.click(screen.getByLabelText('Backing solo'));expect(onEdit.mock.calls.at(-1)?.[0].backing.mix.solo).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Remove backing'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setBacking',backing:null});
});
it('making embedded backing editable preserves its imported synchronization',async()=>{
  const candidate={token:'original',assetId:'asset',info:{filename:'Original.audio',mediaType:'audio/wav',byteLength:40}};
  const staging=vi.fn(async()=>candidate);
  const onEdit=vi.fn(),originalSettings={assetId:'embedded',offsetMs:120,anchors:[{bar:1,occurrence:1,ratio:.25,audioMs:2345}],mix:defaultMix()};
  render(<BackingPanel {...stagingProps} settings={undefined} assets={{}} embedded={new Uint8Array([1,2])} originalSettings={originalSettings} stageEmbeddedBacking={staging} onEdit={onEdit}/>);
  fireEvent.click(screen.getByRole('button',{name:'Edit embedded backing'}));await waitFor(()=>expect(onEdit).toHaveBeenCalledWith({type:'setBacking',backing:{...originalSettings,assetId:'asset'}},candidate));expect(staging).toHaveBeenCalledWith(new Uint8Array([1,2]));
});

it.each(['success','cancel','stage error','edit error'] as const)('holds backing operation through complete %s lifetime',async outcome=>{
  let staged!:(candidate:BackingCandidate|null)=>void,failStage!:(error:Error)=>void,finish!:()=>void,failEdit!:(error:Error)=>void;
  const release=vi.fn(),beginOperation=vi.fn(()=>release),candidate={token:'candidate',assetId:'asset',info:{filename:'one.wav',mediaType:'audio/wav',byteLength:1}};
  const stageBacking=()=>new Promise<BackingCandidate|null>((resolve,reject)=>{staged=resolve;failStage=reject;});
  const onEdit=vi.fn(()=>new Promise<void>((resolve,reject)=>{finish=resolve;failEdit=reject;}));
  render(<BackingPanel {...stagingProps} settings={null} assets={{}} onEdit={onEdit} stageBacking={stageBacking} beginOperation={beginOperation}/>);
  fireEvent.click(screen.getByRole('button',{name:'Import backing'}));expect(beginOperation).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled();
  if(outcome==='stage error')failStage(new Error('Stage failed'));else staged(outcome==='cancel'?null:candidate);
  if(outcome==='success'||outcome==='edit error'){
    await waitFor(()=>expect(onEdit).toHaveBeenCalledOnce());expect(release).not.toHaveBeenCalled();
    if(outcome==='edit error')failEdit(new Error('Edit failed'));else finish();
  }
  await waitFor(()=>expect(release).toHaveBeenCalledOnce());expect(screen.getByRole('button',{name:'Import backing'})).toBeEnabled();
  if(outcome.endsWith('error'))expect(screen.getByRole('alert')).toHaveTextContent(outcome==='stage error'?'Stage failed':'Edit failed');
});
