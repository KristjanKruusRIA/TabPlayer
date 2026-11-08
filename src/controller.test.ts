import { expect, it, vi } from 'vitest';
import { DocumentController } from './controller';
import { importer } from '@coderline/alphatab';
import { buildScore } from './engine';
import { blankProject, type EditCommand, type Project, type ProjectSnapshot } from './project';
import { defaultEffects } from './document-settings';
import { invoke } from '@tauri-apps/api/core';
import { createDocumentBridge, nativeWorkspaceBridge, type NativeBridge } from './bridge';
import type { DocumentSnapshot } from './workspace/types';
import type { SyncAnchor } from './edit-types';
import { scoreFromMusicClip } from './editor/clipboard-source';
import { ClipboardStore } from './editor/ClipboardStore';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>true)}));

function makeBridge(project:Project=blankProject(),redoHistory:EditCommand[]=[]) {
  let current: ProjectSnapshot = {project,canUndo:project.edits.length>0,canRedo:redoHistory.length>0,dirty:false,path:null};
  let undone:EditCommand[]=[...redoHistory];
  let revision=0;
  const snapshot=():DocumentSnapshot=>({documentId:'document-a',revision,snapshot:{...structuredClone(current),redoEdit:structuredClone(undone.at(-1) ?? null)}});
  const bridge: NativeBridge = {
    documentId:'document-a',snapshot: vi.fn(async () => snapshot()),cancelAsset:vi.fn(async()=>true),
    readBackingAsset:async(_assetId:string,_revision:number):Promise<Uint8Array>=>{throw new Error('Backing asset reads are not implemented.');},
    applyEdit: vi.fn(async command => { undone=[];current={...current,project:{...current.project,edits:[...current.project.edits,command]},canUndo:true,canRedo:false,dirty:true}; revision++;return snapshot(); }),
    undo: async () => { const edits=current.project.edits.slice();undone.push(edits.pop()!);current={...current,project:{...current.project,edits},canUndo:edits.length>0,canRedo:true,dirty:edits.length>0};revision++;return snapshot(); },
    redo: async () => { const edits=[...current.project.edits,undone.pop()!];current={...current,project:{...current.project,edits},canUndo:true,canRedo:undone.length>0,dirty:true};revision++;return snapshot(); },
    setLock:vi.fn() as never,saveProject: vi.fn(async () => null), exportGp: async () => false,
    askUnsaved: async () => 'discard', confirmExport: async () => true,
  };
  return bridge;
}

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

it('first user edit undo and redo never crosses a template baseline',async()=>{
  const project={...blankProject(),baselineEdits:[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5}] as EditCommand[]};
  const baseline=structuredClone(project.baselineEdits),bridge=makeBridge(project),controller=await DocumentController.create(bridge);
  const fret=()=>controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret;
  expect(fret()).toBe(5);expect(controller.getState().snapshot.canUndo).toBe(false);
  await controller.undo();expect(bridge.applyEdit).not.toHaveBeenCalled();expect(fret()).toBe(5);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});expect(fret()).toBe(7);
  await controller.undo();expect(fret()).toBe(5);expect(controller.getState().snapshot.canUndo).toBe(false);expect(controller.getState().snapshot.project.edits).toEqual([]);
  await controller.redo();expect(fret()).toBe(7);expect(controller.getState().snapshot.project.edits).toHaveLength(1);expect(controller.getState().snapshot.project.baselineEdits).toEqual(baseline);expect(project.baselineEdits).toEqual(baseline);
});

