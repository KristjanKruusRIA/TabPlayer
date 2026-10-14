import { expect, it, vi } from 'vitest';
import { DocumentController } from './controller';
import { nativeBridge, type NativeBridge } from './bridge';
import { blankProject, type ProjectSnapshot } from './project';

it('changes the playback session only after a successful New or Open, including identical blank documents',async()=>{
  let snapshot:ProjectSnapshot={project:blankProject(),canUndo:false,canRedo:false,dirty:false,path:null};
  const candidate={project:blankProject(),path:null,token:'blank'};
  const bridge:NativeBridge={...nativeBridge,snapshot:async()=>snapshot,readDocument:async()=>candidate,createBlankDocument:async()=>candidate,
    applyEdit:async command=>{snapshot={...snapshot,project:{...snapshot.project,edits:[...snapshot.project.edits,command]},dirty:true};return snapshot;},
    askUnsaved:async()=> 'discard',replaceProject:vi.fn(async()=>{snapshot={...snapshot,project:blankProject(),dirty:false};return snapshot;}),cancelDocument:async()=>true};
  const controller=await DocumentController.create(bridge);
  expect(controller.getState().documentEpoch).toBe(0);
  await controller.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  expect(controller.getState().documentEpoch).toBe(0);
  await controller.new();expect(controller.getState().documentEpoch).toBe(1);
  await controller.new();expect(controller.getState().documentEpoch).toBe(2);
  await controller.open();expect(controller.getState().documentEpoch).toBe(3);
  bridge.replaceProject=async()=>{throw new Error('replacement failed');};
  await expect(controller.open()).rejects.toThrow('replacement failed');
  expect(controller.getState().documentEpoch).toBe(3);
});
