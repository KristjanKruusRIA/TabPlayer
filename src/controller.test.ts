import { expect, it, vi } from 'vitest';
import { DocumentController } from './controller';
import { blankProject, type ProjectSnapshot } from './project';
import type { NativeBridge } from './bridge';

function makeBridge() {
  let current: ProjectSnapshot = {project:blankProject(),canUndo:false,canRedo:false,dirty:false,path:null};
  const bridge: NativeBridge = {
    snapshot: async () => structuredClone(current), readDocument: vi.fn(async () => null),
    replaceProject: async (project,path) => { current={project,canUndo:false,canRedo:false,dirty:false,path}; return structuredClone(current); },
    applyEdit: vi.fn(async command => { current={...current,project:{...current.project,edits:[...current.project.edits,command]},canUndo:true,dirty:true}; return structuredClone(current); }),
    undo: async () => { throw new Error('unused'); }, redo: async () => { throw new Error('unused'); },
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
  bridge.readDocument=async()=>({project:{...blankProject(),edits:[{type:'setRest',target:{track:0,staff:0,bar:99,voice:0,beat:0}}]},path:'bad.tabplayer'});
  const controller=await DocumentController.create(bridge); const before=controller.getState().snapshot;
  await expect(controller.open()).rejects.toThrow();
  expect(controller.getState().snapshot).toEqual(before);
  expect(replace).not.toHaveBeenCalled();
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