it('controller_keeps_origin_revision_and_pending_count',async()=>{
  const bridge=makeBridge(),initial=await bridge.snapshot();vi.mocked(bridge.snapshot).mockClear();
  const controller=await DocumentController.create(bridge,undefined,initial);
  expect(bridge.snapshot).not.toHaveBeenCalled();
  expect(controller.getState()).toMatchObject({documentId:'document-a',revision:0});
  const original=bridge.applyEdit,release=deferred<void>();
  bridge.applyEdit=vi.fn(async(...args:Parameters<NativeBridge['applyEdit']>)=>{await release.promise;return original(...args);});
  const undo=vi.spyOn(bridge,'undo'),redo=vi.spyOn(bridge,'redo');
  const first:EditCommand={type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7};
  const second:EditCommand={type:'setNote',target:first.target,string:5,fret:5};
  const editing=controller.edit(first),queued=controller.edit(second);
  expect(controller.hasPendingActions()).toBe(true);
  let idle=false;const waiting=controller.whenIdle().then(()=>{idle=true;});
  await Promise.resolve();expect(idle).toBe(false);
  release.resolve();await editing;
  expect(controller.hasPendingActions()).toBe(true);
  await queued;await waiting;
  expect(controller.hasPendingActions()).toBe(false);expect(idle).toBe(true);
  expect(bridge.applyEdit).toHaveBeenNthCalledWith(1,first,0,undefined);
  expect(bridge.applyEdit).toHaveBeenNthCalledWith(2,second,1,undefined);
  await controller.undo();await controller.redo();
  expect(undo).toHaveBeenCalledWith(2);expect(redo).toHaveBeenCalledWith(3);
  bridge.saveProject=vi.fn(async()=>({documentId:'document-a',revision:5,snapshot:{...controller.getState().snapshot,dirty:false,path:'saved.tabplayer'}}));
  await controller.save(true);
  expect(bridge.saveProject).toHaveBeenCalledWith(true,4);
  expect(controller.getState()).toMatchObject({documentId:'document-a',revision:5,snapshot:{dirty:false,path:'saved.tabplayer'}});
  bridge.exportGp=vi.fn(async()=>true);await controller.export();
  expect(vi.mocked(bridge.exportGp).mock.calls[0][1]).toBe(5);
});

it.each(['initial','fetch','edit','undo','redo','save'] as const)('rejects a foreign %s record before publishing document state',async operation=>{
  const note:EditCommand={type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7};
  const bridge=makeBridge({...blankProject(),edits:operation==='undo'?[note]:[]},operation==='redo'?[note]:[]);
  const initial=await bridge.snapshot(),foreign={...initial,documentId:'document-b',revision:22},beforeChange=vi.fn();
  if(operation==='initial') {await expect(DocumentController.create(bridge,beforeChange,foreign)).rejects.toThrow(/document/i);return;}
  if(operation==='fetch') {bridge.snapshot=async()=>foreign;await expect(DocumentController.create(bridge)).rejects.toThrow(/document/i);return;}
  const controller=await DocumentController.create(bridge,beforeChange,initial),before=controller.getState();
  bridge.applyEdit=async()=>foreign;bridge.undo=async()=>foreign;bridge.redo=async()=>foreign;bridge.saveProject=async()=>foreign;
  await expect(operation==='edit'?controller.edit(note):operation==='save'?controller.save():controller[operation]()).rejects.toThrow(/document/i);
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);
  expect(controller.getState().revision).toBe(before.revision);expect(beforeChange).not.toHaveBeenCalled();
  expect(controller.hasPendingActions()).toBe(false);await controller.whenIdle();
});

