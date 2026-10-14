import { expect, it, vi } from 'vitest';
import { DocumentController } from './controller';
import { importer } from '@coderline/alphatab';
import { buildScore } from './engine';
import { blankProject, type EditCommand, type Project, type ProjectSnapshot } from './project';
import { defaultEffects } from './document-settings';
import { invoke } from '@tauri-apps/api/core';
import { nativeBridge, type NativeBridge } from './bridge';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>true)}));

function makeBridge(project:Project=blankProject()) {
  let current: ProjectSnapshot = {project,canUndo:false,canRedo:false,dirty:false,path:null};
  let undone:EditCommand[]=[];
  const bridge: NativeBridge = {
    snapshot: async () => structuredClone(current), readDocument: vi.fn(async () => null),
    createBlankDocument: async()=>({project:blankProject(),path:null,token:'new-document'}),
    replaceProject: async () => { current={project:blankProject(),canUndo:false,canRedo:false,dirty:false,path:null}; return structuredClone(current); },
    applyEdit: vi.fn(async command => { undone=[];current={...current,project:{...current.project,edits:[...current.project.edits,command]},canUndo:true,canRedo:false,dirty:true}; return structuredClone(current); }),
    undo: async () => { const edits=current.project.edits.slice();undone.push(edits.pop()!);current={...current,project:{...current.project,edits},canUndo:edits.length>0,canRedo:true,dirty:edits.length>0};return structuredClone(current); },
    redo: async () => { const edits=[...current.project.edits,undone.pop()!];current={...current,project:{...current.project,edits},canUndo:true,canRedo:undone.length>0,dirty:true};return structuredClone(current); },
    saveProject: vi.fn(async () => null), exportGp: async () => false,
    askUnsaved: async () => 'discard', confirmExport: async () => true,
  };
  return bridge;
}

it('keeps the current document on open or save cancellation',async () => {
  const controller = await DocumentController.create(makeBridge()); const before=controller.getState().snapshot;
  await controller.open(); await controller.save(true);
  expect(controller.getState().snapshot).toEqual(before);
});

it('rejects malformed replay before replacing the active native document',async () => {
  const bridge=makeBridge(); const replace=vi.spyOn(bridge,'replaceProject');
  bridge.readDocument=async()=>({project:{...blankProject(),edits:[{type:'setRest',target:{track:0,staff:0,bar:99,voice:0,beat:0}}]},path:'bad.tabplayer',token:'invalid-music'});
  const controller=await DocumentController.create(bridge); const before=controller.getState().snapshot;
  await expect(controller.open()).rejects.toThrow();
  expect(controller.getState().snapshot).toEqual(before);
  expect(replace).not.toHaveBeenCalled();
});

it('creates and validates a staged blank candidate before committing its token',async()=>{
  const bridge=makeBridge();
  const staged={project:blankProject(),path:null,token:'new-document'};
  const createBlankDocument=vi.fn(async()=>staged);
  Object.assign(bridge,{createBlankDocument});
  const replace=vi.spyOn(bridge,'replaceProject');
  const controller=await DocumentController.create(bridge);
  await controller.new();
  expect(createBlankDocument).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledWith('new-document');
});

it.each([
  ['open','build'],['new','build'],['open','commit'],['new','commit'],
] as const)('cancels a staged %s document after %s failure and preserves active history',async(operation,phase)=>{
  const bridge=makeBridge();const staged=new Set(['staged-document']);
  const candidate={project:blankProject(),path:null,token:'staged-document'};
  if(phase==='build') candidate.project.edits=[{type:'setRest',target:{track:0,staff:0,bar:99,voice:0,beat:0}}];
  bridge.readDocument=async()=>candidate;bridge.createBlankDocument=async()=>candidate;
  if(phase==='commit') bridge.replaceProject=async()=>{throw new Error('commit failed');};
  bridge.cancelDocument=vi.fn(async token=>staged.delete(token));
  const controller=await DocumentController.create(bridge);const original=controller.getState();
  await expect(controller[operation]()).rejects.toThrow();
  expect(staged.size).toBe(0);expect(bridge.cancelDocument).toHaveBeenCalledWith('staged-document');
  expect(controller.getState().snapshot).toEqual(original.snapshot);expect(controller.getState().score===original.score).toBe(true);
});

it.each(['open','new'] as const)('does not cancel a successfully committed %s document',async(operation)=>{
  const bridge=makeBridge();bridge.readDocument=bridge.createBlankDocument;
  bridge.cancelDocument=vi.fn(async()=>true);
  const controller=await DocumentController.create(bridge);await controller[operation]();
  expect(bridge.cancelDocument).not.toHaveBeenCalled();
});

it('preserves the primary document error when staged cleanup fails',async()=>{
  const bridge=makeBridge();const primary=new Error('document commit failed');
  bridge.replaceProject=async()=>{throw primary;};bridge.cancelDocument=vi.fn(async()=>{throw new Error('cleanup failed');});
  const controller=await DocumentController.create(bridge);const original=controller.getState().snapshot;
  await expect(controller.new()).rejects.toBe(primary);
  expect(bridge.cancelDocument).toHaveBeenCalledWith('new-document');
  expect(controller.getState().error).toBe('document commit failed');expect(controller.getState().snapshot).toEqual(original);
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
  bridge.applyEdit=async command=>({project:{...blankProject(),assets:{[asset.assetId]:asset.info},edits:[command]},canUndo:true,canRedo:false,dirty:true,path:null});
  bridge.cancelAsset=vi.fn(async()=>true);
  const controller=await DocumentController.create(bridge);await controller.edit({type:'setBacking',backing},asset);
  expect(controller.getState().settings.backing).toEqual(backing);expect(bridge.cancelAsset).not.toHaveBeenCalled();
});

it('maps staged cancellation tokens to native cancellation commands',async()=>{
  vi.mocked(invoke).mockClear();
  await nativeBridge.cancelDocument?.('document-token');await nativeBridge.cancelAsset?.('asset-token');
  expect(invoke).toHaveBeenCalledWith('cancel_document',{token:'document-token'});
  expect(invoke).toHaveBeenCalledWith('cancel_asset',{token:'asset-token'});
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
