// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {StrictMode} from 'react';
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {useBackingWaveform} from './useBackingWaveform';
import type {BackingWaveform,NativeBackingWaveformBridge,WaveformSourceInput} from './backing-waveform-types';
import type {DocumentRevision} from '../workspace/types';

const owner={documentId:'doc',activationId:'active'},document={documentId:'doc',revision:1};
const source:WaveformSourceInput={kind:'asset',assetId:'a'};
function receipt(doc:DocumentRevision=document,input:WaveformSourceInput=source):BackingWaveform {
  const identity=input.kind==='asset'?input:{kind:'embedded' as const,sourceKey:input.sourceKey,sha256:input.sha256};
  return {owner,document:doc,source:identity,durationMs:1000,sampleRate:1000,frameCount:1000,channels:1,bucketCount:2,peaks:[{min:[-.5,-.5],max:[1,1]},{min:[0,0],max:[.25,.25]}]};
}
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
afterEach(cleanup);

it('one_source_cache_ignores_clock_and_reuses_after_anchor_edit',async()=>{
  const read=vi.fn(async(doc:DocumentRevision,input:WaveformSourceInput)=>receipt(doc,input));
  const bridge:NativeBackingWaveformBridge={owner,read};
  const props={bridge,document,source,enabled:false};
  const hook=renderHook(useBackingWaveform,{initialProps:props});expect(read).not.toHaveBeenCalled();
  hook.rerender({...props,enabled:true});await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));
  const data=hook.result.current.data;expect(read).toHaveBeenCalledWith(document,source,8192);
  for(let revision=2;revision<=5;revision++)hook.rerender({...props,document:{...document,revision},enabled:true});
  expect(hook.result.current.data).toBe(data);expect(read).toHaveBeenCalledOnce();
  hook.rerender({...props,document:{...document,revision:5},enabled:false});
  hook.rerender({...props,document:{...document,revision:5},enabled:true});
  expect(hook.result.current.kind).toBe('ready');expect(read).toHaveBeenCalledOnce();
});

it('stale_reads_coalesce_and_never_flash_old_data',async()=>{
  const first=deferred<BackingWaveform>(),latest=deferred<BackingWaveform>();
  const read=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const props={bridge:{owner,read},document,source,enabled:true};
  const hook=renderHook(useBackingWaveform,{initialProps:props});await waitFor(()=>expect(read).toHaveBeenCalledOnce());
  hook.rerender({...props,document:{...document,revision:2},source:{kind:'asset',assetId:'b'}});
  hook.rerender({...props,document:{...document,revision:3},source:{kind:'asset',assetId:'c'}});
  expect(hook.result.current.data).toBeNull();expect(read).toHaveBeenCalledOnce();
  await act(async()=>first.resolve(receipt()));
  await waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenLastCalledWith({...document,revision:3},{kind:'asset',assetId:'c'},8192);
  expect(hook.result.current.data).toBeNull();
  await act(async()=>latest.resolve(receipt({...document,revision:3},{kind:'asset',assetId:'c'})));
  expect(hook.result.current.data?.source).toEqual({kind:'asset',assetId:'c'});
  hook.rerender({...props,source:{kind:'asset',assetId:'d'},enabled:false});
  expect(hook.result.current.data).toBeNull();expect(read).toHaveBeenCalledTimes(2);
});

it.each(['owner','document','source'] as const)('rejects a mismatched %s receipt and retries the current identity',async field=>{
  const wrong={...receipt(),[field]:field==='owner'?{...owner,activationId:'wrong'}:field==='document'?{...document,revision:9}:{kind:'asset',assetId:'wrong'}};
  const read=vi.fn().mockResolvedValueOnce(wrong).mockResolvedValueOnce(receipt());
  const hook=renderHook(useBackingWaveform,{initialProps:{bridge:{owner,read},document,source,enabled:true}});
  await waitFor(()=>expect(hook.result.current.kind).toBe('error'));expect(hook.result.current.data).toBeNull();
  act(()=>hook.result.current.retry());await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));expect(read).toHaveBeenCalledTimes(2);
});

it('activation changes invalidate a completed cache and obsolete errors stay hidden',async()=>{
  const pending=deferred<BackingWaveform>(),read=vi.fn().mockResolvedValueOnce(receipt()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({...receipt(),owner:{...owner,activationId:'next'}});
  const bridge={owner,read},props={bridge,document,source,enabled:true};
  const hook=renderHook(useBackingWaveform,{initialProps:props});await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));
  hook.rerender({...props,source:{kind:'asset',assetId:'b'}});expect(hook.result.current.data).toBeNull();
  await waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  hook.rerender({...props,bridge:{owner:{...owner,activationId:'next'},read}});
  await act(async()=>pending.reject(new Error('obsolete')));
  await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));expect(hook.result.current.error).toBeNull();
});