it('blocks new ordinary actions during a workspace transition and permits the addressed close save',async()=>{
  let transitioning=false;
  const bridge=makeBridge(),initial=await bridge.snapshot(),controller=await DocumentController.create(bridge,undefined,initial,()=>transitioning);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  const before=controller.getState();transitioning=true;
  const actions=[()=>controller.edit({type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}),()=>controller.undo(),()=>controller.redo(),()=>controller.save(),()=>controller.export(),()=>controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack'),()=>controller.cutMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack')];
  for(const action of actions) {await expect(action()).rejects.toThrow(/wait|transition|finish/i);expect(controller.hasPendingActions()).toBe(false);}
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);
  bridge.askUnsaved=vi.fn(async()=> 'save' as const);
  bridge.saveProject=vi.fn(async()=>({documentId:'document-a',revision:2,snapshot:{...before.snapshot,dirty:false,path:'saved.tabplayer'}}));
  const closing=controller.requestClose();expect(controller.hasPendingActions()).toBe(true);expect(await closing).toBe(true);
  expect(bridge.askUnsaved).toHaveBeenCalledWith('Untitled',null);expect(bridge.saveProject).toHaveBeenCalledWith(false,1);
  expect(controller.getState().revision).toBe(2);expect(controller.getState().snapshot.dirty).toBe(false);
  transitioning=false;await controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');expect(controller.hasPendingActions()).toBe(false);
});

it('a failed save preserves the score, snapshot and native redo command',async()=>{
  const note:EditCommand={type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7};
  const bridge=makeBridge(blankProject(),[note]),beforeChange=vi.fn(),controller=await DocumentController.create(bridge,beforeChange),before=controller.getState();
  bridge.saveProject=async()=>{throw new Error('disk unavailable');};
  await expect(controller.save()).rejects.toThrow('disk unavailable');
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);
  expect(controller.getState().revision).toBe(0);expect(beforeChange).not.toHaveBeenCalled();
  await controller.redo();expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(7);
});

it('retains the pending reservation and queue after the first overlapping action fails',async()=>{
  const bridge=makeBridge(),controller=await DocumentController.create(bridge),release=deferred<void>(),original=bridge.applyEdit;
  bridge.applyEdit=vi.fn().mockImplementationOnce(async()=>{await release.promise;throw new Error('native rejected');}).mockImplementation(original);
  const first=controller.edit({type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}});
  const rejected=expect(first).rejects.toThrow('native rejected');
  const second=controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  const pendingAtFailure:boolean[]=[];controller.subscribe(()=>{if(controller.getState().error)pendingAtFailure.push(controller.hasPendingActions());});
  expect(controller.hasPendingActions()).toBe(true);release.resolve();await rejected;
  await controller.whenIdle();await second;
  expect(pendingAtFailure).toEqual([true,true]);expect(controller.hasPendingActions()).toBe(false);
  expect(controller.getState().revision).toBe(1);expect(controller.getState().snapshot.project.edits).toHaveLength(1);
  expect(vi.mocked(bridge.applyEdit).mock.calls.map(call=>call[1])).toEqual([0,0]);
});

it('retains its local redo command when a native commit fails',async()=>{
  const bridge=makeBridge(),beforeChange=vi.fn(),controller=await DocumentController.create(bridge,beforeChange),nativeUndo=bridge.undo,nativeRedo=bridge.redo;
  bridge.undo=async revision=>{const record=await nativeUndo(revision);delete record.snapshot.redoEdit;return record;};
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});await controller.undo();
  const before=controller.getState();beforeChange.mockClear();
  bridge.redo=async()=>{throw new Error('native rejected');};await expect(controller.redo()).rejects.toThrow('native rejected');
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);expect(beforeChange).not.toHaveBeenCalled();
  bridge.redo=nativeRedo;await controller.redo();expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(7);
  expect(beforeChange).toHaveBeenCalledOnce();
});

it('addresses a dirty close prompt with the current title and path and retains state after failed Save',async()=>{
  const project=blankProject();if(project.base.kind==='blank') project.base.title='Second score';
  const bridge=makeBridge(project),initial=await bridge.snapshot();initial.snapshot.path='C:/scores/second.tabplayer';initial.snapshot.dirty=true;
  const controller=await DocumentController.create(bridge,undefined,initial),before=controller.getState();
  bridge.askUnsaved=vi.fn(async()=> 'save' as const);bridge.saveProject=vi.fn(async()=>{throw new Error('disk unavailable');});
  await expect(controller.requestClose()).rejects.toThrow('disk unavailable');
  expect(bridge.askUnsaved).toHaveBeenCalledWith('Second score','C:/scores/second.tabplayer');expect(bridge.saveProject).toHaveBeenCalledWith(false,0);
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);expect(controller.getState().revision).toBe(0);
  expect(controller.hasPendingActions()).toBe(false);
});

