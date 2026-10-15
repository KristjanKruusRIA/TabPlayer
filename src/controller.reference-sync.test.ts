import {expect,it,vi} from 'vitest';
import {DocumentController} from './controller';
import type {NativeBridge} from './bridge';
import {blankProject,type EditCommand,type Project} from './project';
import {defaultMix} from './document-settings';
import type {BackingSettings} from './edit-types';
import type {DocumentSnapshot} from './workspace/types';
import type {BackingWaveform,NativeBackingWaveformBridge} from './audio/backing-waveform-types';
import {Settings} from '@coderline/alphatab';
import {loadInterchangeScore} from './interchange/gp';

const assetId='a'.repeat(64);
const legacy=():BackingSettings=>({assetId,offsetMs:0,anchors:[],mix:defaultMix()});
const reference=(exit=2000):BackingSettings=>({...legacy(),referenceSync:{entryAudioMs:0,exitAudioMs:exit}});
function project(backing:BackingSettings=legacy()):Project {
  const value=blankProject();if(value.base.kind==='blank')value.base.measureCount=1;
  value.assets[assetId]={filename:'reference.wav',mediaType:'audio/wav',byteLength:44};
  value.edits=[{type:'setBacking',backing}];return value;
}
function harness(value=project()) {
  let current=value,revision=0;
  const record=():DocumentSnapshot=>({documentId:'score-a',revision,snapshot:{project:structuredClone(current),path:null,dirty:false,canUndo:current.edits.length>0,canRedo:true}});
  const bridge:NativeBridge={documentId:'score-a',snapshot:async()=>record(),cancelAsset:vi.fn(async()=>true),
    applyEdit:vi.fn(async command=>{current={...current,edits:[...current.edits,structuredClone(command)]};revision++;return record();}),
    undo:async()=>record(),redo:async()=>record(),saveProject:async()=>null,exportGp:vi.fn(async()=>true),
    readBackingAsset:vi.fn(async()=>new Uint8Array()),askUnsaved:async()=> 'discard',confirmExport:async()=>true};
  return {bridge,create:()=>DocumentController.create(bridge)};
}
function waveform(durationMs=4000) {
  const owner={documentId:'score-a',activationId:'activation-a'};
  const bridge:NativeBackingWaveformBridge={owner,read:vi.fn(async(document,source)=>({owner:{...owner},document:{...document},source:{...source},durationMs,sampleRate:1000,frameCount:durationMs,channels:1,bucketCount:1,peaks:[{min:[0,0],max:[0,0]}]}))};
  return bridge;
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const set=(backing:BackingSettings):EditCommand=>({type:'setBacking',backing});

it('rejects enabling reference timing without a live source metadata binding before native history changes',async()=>{
  const {bridge,create}=harness(),controller=await create(),before=controller.getState();
  await expect(controller.edit(set(reference()))).rejects.toThrow(/waveform|source|reference/i);
  expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);
  expect(controller.getState().score).toBe(before.score);expect(controller.getState().snapshot.canRedo).toBe(true);
});
it('reads current encoded asset metadata before committing and caches only the same binding/source receipt',async()=>{
  const {bridge,create}=harness(),controller=await create(),reader=waveform();
  controller.setReferenceWaveformBridge(reader);
  const gate=deferred<BackingWaveform>();
  vi.mocked(reader.read).mockImplementationOnce(()=>gate.promise);
  const editing=controller.edit(set(reference()));await vi.waitFor(()=>expect(reader.read).toHaveBeenCalledOnce());
  expect(reader.read).toHaveBeenCalledWith({documentId:'score-a',revision:0},{kind:'asset',assetId},1);
  expect(bridge.applyEdit).not.toHaveBeenCalled();
  gate.resolve({owner:reader.owner,document:{documentId:'score-a',revision:0},source:{kind:'asset',assetId},durationMs:4000,sampleRate:1000,frameCount:4000,channels:1,bucketCount:1,peaks:[{min:[0,0],max:[0,0]}]});await editing;
  expect(bridge.applyEdit).toHaveBeenCalledWith(set(reference()),0,undefined);
  await controller.edit(set(reference(3000)));expect(reader.read).toHaveBeenCalledOnce();
  expect(controller.getState().settings.backing?.referenceSync?.exitAudioMs).toBe(3000);
});
it.each(['eof','decoder','foreign receipt'] as const)('rejects %s metadata atomically and preserves redo',async failure=>{
  const {bridge,create}=harness(),controller=await create(),reader=waveform(failure==='eof'?1000:4000),before=controller.getState();
  if(failure==='decoder')reader.read=vi.fn(async()=>{throw new Error('decoder unavailable');});
  if(failure==='foreign receipt'){const original=reader.read;reader.read=vi.fn(async(...args)=>({...await original(...args),document:{documentId:'score-b',revision:0}}));}
  controller.setReferenceWaveformBridge(reader);
  await expect(controller.edit(set(reference()))).rejects.toThrow();
  expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);
  expect(controller.getState().snapshot.canRedo).toBe(true);expect(controller.getState().revision).toBe(0);
});
it.each(['unbind','new activation'] as const)('rejects an in-flight source admission after %s',async change=>{
  const {bridge,create}=harness(),controller=await create(),reader=waveform(),unbind=controller.setReferenceWaveformBridge(reader);
  const gate=deferred<BackingWaveform>(),original=reader.read;vi.mocked(reader.read).mockImplementationOnce(()=>gate.promise);
  const editing=controller.edit(set(reference())),rejected=expect(editing).rejects.toThrow(/current|changed|active|stale/i);
  await vi.waitFor(()=>expect(reader.read).toHaveBeenCalledOnce());
  if(change==='unbind')unbind();else controller.setReferenceWaveformBridge({...waveform(),owner:{documentId:'score-a',activationId:'activation-b'}});
  gate.resolve(await original({documentId:'score-a',revision:0},{kind:'asset',assetId},1));await rejected;
  expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().revision).toBe(0);
});
it('old cleanup cannot remove a newer lifetime binding',async()=>{
  const {create}=harness(),controller=await create(),first=waveform(),second=waveform(),oldCleanup=controller.setReferenceWaveformBridge(first);
  controller.setReferenceWaveformBridge(second);oldCleanup();await controller.edit(set(reference()));
  expect(first.read).not.toHaveBeenCalled();expect(second.read).toHaveBeenCalledOnce();
});
it('does not decode for reference mix-only updates or an exact no-op',async()=>{
  const {bridge,create}=harness(project(reference())),controller=await create(),before=controller.getState();
  await controller.edit(set(reference()));expect(bridge.applyEdit).not.toHaveBeenCalled();
  expect(controller.getState().snapshot).toBe(before.snapshot);
  const backing=reference();backing.mix.gain=.5;await controller.edit(set(backing));
  expect(bridge.applyEdit).toHaveBeenCalledOnce();expect(controller.getState().settings.backing?.mix.gain).toBe(.5);
});
it('checks a captured revision inside the serialized queue before conversion can overwrite intervening music',async()=>{
  const {bridge,create}=harness(),controller=await create();
  const first=controller.edit({type:'setScoreInfo',title:'Changed',artist:'',tempo:120});
  const stale=controller.editAtRevision(set(reference()),{documentId:'score-a',revision:0});
  const rejected=expect(stale).rejects.toThrow(/revision|changed|stale/i);await first;await rejected;
  expect(bridge.applyEdit).toHaveBeenCalledOnce();expect(controller.getState().score.title).toBe('Changed');
  expect(controller.getState().revision).toBe(1);
});
it('does not activate reference timing for an asset still being staged',async()=>{
  const {bridge,create}=harness(),controller=await create(),reader=waveform();controller.setReferenceWaveformBridge(reader);
  const staged={token:'staged',assetId:'b'.repeat(64),info:{filename:'new.wav',mediaType:'audio/wav',byteLength:44}};
  await expect(controller.edit(set({...reference(),assetId:staged.assetId}),staged)).rejects.toThrow(/commit|import|asset/i);
  expect(reader.read).not.toHaveBeenCalled();expect(bridge.applyEdit).not.toHaveBeenCalled();expect(bridge.cancelAsset).toHaveBeenCalledWith('staged');
});
it('direct GP export reads the committed current backing and projects physical timing without changing history',async()=>{
  const {bridge,create}=harness(project(reference())),controller=await create(),before=controller.getState(),bytes=new Uint8Array([82,73,70,70,9,8,7]);
  vi.mocked(bridge.readBackingAsset).mockResolvedValue(bytes);
  await controller.export();
  expect(bridge.readBackingAsset).toHaveBeenCalledWith(assetId,0);
  const exported=loadInterchangeScore(vi.mocked(bridge.exportGp).mock.calls[0][0],new Settings());
  expect(exported.backingTrack?.rawAudioFile).toEqual(bytes);
  expect(exported.masterBars[0].syncPoints?.map(point=>point.syncPointValue?.millisecondOffset)).toEqual([0,2000]);
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);
  expect(bridge.applyEdit).not.toHaveBeenCalled();expect(bridge.exportGp).toHaveBeenCalledWith(expect.any(Uint8Array),0);
});
it('a failed current-backing read prevents direct GP publication',async()=>{
  const {bridge,create}=harness(),controller=await create();vi.mocked(bridge.readBackingAsset).mockRejectedValue(new Error('stale asset revision'));
  await expect(controller.export()).rejects.toThrow('stale asset revision');expect(bridge.exportGp).not.toHaveBeenCalled();
  expect(controller.getState().revision).toBe(0);expect(controller.getState().snapshot.canRedo).toBe(true);
});
it('an identical full authored tempo replacement preserves native redo and score identity',async()=>{
  const {bridge,create}=harness(),controller=await create(),before=controller.getState();
  await controller.editAtRevision({type:'replaceTempoAutomations',points:[{bar:0,ratio:0,bpm:120,linear:false}]},{documentId:'score-a',revision:0});
  expect(bridge.applyEdit).not.toHaveBeenCalled();expect(controller.getState().snapshot).toBe(before.snapshot);
  expect(controller.getState().score).toBe(before.score);expect(controller.getState().snapshot.canRedo).toBe(true);
});
it.each([false,true])('normalizes omitted/null legacy timing without discarding redo (stored null=%s)',async storedNull=>{
  const original=legacy(),next=legacy();if(storedNull)original.referenceSync=null;else next.referenceSync=null;
  const {bridge,create}=harness(project(original)),controller=await create(),before=controller.getState();
  await controller.edit(set(next));expect(bridge.applyEdit).not.toHaveBeenCalled();
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);
  expect(controller.getState().snapshot.canRedo).toBe(true);
});