it('embedded identity excludes input bytes and unmount never launches queued reads',async()=>{
  const embedded:WaveformSourceInput={kind:'embedded',sourceKey:'a'.repeat(64),sha256:'b'.repeat(64),bytesBase64:'AQ=='};
  const pending=deferred<BackingWaveform>(),read=vi.fn(()=>pending.promise),props={bridge:{owner,read},document,source:embedded,enabled:true};
  const hook=renderHook(useBackingWaveform,{initialProps:props});await waitFor(()=>expect(read).toHaveBeenCalledOnce());
  await act(async()=>pending.resolve(receipt(document,embedded)));expect(hook.result.current.kind).toBe('ready');
  hook.rerender({...props,source:{...embedded,bytesBase64:'AQ=='},document:{...document,revision:2}});expect(read).toHaveBeenCalledOnce();
  hook.unmount();
  const next=deferred<BackingWaveform>(),nextRead=vi.fn(()=>next.promise);
  const second=renderHook(useBackingWaveform,{initialProps:{...props,bridge:{owner,read:nextRead}}});
  await waitFor(()=>expect(nextRead).toHaveBeenCalledOnce());
  second.rerender({...props,bridge:{owner,read:nextRead},document:{...document,revision:3}});second.unmount();
  await act(async()=>next.resolve(receipt(document,embedded)));expect(nextRead).toHaveBeenCalledOnce();
});

it('a source roundtrip retires the earlier request generation',async()=>{
  const old=deferred<BackingWaveform>(),fresh=deferred<BackingWaveform>(),read=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const props={bridge:{owner,read},document,source,enabled:true},hook=renderHook(useBackingWaveform,{initialProps:props});
  await waitFor(()=>expect(read).toHaveBeenCalledOnce());
  hook.rerender({...props,source:{kind:'asset',assetId:'b'}});hook.rerender(props);
  await act(async()=>old.resolve(receipt()));
  expect(hook.result.current.data).toBeNull();await waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  await act(async()=>fresh.resolve(receipt()));expect(hook.result.current.kind).toBe('ready');
});

it('pending revisions coalesce even when the immutable source stays the same',async()=>{
  const old=deferred<BackingWaveform>(),fresh=deferred<BackingWaveform>(),read=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const props={bridge:{owner,read},document,source,enabled:true},hook=renderHook(useBackingWaveform,{initialProps:props});
  await waitFor(()=>expect(read).toHaveBeenCalledOnce());
  hook.rerender({...props,document:{...document,revision:2}});hook.rerender({...props,document:{...document,revision:3}});
  await act(async()=>old.reject(new Error('old revision')));await waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
  expect(hook.result.current.error).toBeNull();expect(read).toHaveBeenLastCalledWith({...document,revision:3},source,8192);
  await act(async()=>fresh.resolve(receipt({...document,revision:3})));expect(hook.result.current.kind).toBe('ready');
});

it('unmount before the dispatch microtask starts no native read',async()=>{
  const read=vi.fn(async()=>receipt()),hook=renderHook(useBackingWaveform,{initialProps:{bridge:{owner,read},document,source,enabled:true}});
  expect(read).not.toHaveBeenCalled();hook.unmount();
  await act(async()=>{await Promise.resolve();});expect(read).not.toHaveBeenCalled();
});

it('Strict Effects replay starts only one live native read',async()=>{
  const read=vi.fn(async()=>receipt()),hook=renderHook(useBackingWaveform,{initialProps:{bridge:{owner,read},document,source,enabled:true},wrapper:StrictMode});
  await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));
  expect(read).toHaveBeenCalledOnce();expect(hook.result.current.data?.source).toEqual(source);
});

it('hiding before dispatch defers its native read until the view is visible',async()=>{
  const read=vi.fn(async()=>receipt()),props={bridge:{owner,read},document,source,enabled:true},hook=renderHook(useBackingWaveform,{initialProps:props});
  hook.rerender({...props,enabled:false});await act(async()=>{await Promise.resolve();});expect(read).not.toHaveBeenCalled();
  hook.rerender(props);await waitFor(()=>expect(hook.result.current.kind).toBe('ready'));expect(read).toHaveBeenCalledOnce();
});