const copyTarget={track:0,staff:0,bar:0,voice:0,beat:0};
const copiedBars={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:0};
it.each(['edit','cut','undo','redo'] as const)('keeps playback valid when native %s rejects',async operation=>{
  const note:EditCommand={type:'setNote',target:copyTarget,string:6,fret:3};
  const bridge=makeBridge({...blankProject(),edits:operation==='redo'?[]:[note]},operation==='redo'?[note]:[]),beforeChange=vi.fn();
  const reject=async()=>{throw new Error('native commit rejected');};
  bridge.applyEdit=reject;bridge.undo=reject;bridge.redo=reject;
  const controller=await DocumentController.create(bridge,beforeChange),before=controller.getState();
  const result=operation==='edit'?controller.edit(note):operation==='cut'?controller.cutMusic(copiedBars,'singleTrack'):controller[operation]();
  await expect(result).rejects.toThrow('native commit rejected');
  expect(controller.getState().snapshot).toBe(before.snapshot);expect(controller.getState().score).toBe(before.score);expect(beforeChange).not.toHaveBeenCalled();
});
it('copies from committed queued music without changing history, dirty state or playback',async()=>{
  const bridge=makeBridge(),beforeChange=vi.fn(),controller=await DocumentController.create(bridge,beforeChange);
  const edit=controller.edit({type:'setNote',target:copyTarget,string:6,fret:11});
  const copying=controller.copyMusic(copiedBars,'singleTrack');await edit;const committed=controller.getState().snapshot,clip=await copying;
  expect(scoreFromMusicClip(clip).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(11);
  expect(controller.getState().snapshot).toEqual(committed);expect(beforeChange).toHaveBeenCalledOnce();expect(bridge.applyEdit).toHaveBeenCalledOnce();
});
it('cuts inside the serialized queue with one command and publishes clipboard only after native success',async()=>{
  const project={...blankProject(),edits:[{type:'setNote' as const,target:copyTarget,string:6,fret:3}]},bridge=makeBridge(project),controller=await DocumentController.create(bridge);
  const store=new ClipboardStore();store.set(await controller.copyMusic(copiedBars,'singleTrack'));const old=store.get(),score=controller.getState().score;
  vi.mocked(bridge.applyEdit).mockRejectedValueOnce(new Error('native commit failed'));
  await expect(controller.cutMusic(copiedBars,'singleTrack').then(clip=>store.set(clip))).rejects.toThrow('native commit failed');
  expect(store.get()).toEqual(old);expect(controller.getState().score===score).toBe(true);expect(controller.getState().snapshot.project).toEqual(project);
  const clip=await controller.cutMusic(copiedBars,'singleTrack');store.set(clip);
  expect(controller.getState().snapshot.project.edits.at(-1)).toEqual({type:'eraseSelection',selection:copiedBars});
  expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes).toHaveLength(0);
  expect(scoreFromMusicClip(store.get()!).tracks[0].staves[0].bars[0].voices[0].beats[0].notes).toHaveLength(1);
  await controller.undo();expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes).toHaveLength(1);
});
it('multitrack cut expands the exact copied bars and a keep-one failure preserves history and clipboard',async()=>{
  const controller=await DocumentController.create(makeBridge()),store=new ClipboardStore();
  const clip=await controller.cutMusic({...copiedBars,lastBar:1},'multiTrack');store.set(clip);
  expect(controller.getState().score.masterBars).toHaveLength(2);expect(scoreFromMusicClip(clip).masterBars).toHaveLength(2);
  expect(controller.getState().snapshot.project.edits).toEqual([{type:'removeMeasures',firstBar:0,lastBar:1}]);
  const before=controller.getState().snapshot,previous=store.get();
  await expect(controller.cutMusic({...copiedBars,lastBar:1},'multiTrack').then(clip=>store.set(clip))).rejects.toThrow();
  expect(controller.getState().snapshot).toEqual(before);expect(store.get()).toEqual(previous);
});

