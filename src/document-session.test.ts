import { expect, it } from 'vitest';
import { DocumentController } from './controller';
import { createDocumentBridge, type NativeBridge } from './bridge';
import { blankProject, type ProjectSnapshot } from './project';
import type { DocumentSnapshot } from './workspace/types';

it('keeps identical blank document sessions and history independent',async()=>{
  function bridgeFor(documentId:string):NativeBridge {
    let snapshot:ProjectSnapshot={project:blankProject(),canUndo:false,canRedo:false,dirty:false,path:null},revision=0;
    const record=():DocumentSnapshot=>({documentId,revision,snapshot});
    return {...createDocumentBridge(documentId),snapshot:async()=>record(),
      applyEdit:async(command,expectedRevision)=>{expect(expectedRevision).toBe(revision);snapshot={...snapshot,project:{...snapshot.project,edits:[...snapshot.project.edits,command]},canUndo:true,dirty:true};revision++;return record();}};
  }
  const first=await DocumentController.create(bridgeFor('document-a')),second=await DocumentController.create(bridgeFor('document-b'));
  const originalSecond=second.getState();
  await first.edit({type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:7});
  expect(first.getState()).toMatchObject({documentId:'document-a',revision:1,documentEpoch:0});
  expect(first.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(7);
  expect(second.getState()).toBe(originalSecond);expect(second.getState().documentId).toBe('document-b');
  expect(second.getState().snapshot.project.edits).toHaveLength(0);expect(second.getState().snapshot.dirty).toBe(false);
});
