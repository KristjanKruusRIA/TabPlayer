import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, model, Settings } from '@coderline/alphatab';
import { DocumentController } from './controller';
import { editStats, exportGp, verifyEditInPlace } from './engine';
import * as engine from './engine';
import { blankProject, type EditCommand, type Project, type ProjectSnapshot } from './project';
import type { NativeBridge } from './bridge';
import type { DocumentSnapshot } from './workspace/types';

// What the controller does when the in-place machinery fails after native has already acted, and when other files are opened while a check runs.
vi.mock('./engine',async importOriginal=>{
  const actual=await importOriginal<typeof import('./engine')>();
  return {...actual,undoInPlace:vi.fn(actual.undoInPlace),editInPlace:vi.fn(actual.editInPlace),checkEditInPlace:vi.fn(actual.checkEditInPlace)};
});

function makeBridge(project:Project) {
  let current:ProjectSnapshot={project,canUndo:project.edits.length>0,canRedo:false,dirty:false,path:null};
  let undone:EditCommand[]=[],revision=0;
  const snapshot=():DocumentSnapshot=>({documentId:'document-a',revision,snapshot:{...structuredClone(current),redoEdit:structuredClone(undone.at(-1)??null)}});
  const bridge:NativeBridge={
    documentId:'document-a',snapshot:vi.fn(async()=>snapshot()),cancelAsset:vi.fn(async()=>true),
    readBackingAsset:async()=>{throw new Error('no backing');},
    applyEdit:vi.fn(async command=>{undone=[];current={...current,project:{...current.project,edits:[...current.project.edits,command]},canUndo:true,canRedo:false,dirty:true};revision++;return snapshot();}),
    undo:async()=>{const edits=current.project.edits.slice();undone.push(edits.pop()!);current={...current,project:{...current.project,edits},canUndo:edits.length>0,canRedo:true};revision++;return snapshot();},
    redo:async()=>{const edits=[...current.project.edits,undone.pop()!];current={...current,project:{...current.project,edits},canUndo:true,canRedo:undone.length>0};revision++;return snapshot();},
    setLock:vi.fn() as never,saveProject:vi.fn(async()=>null),exportGp:async()=>false,askUnsaved:async()=>'discard',confirmExport:async()=>true,
  };
  return bridge;
}
const at=(bar:number,beat=0)=>({track:0,staff:0,bar,voice:0,beat});
const blank=():Project=>({...blankProject(),base:{kind:'blank',title:'T',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:4},edits:[]});
const B=String.fromCharCode(92),N=String.fromCharCode(10);
const texFile=(...bars:string[]):Project=>{
  const imp=new importer.AlphaTexImporter();
  imp.initFromString([`${B}title "T"`,`${B}tempo 100`,`${B}track "Lead"`,`${B}staff {tabs}`,`${B}instrument 25`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,...bars].join(N),new Settings());
  const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'f.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};

describe('undo and redo applied in place when they fail',()=>{
  it('rebuilds from what native holds when taking an edit back in place throws',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});await controller.edit({type:'setNote',target:at(1),string:2,fret:7});
      vi.mocked(engine.undoInPlace).mockImplementationOnce(()=>{throw new Error('injected');});
      const healed=editStats.healed;
      await controller.undo();
      expect(editStats.healed-healed).toBe(1);
      expect(controller.getState().snapshot.project.edits).toHaveLength(1);
      expect(verifyEditInPlace(controller.getState().snapshot.project,controller.getState(),controller.getState().snapshot.canRedo)).toBeNull();
      // And everything still works afterwards.
      await controller.redo();expect(verifyEditInPlace(controller.getState().snapshot.project,controller.getState())).toBeNull();
    } finally {warn.mockRestore();}
  });
  it('rebuilds when redoing in place throws, and rebuilds without trying when the check refuses',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});await controller.edit({type:'setNote',target:at(1),string:2,fret:7});
      await controller.undo();
      const healed=editStats.healed;
      vi.mocked(engine.editInPlace).mockImplementationOnce(()=>{throw new Error('injected half-way');});
      await controller.redo();
      expect(editStats.healed-healed).toBe(1);
      expect(controller.getState().snapshot.project.edits).toHaveLength(2);
      expect(verifyEditInPlace(controller.getState().snapshot.project,controller.getState())).toBeNull();
      await controller.undo();
      const inPlace=editStats.inPlace;
      vi.mocked(engine.checkEditInPlace).mockImplementationOnce(()=>{throw new Error('refused by the check');});
      await controller.redo();
      expect(editStats.inPlace,'not applied in place').toBe(inPlace);
      expect(controller.getState().snapshot.project.edits).toHaveLength(2);
      expect(verifyEditInPlace(controller.getState().snapshot.project,controller.getState())).toBeNull();
    } finally {warn.mockRestore();}
  });
});

describe('the idle check while other files are opened',()=>{
  it('is not fooled by another file resetting the id counters between its steps',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      // A score whose notes are tied and hammered, edited with beats inserted and written (the rebuild matches links by id).
      const project=texFile(`:8 3.3{h} 5.3 7.3 5.3 3.3 3.3 3.3 r |`,`:4 5.3 -.3 7.2 9.2 |`,`:4 3.3 3.3 3.3 3.3 |`);
      const controller=await DocumentController.create(makeBridge(project));
      const string=controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].string;
      const edits:EditCommand[]=[{type:'deleteBeat',target:at(0,7)},{type:'insertBeat',target:at(0,1),duration:8,dots:0},{type:'setNote',target:at(0,1),string,fret:4},{type:'setNote',target:at(2,2),string:2,fret:5}];
      for(const edit of edits)await controller.edit(edit);
      const mismatches=editStats.mismatches;
      // Opening a file sets the counters back to zero and leaves them wherever its own count ends: here on the ids of the score's first note and beat.
      const first=controller.getState().score.tracks[0].staves[0].bars[0].voices[0].beats[0],counters=model as unknown as {Beat:{_globalBeatId:number};Note:{globalNoteId:number}};
      const small=()=>{counters.Note.globalNoteId=first.notes[0].id;counters.Beat._globalBeatId=first.id;};
      // Another file is opened at every step of the check.
      const ok=await controller.verifyNow(async()=>{small();});
      expect(ok).toBe(true);
      expect(editStats.mismatches-mismatches,'a rebuild disturbed by another import is not a repair').toBe(0);
      expect(controller.getState().repaired).toBeFalsy();
      expect(verifyEditInPlace(controller.getState().snapshot.project,controller.getState())).toBeNull();
    } finally {errors.mockRestore();warn.mockRestore();}
  });
});