it('keeps the current document on save cancellation',async () => {
  const controller=await DocumentController.create(makeBridge());const before=controller.getState().snapshot;
  await controller.save(true);expect(controller.getState().snapshot).toBe(before);
});

it.each(['preview','commit','cleanup'] as const)('cancels a staged asset after %s failure and preserves active history',async(phase)=>{
  const bridge=makeBridge();const staged=new Set(['asset-token']);const primary=new Error('asset commit failed');
  const asset={token:'asset-token',assetId:'a'.repeat(64),info:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}};
  const backing={assetId:asset.assetId,offsetMs:0,anchors:phase==='preview'?[{bar:99,occurrence:0,ratio:0,audioMs:0}]:[],mix:{gain:1,pan:0,mute:false,solo:false}};
  bridge.applyEdit=vi.fn(async()=>{throw primary;});
  bridge.cancelAsset=vi.fn(async token=>{staged.delete(token);if(phase==='cleanup') throw new Error('cleanup failed');return true;});
  const controller=await DocumentController.create(bridge);const original=controller.getState();
  const result=controller.edit({type:'setBacking',backing},asset);
  if(phase==='preview') await expect(result).rejects.toThrow(/anchor/i);else await expect(result).rejects.toBe(primary);
  expect(staged.size).toBe(0);expect(bridge.cancelAsset).toHaveBeenCalledWith('asset-token');
  expect(controller.getState().snapshot).toEqual(original.snapshot);expect(controller.getState().score===original.score).toBe(true);
  if(phase==='preview') expect(bridge.applyEdit).not.toHaveBeenCalled();else expect(controller.getState().error).toBe(primary.message);
});

it('does not cancel a successfully committed asset',async()=>{
  const bridge=makeBridge();const asset={token:'asset-token',assetId:'a'.repeat(64),info:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}};
  const backing={assetId:asset.assetId,offsetMs:0,anchors:[],mix:{gain:1,pan:0,mute:false,solo:false}};
  bridge.applyEdit=async command=>({documentId:'document-a',revision:1,snapshot:{project:{...blankProject(),assets:{[asset.assetId]:asset.info},edits:[command]},canUndo:true,canRedo:false,dirty:true,path:null}});
  bridge.cancelAsset=vi.fn(async()=>true);
  const controller=await DocumentController.create(bridge);await controller.edit({type:'setBacking',backing},asset);
  expect(controller.getState().settings.backing).toEqual(backing);expect(bridge.cancelAsset).not.toHaveBeenCalled();
});

it('maps staged cancellation tokens to native cancellation commands',async()=>{
  vi.mocked(invoke).mockClear();
  await nativeWorkspaceBridge.cancelDocument('document-token');await createDocumentBridge('document-a').cancelAsset('asset-token');
  expect(invoke).toHaveBeenCalledWith('cancel_document',{token:'document-token'});
  expect(invoke).toHaveBeenCalledWith('cancel_asset',{documentId:'document-a',token:'asset-token'});
});

