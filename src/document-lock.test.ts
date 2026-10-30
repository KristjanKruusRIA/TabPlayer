import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { DocumentController } from './controller';
import { buildDocument, previewEdit, validateProject } from './engine';
import { blankProject, isFinalized, type DocumentLock, type EditCommand, type Project, type ProjectSnapshot } from './project';
import { createDocumentBridge, type NativeBridge } from './bridge';
import type { DocumentSnapshot } from './workspace/types';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>true)}));

it('validates a finalized lock and refuses unknown kinds or malformed locks',()=>{
  const locked={...blankProject(),lock:{kind:'finalized' as const}};
  expect(validateProject(locked).lock).toEqual({kind:'finalized'});expect(isFinalized(validateProject(locked))).toBe(true);
  expect(validateProject(blankProject()).lock).toBeUndefined();expect(isFinalized(blankProject())).toBe(false);
  for(const lock of [{kind:'password'},{kind:'finalized',hash:'x'},null,'finalized',[]])
    expect(()=>validateProject({...blankProject(),lock})).toThrow('Invalid project lock.');
});

it('sends the lock through the native document_set_lock command',async()=>{
  const bridge=createDocumentBridge('document-a');
  await bridge.setLock({kind:'finalized'},3);
  expect(invoke).toHaveBeenLastCalledWith('document_set_lock',{document:{documentId:'document-a',revision:3},lock:{kind:'finalized'}});
  await bridge.setLock(null,4);
  expect(invoke).toHaveBeenLastCalledWith('document_set_lock',{document:{documentId:'document-a',revision:4},lock:null});
});

function lockBridge() {
  let lock:DocumentLock|undefined,revision=0;
  const record=():DocumentSnapshot=>{const project:Project={...blankProject(),...(lock?{lock}:{})};const snapshot:ProjectSnapshot={project,canUndo:false,canRedo:true,dirty:!!lock,path:null};return {documentId:'document-a',revision,snapshot};};
  const setLock=vi.fn(async(next:DocumentLock|null,expected:number)=>{expect(expected).toBe(revision);lock=next??undefined;revision++;return record();});
  const bridge={documentId:'document-a',snapshot:async()=>record(),setLock,undo:vi.fn(),redo:vi.fn(),applyEdit:vi.fn()} as unknown as NativeBridge;
  return {bridge,setLock};
}

it('finalizes and unfinalizes through the bridge, skips a no-op and leaves history alone',async()=>{
  const {bridge,setLock}=lockBridge(),controller=await DocumentController.create(bridge);
  await controller.setLock(null);expect(setLock).not.toHaveBeenCalled();
  await controller.setLock({kind:'finalized'});
  expect(setLock).toHaveBeenCalledWith({kind:'finalized'},0);
  expect(controller.getState().snapshot.project.lock).toEqual({kind:'finalized'});expect(controller.getState().revision).toBe(1);
  expect(controller.getState().snapshot.canRedo).toBe(true);expect(bridge.applyEdit).not.toHaveBeenCalled();
  await controller.setLock({kind:'finalized'});expect(setLock).toHaveBeenCalledTimes(1);
  await controller.setLock(null);
  expect(setLock).toHaveBeenLastCalledWith(null,1);expect(controller.getState().snapshot.project.lock).toBeUndefined();
});

it('replays mix, added track and a mix on that track in order, around undo, redo and a lock',()=>{
  const mix=(trackId:string,gain:number):EditCommand=>({type:'setTrackMix',trackId,mix:{gain,pan:0,mute:false,solo:false}});
  const add:EditCommand={type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33};
  // An added track is keyed by the position of its edit, so the list order is persisted identity.
  const id=`added/1/${JSON.stringify(add)}`;
  const edits=[mix('base/0',.5),add,mix(id,.3)];
  for(let count=0;count<=edits.length;count++){
    const project={...blankProject(),edits:edits.slice(0,count)};
    const built=buildDocument(project),locked=buildDocument({...project,lock:{kind:'finalized'}});
    expect(locked.settings.mixes).toEqual(built.settings.mixes);expect(locked.score.tracks).toHaveLength(built.score.tracks.length);
    if(count===edits.length){
      expect(built.score.tracks).toHaveLength(2);expect(built.settings.mixes[id].gain).toBe(.3);expect(built.settings.mixes['base/0'].gain).toBe(.5);
      expect(()=>previewEdit(project,{type:'appendMeasure'},built)).not.toThrow();
    }
  }
  // A mix made while finalized after undoing twice is an ordinary edit: it replaces the undone tail.
  const afterLock=buildDocument({...blankProject(),edits:[edits[0],mix('base/0',.7)],lock:{kind:'finalized'}});
  expect(afterLock.score.tracks).toHaveLength(1);expect(afterLock.settings.mixes['base/0'].gain).toBe(.7);
});
