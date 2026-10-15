// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,renderHook} from '@testing-library/react';
import {useReferenceSyncEdit} from './useReferenceSyncEdit';
import type {ReferenceEditOptions} from './reference-sync-types';

afterEach(cleanup);
function options(patch:Partial<ReferenceEditOptions>={}):ReferenceEditOptions {
  return {owner:{documentId:'doc',activationId:'active'},document:{documentId:'doc',revision:1},sourceKey:'asset',
    settings:{assetId:'asset',offsetMs:120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}],mix:{gain:1,pan:0,mute:false,solo:false},referenceSync:{entryAudioMs:1120,exitAudioMs:7120}},
    timeline:{generation:1,durationTick:7680,tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,startTick:0,endTick:3840,startMs:0,endMs:2000,meterNumerator:4,meterDenominator:4},{bar:1,occurrence:0,startTick:3840,endTick:7680,startMs:2000,endMs:4000,meterNumerator:4,meterDenominator:4}]},
    durationMs:10000,visible:{number:true,waveform:true},busy:false,beginOperation:vi.fn(()=>vi.fn()),isCurrent:()=>true,onCommit:vi.fn(async()=>{}),...patch};
}

it('previews a detached source endpoint locally and applies one captured command while retaining the lease through settlement',async()=>{
  let finish!:()=>void;const release=vi.fn(),onCommit=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),p=options({beginOperation:vi.fn(()=>release),onCommit});
  const {result,rerender}=renderHook(useReferenceSyncEdit,{initialProps:p});
  act(()=>{expect(result.current.begin('entry','number')).toBe(true);result.current.update(1100);});
  expect(result.current.preview?.referenceSync?.entryAudioMs).toBe(1220);expect(p.settings?.referenceSync?.entryAudioMs).toBe(1120);expect(onCommit).not.toHaveBeenCalled();
  rerender({...p,busy:true});act(()=>result.current.update(1200));expect(result.current.preview?.referenceSync?.entryAudioMs).toBe(1320);
  act(()=>{expect(result.current.begin('exit','waveform')).toBe(false);result.current.commit();result.current.commit();result.current.cancel();});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({referenceSync:{entryAudioMs:1320,exitAudioMs:7120}}),{documentId:'doc',revision:1});expect(release).not.toHaveBeenCalled();
  await act(async()=>finish());expect(release).toHaveBeenCalledOnce();expect(result.current.preview).toBeNull();
});

it('invalid input keeps the last valid plot but cannot commit that plot',()=>{
  const release=vi.fn(),p=options({beginOperation:()=>release}),{result}=renderHook(useReferenceSyncEdit,{initialProps:p});
  act(()=>{result.current.begin('exit','number');result.current.update(7500);result.current.update(NaN);});
  expect(result.current.preview?.referenceSync?.exitAudioMs).toBe(7620);expect(result.current.error).toBeTruthy();
  act(()=>result.current.commit());expect(p.onCommit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
});

it('fractional endpoints that return to their original source coordinate create no history',()=>{
  const p=options();p.settings={...p.settings!,offsetMs:-120,anchors:[],referenceSync:{entryAudioMs:.1,exitAudioMs:7120}};
  const release=vi.fn();p.beginOperation=()=>release;const {result}=renderHook(useReferenceSyncEdit,{initialProps:p});
  act(()=>{result.current.begin('entry','waveform');result.current.update(121.1);result.current.update(120.1);result.current.commit();});
  expect(p.onCommit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
});

it.each(['owner','revision','source','settings','generation','number-hidden','window-blur','unmount'] as const)('%s invalidates a draft without history and releases exactly once',change=>{
  const release=vi.fn(),p=options({beginOperation:()=>release}),view=renderHook(useReferenceSyncEdit,{initialProps:p});
  act(()=>{view.result.current.begin('entry','number');view.result.current.update(1100);});
  if(change==='owner')view.rerender({...p,owner:{...p.owner,activationId:'new'}});
  if(change==='revision')view.rerender({...p,document:{...p.document,revision:2}});
  if(change==='source')view.rerender({...p,sourceKey:'new'});
  if(change==='settings')view.rerender({...p,settings:{...p.settings!,mix:{...p.settings!.mix,gain:.5}}});
  if(change==='generation')view.rerender({...p,timeline:{...p.timeline!,generation:2}});
  if(change==='number-hidden')view.rerender({...p,visible:{number:false,waveform:true}});
  if(change==='window-blur')act(()=>fireEvent(window,new Event('blur')));
  if(change==='unmount')view.unmount();
  act(()=>view.result.current.commit());expect(p.onCommit).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();view.unmount();expect(release).toHaveBeenCalledOnce();
});

it('a hidden competitor does not cancel the initiating surface',()=>{
  const p=options(),{result,rerender}=renderHook(useReferenceSyncEdit,{initialProps:p});act(()=>{result.current.begin('entry','number');result.current.update(1100);});
  rerender({...p,visible:{number:true,waveform:false}});expect(result.current.preview?.referenceSync?.entryAudioMs).toBe(1220);
});

it('stale pending rejection cannot publish an error or release before settlement',async()=>{
  let reject!:(reason:Error)=>void;const release=vi.fn(),p=options({beginOperation:()=>release,onCommit:()=>new Promise<void>((_resolve,no)=>{reject=no;})});
  const {result,rerender}=renderHook(useReferenceSyncEdit,{initialProps:p});act(()=>{result.current.begin('entry','number');result.current.update(1100);result.current.commit();});
  rerender({...p,document:{documentId:'new',revision:1},owner:{documentId:'new',activationId:'new'}});expect(result.current.preview).toBeNull();expect(release).not.toHaveBeenCalled();
  await act(async()=>reject(new Error('Old document failure')));expect(result.current.error).toBeNull();expect(release).toHaveBeenCalledOnce();
});

it.each(['busy','unready','hidden','legacy','stale'] as const)('does not acquire an endpoint lease when %s',condition=>{
  const p=options();if(condition==='busy')p.busy=true;if(condition==='unready')p.durationMs=null;if(condition==='hidden')p.visible.number=false;
  if(condition==='legacy')p.settings={...p.settings!,referenceSync:null};if(condition==='stale')p.isCurrent=()=>false;
  const {result}=renderHook(useReferenceSyncEdit,{initialProps:p});act(()=>expect(result.current.begin('entry','number')).toBe(false));expect(p.beginOperation).not.toHaveBeenCalled();
});