const invalidBackingAnchors:{reason:string;anchors:SyncAnchor[]}[]=[
  {reason:'missing repeat occurrence',anchors:[{bar:0,occurrence:999,ratio:0,audioMs:0}]},
  {reason:'backwards mapped audio time',anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:0}]},
  {reason:'aliased bar-boundary positions',anchors:[{bar:0,occurrence:0,ratio:1,audioMs:0},{bar:1,occurrence:0,ratio:0,audioMs:1000}]},
];
const backingAssetId='c'.repeat(64);
const backingEdit=(anchors:SyncAnchor[]):EditCommand=>({type:'setBacking',backing:{assetId:backingAssetId,offsetMs:0,anchors,mix:{gain:1,pan:0,mute:false,solo:false}}});
const projectForBacking=(edits:EditCommand[]=[])=>({...blankProject(),assets:{[backingAssetId]:{filename:'backing.wav',mediaType:'audio/wav',byteLength:100}},edits});
const repeatStart:Extract<EditCommand,{type:'setMeasureSettings'}>={type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:true,repeatCount:0,endings:[],section:'',tempos:[]};
const repeatEnd={...repeatStart,bar:1,repeatStart:false,repeatCount:2};

it.each(invalidBackingAnchors)('preserves document and audio state when an edit has $reason',async({anchors})=>{
  const bridge=makeBridge(projectForBacking());const beforeChange=vi.fn();const controller=await DocumentController.create(bridge,beforeChange);const original=controller.getState();
  await expect(controller.edit(backingEdit(anchors))).rejects.toThrow(/anchor|backing|occurrence/i);
  expect(controller.getState().snapshot).toEqual(original.snapshot);expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(original.settings);expect(bridge.applyEdit).not.toHaveBeenCalled();expect(beforeChange).not.toHaveBeenCalled();
});

it('preserves document and audio state when repeat removal invalidates existing backing',async()=>{
  const bridge=makeBridge(projectForBacking([repeatStart,repeatEnd,backingEdit([{bar:1,occurrence:1,ratio:.5,audioMs:6500}])]));
  const beforeChange=vi.fn();const controller=await DocumentController.create(bridge,beforeChange);const original=controller.getState();
  await expect(controller.edit({...repeatEnd,repeatCount:0})).rejects.toThrow(/anchor|backing|occurrence/i);
  expect(controller.getState().snapshot).toEqual(original.snapshot);expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(original.settings);expect(bridge.applyEdit).not.toHaveBeenCalled();expect(beforeChange).not.toHaveBeenCalled();
});

it('opens valid final backing history and preserves native cursor when Undo would expose an invalid past state',async()=>{
  const project=projectForBacking([backingEdit([{bar:0,occurrence:999,ratio:0,audioMs:0}]),{type:'setBacking',backing:null}]);
  const bridge=makeBridge(project);const undo=vi.spyOn(bridge,'undo');const redo=vi.spyOn(bridge,'redo');const beforeChange=vi.fn();
  const controller=await DocumentController.create(bridge,beforeChange);const original=controller.getState();const nativeBefore=await bridge.snapshot();
  expect(original.settings.backing).toBeNull();expect(original.snapshot.project.edits).toHaveLength(2);
  await expect(controller.undo()).rejects.toThrow(/anchor|backing|occurrence/i);
  const nativeAfter=await bridge.snapshot();
  expect({nativeEdits:nativeAfter.snapshot.project.edits.length,visibleEdits:controller.getState().snapshot.project.edits.length}).toEqual({nativeEdits:2,visibleEdits:2});
  expect(nativeAfter).toEqual(nativeBefore);expect(controller.getState().snapshot).toEqual(original.snapshot);
  expect(controller.getState().snapshot.canRedo).toBe(false);expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(original.settings);expect(controller.getState().documentEpoch).toBe(original.documentEpoch);
  expect(controller.getState().error).toMatch(/anchor|backing|occurrence/i);expect(controller.getState().busy).toBe(false);
  expect(undo).not.toHaveBeenCalled();expect(redo).not.toHaveBeenCalled();expect(beforeChange).not.toHaveBeenCalled();
});

it('preserves native cursor and redo availability when Redo would expose an invalid future backing state',async()=>{
  const invalid=backingEdit([{bar:0,occurrence:999,ratio:0,audioMs:0}]);const bridge=makeBridge(projectForBacking(),[invalid]);
  const undo=vi.spyOn(bridge,'undo');const redo=vi.spyOn(bridge,'redo');const beforeChange=vi.fn();
  const controller=await DocumentController.create(bridge,beforeChange);const original=controller.getState();const nativeBefore=await bridge.snapshot();
  expect(original.snapshot.canRedo).toBe(true);expect(original.snapshot).toHaveProperty('redoEdit',invalid);
  await expect(controller.redo()).rejects.toThrow(/anchor|backing|occurrence/i);
  const nativeAfter=await bridge.snapshot();
  expect({nativeEdits:nativeAfter.snapshot.project.edits.length,visibleEdits:controller.getState().snapshot.project.edits.length}).toEqual({nativeEdits:0,visibleEdits:0});
  expect(nativeAfter).toEqual(nativeBefore);expect(controller.getState().snapshot).toEqual(original.snapshot);
  expect(controller.getState().snapshot.canRedo).toBe(true);expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(original.settings);expect(controller.getState().documentEpoch).toBe(original.documentEpoch);
  expect(controller.getState().error).toMatch(/anchor|backing|occurrence/i);expect(controller.getState().busy).toBe(false);
  expect(undo).not.toHaveBeenCalled();expect(redo).not.toHaveBeenCalled();expect(beforeChange).not.toHaveBeenCalled();
});

it('updates persisted mix without stopping or rebuilding the score',async()=>{
  const beforeChange=vi.fn();
  const controller=await DocumentController.create(makeBridge(),beforeChange);
  const score=controller.getState().score;
  const mix={gain:.3,pan:0,mute:false,solo:true};
  await controller.edit({type:'setTrackMix',trackId:'base/0',mix});
  expect(controller.getState().score===score).toBe(true);
  expect(beforeChange).not.toHaveBeenCalled();
  expect(controller.getState()).toHaveProperty('settings.mixes.base/0',mix);
});

it.each<EditCommand>([
  {type:'setTrackMix',trackId:'base/0',mix:{gain:.3,pan:-.5,mute:false,solo:true}},
  {type:'setTrackSound',trackId:'base/0',sound:{voiceId:null,presetId:'clean',effects:defaultEffects()}},
  {type:'setPrintLayout',layout:{paper:'Letter',orientation:'landscape',marginMm:12,scale:.9,profile:'Tab'}},
  {type:'setBacking',backing:null},
])('undoes and redoes $type without stopping or rebuilding notation',async(command)=>{
  const beforeChange=vi.fn();const controller=await DocumentController.create(makeBridge(),beforeChange);
  const original=controller.getState();
  await controller.edit(command);const edited=controller.getState().settings;
  await controller.undo();
  expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(original.settings);
  expect(beforeChange).not.toHaveBeenCalled();
  await controller.redo();
  expect(controller.getState().score===original.score).toBe(true);
  expect(controller.getState().settings).toEqual(edited);
  expect(beforeChange).not.toHaveBeenCalled();
});

it('still stops and rebuilds notation for music history changes mixed with settings',async()=>{
  const beforeChange=vi.fn();const controller=await DocumentController.create(makeBridge(),beforeChange);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  const authored=controller.getState().score;
  await controller.edit({type:'setTrackMix',trackId:'base/0',mix:{gain:.3,pan:0,mute:false,solo:false}});
  await controller.undo();
  expect(controller.getState().score===authored).toBe(true);expect(beforeChange).toHaveBeenCalledTimes(1);
  await controller.undo();
  expect(controller.getState().score===authored).toBe(false);expect(beforeChange).toHaveBeenCalledTimes(2);
  expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes).toHaveLength(0);
  await controller.redo();const restored=controller.getState().score;
  expect(restored.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(7);
  expect(beforeChange).toHaveBeenCalledTimes(3);
  await controller.redo();expect(controller.getState().score===restored).toBe(true);expect(beforeChange).toHaveBeenCalledTimes(3);
});

it('retains imported defaults for a removed track and embedded bytes through settings history',async()=>{
  const source=()=>{
    const score=buildScore({...blankProject(),edits:[{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}]});
    score.tracks[1].playbackInfo.isMute=true;score.backingTrack={rawAudioFile:new Uint8Array([82,73,70,70])};return score;
  };
  const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockImplementation(source);
  try {
    const project={...blankProject(),base:{kind:'file' as const,filename:'source.gp',bytesBase64:'AA==',sha256:'a'.repeat(64)}};
    const beforeChange=vi.fn();const controller=await DocumentController.create(makeBridge(project),beforeChange);
    await controller.edit({type:'removeTrack',track:1});const original=controller.getState();
    await controller.edit({type:'setTrackMix',trackId:'base/0',mix:{gain:.3,pan:0,mute:true,solo:false}});
    await controller.undo();
    expect(controller.getState().settings).toEqual(original.settings);
    expect(controller.getState().settings.mixes['base/1'].mute).toBe(true);
    expect(controller.getState().embeddedBacking===original.embeddedBacking).toBe(true);
    expect(controller.getState().score===original.score).toBe(true);
    expect(beforeChange).toHaveBeenCalledTimes(1);
  } finally {load.mockRestore();}
});

it('discards candidate music when native commit fails',async () => {
  const bridge=makeBridge(); bridge.applyEdit=async()=>{throw new Error('native failure');};
  const controller=await DocumentController.create(bridge);
  await expect(controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7})).rejects.toThrow('native failure');
  expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].isRest).toBe(true);
  expect(controller.getState().snapshot.project.edits).toHaveLength(0);
});

it('keeps dirty state when a save fails',async () => {
  const bridge=makeBridge(); bridge.saveProject=async()=>{throw new Error('disk unavailable');};
  const controller=await DocumentController.create(bridge);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  await expect(controller.save(false)).rejects.toThrow();
  expect(controller.getState().snapshot.dirty).toBe(true);
});

it('serializes overlapping edits against the latest committed score',async () => {
  const controller=await DocumentController.create(makeBridge()); const target={track:0,staff:0,bar:0,voice:0,beat:0};
  await Promise.all([controller.edit({type:'setNote',target,string:6,fret:7}),controller.edit({type:'setNote',target,string:5,fret:5})]);
  expect(controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map(n=>n.realValue).sort()).toEqual([64,71]);
  expect(controller.getState().snapshot.project.edits).toHaveLength(2);
});

it('cancels closing when the user cancels the requested save',async () => {
  const bridge=makeBridge(); bridge.askUnsaved=async()=> 'save';
  const controller=await DocumentController.create(bridge);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  expect(await controller.requestClose()).toBe(false);
  expect(controller.getState().snapshot.dirty).toBe(true);
});

it('tells the player where the bars went for an edit, its undo and its redo, and nothing for an edit that moves none',async()=>{
  const beforeChange=vi.fn(),controller=await DocumentController.create(makeBridge(),beforeChange);
  const bars=()=>controller.getState().score.masterBars.length,start=bars();
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  expect(beforeChange).toHaveBeenLastCalledWith(undefined);
  await controller.edit({type:'insertMeasures',beforeBar:0,count:2});
  expect(bars()).toBe(start+2);
  expect(beforeChange).toHaveBeenLastCalledWith({oldToNew:Array.from({length:start},(_,bar)=>bar+2),inserted:[0,1]});
  await controller.undo();
  expect(bars()).toBe(start);
  expect(beforeChange).toHaveBeenLastCalledWith({oldToNew:[null,null,...Array.from({length:start},(_,bar)=>bar)],inserted:[]});
  await controller.redo();
  expect(beforeChange).toHaveBeenLastCalledWith({oldToNew:Array.from({length:start},(_,bar)=>bar+2),inserted:[0,1]});
  await controller.undo();await controller.undo();
  expect(beforeChange).toHaveBeenLastCalledWith(undefined);
});
