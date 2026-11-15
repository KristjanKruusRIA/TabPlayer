import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, model, Settings } from '@coderline/alphatab';
import { DocumentController } from './controller';
import { editCheck, editStats, exportGp, idleVerification, verifyEditInPlace } from './engine';
import * as engine from './engine';
const engineActual=await vi.importActual<typeof import('./engine')>('./engine');
import { blankProject, type EditCommand, type Project, type ProjectSnapshot } from './project';
import type { NativeBridge } from './bridge';
import type { DocumentSnapshot } from './workspace/types';

// What the controller does when the in-place machinery fails after native has already acted, and when other files are opened while a check runs.
vi.mock('./engine',async importOriginal=>{
  const actual=await importOriginal<typeof import('./engine')>();
  return {...actual,undoInPlace:vi.fn(actual.undoInPlace),editInPlace:vi.fn(actual.editInPlace),checkEditInPlace:vi.fn(actual.checkEditInPlace),compareWithRebuild:vi.fn(actual.compareWithRebuild),verifyEditStepwise:vi.fn(actual.verifyEditStepwise),buildDocument:vi.fn(actual.buildDocument)};
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
    setLock:vi.fn() as never,saveProject:vi.fn(async()=>null),exportGp:vi.fn(async()=>true),askUnsaved:async()=>'discard',confirmExport:async()=>true,
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

describe('a check only ever means: equal to a rebuild from the file and the history',()=>{
  const fretOf=(controller:DocumentController,bar:number,beat:number)=>controller.getState().score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].notes[0];
  // An edit in place that writes another fret than the history says: self-consistent, so a comparison of the document with itself cannot see it.
  const writesWrong=(wrong:number)=>vi.mocked(engine.editInPlace).mockImplementationOnce((current,command,index)=>engineActual.editInPlace(current,{...command,fret:wrong} as EditCommand,index));
  const longProject=():Project=>({...blank(),edits:Array.from({length:14},()=>({type:'appendMeasure'}) as EditCommand)});
  const writtenFret=(bytes:Uint8Array)=>{
    const score=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    return score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].fret;
  };
  it('finds a wrong fret after a long history, swaps the rebuild in, and an export never writes the wrong fret',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const bridge=makeBridge(longProject());
      const controller=await DocumentController.create(bridge);
      writesWrong(9);
      await controller.edit({type:'setNote',target:at(0,1),string:2,fret:5});
      expect(fretOf(controller,0,1).fret,'the injected bug wrote another fret than the history says').toBe(9);
      const mismatches=editStats.mismatches;
      expect(controller.isVerified(),'an edit in place is not checked yet').toBe(false);
      expect(await controller.verifyNow(async()=>{})).toBe(true);
      expect(editStats.mismatches-mismatches,'the check found the wrong fret').toBe(1);
      expect(controller.getState().repaired).toBe(true);
      expect(fretOf(controller,0,1).fret).toBe(5);
      expect(controller.isVerified()).toBe(true);
      // The same again, and now through the export: the check it makes first swaps the rebuild in.
      writesWrong(11);
      await controller.edit({type:'setNote',target:at(0,1),string:2,fret:7});
      expect(fretOf(controller,0,1).fret).toBe(11);
      await controller.export();
      expect(bridge.exportGp).toHaveBeenCalledTimes(1);
      expect(writtenFret(vi.mocked(bridge.exportGp).mock.calls[0][0] as Uint8Array),'the file holds what the history says').toBe(7);
    } finally {errors.mockRestore();}
  },120000);
  it('does not call a document checked when the check could not be made', async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(longProject()));
      await controller.edit({type:'setNote',target:at(0,1),string:2,fret:5});
      expect(controller.isVerified()).toBe(false);
      // A check that is cancelled by another action leaves the document unchecked.
      const pending=controller.verifyNow(async()=>{await Promise.resolve();});
      await controller.edit({type:'setNote',target:at(1,1),string:2,fret:6});
      await pending;
      expect(controller.isVerified()).toBe(false);
    } finally {errors.mockRestore();}
  },120000);
  it('hands Copy and Cut the rebuilt score when the edited one is wrong, so a wrong note never reaches a paste edit', async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(longProject()));
      writesWrong(9);
      await controller.edit({type:'setNote',target:at(0,1),string:2,fret:5});
      expect(fretOf(controller,0,1).fret).toBe(9);
      const clip=await controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
      expect(clip.scoreJson).not.toContain('"fret":9');expect(clip.scoreJson).toContain('"fret":5');
      writesWrong(10);
      await controller.edit({type:'setNote',target:at(1,1),string:2,fret:6});
      expect(fretOf(controller,1,1).fret).toBe(10);
      const cut=await controller.cutMusic({kind:'bars',tracks:[0],firstBar:1,lastBar:1},'singleTrack');
      expect(cut.scoreJson).not.toContain('"fret":10');expect(cut.scoreJson).toContain('"fret":6');
    } finally {errors.mockRestore();}
  },120000);
  it('does not fail an edit when the sampled check itself throws, and leaves the document unchecked', async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const previous=editCheck.every;
    try {
      editCheck.every=1;
      const controller=await DocumentController.create(makeBridge(blank()));
      vi.mocked(engine.compareWithRebuild).mockImplementationOnce(()=>{throw new Error('the rebuild failed');});
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      expect(controller.isVerified(),'a check that did not finish is no check').toBe(false);
    } finally {editCheck.every=previous;warn.mockRestore();}
  });
});

describe('what the check does around the queue, the window and a failed rebuild',()=>{
  const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  const fretOf=(controller:DocumentController,bar:number,beat:number)=>controller.getState().score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].notes[0];
  const writesWrong=(wrong:number)=>vi.mocked(engine.editInPlace).mockImplementationOnce((current,command,index)=>engineActual.editInPlace(current,{...command,fret:wrong} as EditCommand,index));
  it('is made once for an export while other actions are queued behind it, and not by a timer while actions wait',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      const calls=vi.mocked(engine.verifyEditStepwise).mock.calls.length;
      const checking=controller.verified();
      // The check is under way (it works in slices that let other work go first) when the others are queued.
      await wait(3);
      const queued=[controller.edit({type:'setNote',target:at(1),string:2,fret:6}),controller.edit({type:'setNote',target:at(2),string:2,fret:7}),controller.save()];
      await Promise.all([checking,...queued]);
      expect(vi.mocked(engine.verifyEditStepwise).mock.calls.length-calls,'the check an action asked for ran once, not again for every action queued behind it').toBe(1);
    } finally {errors.mockRestore();}
  },60000);
  it('does not run on a timer while another action is queued, and runs when the queue is empty',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    const afterMs=idleVerification.afterMs;
    try {
      idleVerification.afterMs=40;
      const bridge=makeBridge(blank());
      const original=bridge.applyEdit;
      bridge.applyEdit=vi.fn(async(command,revision,token)=>{await wait(250);return original(command,revision,token);});
      const controller=await DocumentController.create(bridge);
      const counted=editStats.verified;
      // The second edit is queued while the first runs: the first one finishing must not arm a check that could swap in the middle of the second.
      const first=controller.edit({type:'setNote',target:at(0),string:2,fret:5}),second=controller.edit({type:'setNote',target:at(1),string:2,fret:6});
      await first;await wait(120);
      expect(editStats.verified-counted,'no check while the second edit is queued').toBe(0);
      await second;await wait(400);
      expect(editStats.verified-counted,'a check once the queue is empty').toBe(1);expect(controller.isVerified()).toBe(true);
    } finally {idleVerification.afterMs=afterMs;errors.mockRestore();}
  },60000);
  it('makes no check for a document that was closed, and does not arm one',async()=>{
    const afterMs=idleVerification.afterMs;
    try {
      idleVerification.afterMs=30;
      const controller=await DocumentController.create(makeBridge(blank()));
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      const counted=editStats.verified;controller.dispose();
      await wait(200);
      expect(editStats.verified-counted).toBe(0);expect(controller.isVerified()).toBe(false);
      expect(await controller.verifyNow(),'a closed document is not checked').toBe(false);
    } finally {idleVerification.afterMs=afterMs;}
  });
  it('checks in one go for an export when the window is hidden, where timers are throttled',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.stubGlobal('document',{visibilityState:'hidden'});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      vi.useFakeTimers();
      // With a visible window the check waits on timers, which never fire here.
      const state=await controller.verified();
      expect(state.snapshot.project.edits).toHaveLength(1);expect(controller.isVerified()).toBe(true);
    } finally {vi.useRealTimers();vi.unstubAllGlobals();errors.mockRestore();}
  },60000);
  it('falls back to one uninterrupted rebuild when the stepwise check keeps being cancelled',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      writesWrong(9);
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      const calls=vi.mocked(engine.verifyEditStepwise).mock.calls.length;
      vi.mocked(engine.verifyEditStepwise).mockResolvedValue(null);
      try {
        const state=await controller.verified();
        expect(vi.mocked(engine.verifyEditStepwise).mock.calls.length-calls,'a bounded number of tries').toBe(3);
        expect(state.repaired).toBe(true);expect(fretOf(controller,0,0).fret).toBe(5);expect(controller.isVerified()).toBe(true);
      } finally {vi.mocked(engine.verifyEditStepwise).mockImplementation(engineActual.verifyEditStepwise);}
    } finally {errors.mockRestore();}
  },60000);
});

describe('the checkpoint the check replays from',()=>{
  const lastFrom=()=>vi.mocked(engine.verifyEditStepwise).mock.calls.at(-1)![5];
  const mismatchesBefore=()=>editStats.mismatches;
  it('moves forward with every check that finds the document equal, so a check replays only what came after the last one',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      const base=mismatchesBefore();
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      expect(await controller.verifyNow(async()=>{})).toBe(true);
      expect(lastFrom()?.index,'the first check starts from the document as it was opened').toBe(0);
      await controller.edit({type:'setNote',target:at(1),string:2,fret:6});await controller.edit({type:'setNote',target:at(2),string:2,fret:7});
      expect(await controller.verifyNow(async()=>{})).toBe(true);
      expect(lastFrom()?.index,'the second starts from the first check').toBe(1);
      expect(mismatchesBefore()-base).toBe(0);
    } finally {errors.mockRestore();}
  });
  it('is dropped when an undo goes below it, and the check then replays from the file',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      for(const bar of [0,1,2])await controller.edit({type:'setNote',target:at(bar),string:2,fret:5+bar});
      expect(await controller.verifyNow(async()=>{})).toBe(true);expect(lastFrom()?.index).toBe(0);
      await controller.edit({type:'setNote',target:at(3),string:2,fret:9});expect(await controller.verifyNow(async()=>{})).toBe(true);expect(lastFrom()?.index).toBe(3);
      await controller.undo();await controller.undo();
      expect(controller.getState().snapshot.project.edits).toHaveLength(2);
      expect(await controller.verifyNow(async()=>{})).toBe(true);
      expect(lastFrom(),'a checkpoint above the end of the history is not used').toBeUndefined();
      // And an edit taken back and made again differently is not mistaken for the same history.
      await controller.edit({type:'setNote',target:at(2),string:3,fret:2});
      expect(await controller.verifyNow(async()=>{})).toBe(true);expect(controller.getState().repaired).toBeFalsy();
    } finally {errors.mockRestore();}
  });
  it('carries on across settings edits, which change what is kept beside the score',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const controller=await DocumentController.create(makeBridge(blank()));
      const base=mismatchesBefore();
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});expect(await controller.verifyNow(async()=>{})).toBe(true);
      await controller.edit({type:'setTrackMix',trackId:'base/0',mix:{gain:.5,pan:0,mute:false,solo:false}});
      await controller.edit({type:'setNote',target:at(1),string:2,fret:6});
      expect(await controller.verifyNow(async()=>{})).toBe(true);
      expect(lastFrom()?.index).toBe(1);expect(mismatchesBefore()-base).toBe(0);
      await controller.undo();await controller.undo();await controller.redo();
      expect(await controller.verifyNow(async()=>{})).toBe(true);expect(mismatchesBefore()-base).toBe(0);
    } finally {errors.mockRestore();}
  });
});

describe('a document that cannot be rebuilt from what native holds',()=>{
  // An edit the in-place check accepts and the full replay refuses: the idle check's replay throws and so does the rebuild in one piece.
  const bad=(project:Project)=>project.edits.some(edit=>edit.type==='setNote'&&edit.fret===13);
  const refuseBad=()=>{
    vi.mocked(engine.buildDocument).mockImplementation((project,canRedo)=>{if(bad(project as Project))throw new Error('this edit cannot be replayed');return engineActual.buildDocument(project,canRedo);});
    vi.mocked(engine.verifyEditStepwise).mockImplementation(async(project,...rest)=>{if(bad(project as Project))throw new Error('this edit cannot be replayed');return engineActual.verifyEditStepwise(project,...rest);});
  };
  const allowAll=()=>{vi.mocked(engine.buildDocument).mockImplementation(engineActual.buildDocument);vi.mocked(engine.verifyEditStepwise).mockImplementation(engineActual.verifyEditStepwise);};
  const withBridge=(project:Project)=>{
    const bridge=makeBridge(project),saved:string[]=[];
    const undo=bridge.undo;bridge.undo=vi.fn(undo);
    bridge.saveProject=vi.fn(async()=>{saved.push(JSON.stringify((await bridge.snapshot()).snapshot.project.edits));return null;});
    return {bridge,saved};
  };
  afterEach(allowAll);
  it('takes back the edit that made it unrebuildable, says so, and never saves that edit',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const {bridge,saved}=withBridge(blank());
      const controller=await DocumentController.create(bridge);
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      refuseBad();
      await controller.edit({type:'setNote',target:at(1),string:2,fret:13});
      expect(controller.getState().snapshot.project.edits,'accepted in place').toHaveLength(2);
      await controller.verifyNow(async()=>{});
      const state=controller.getState();
      expect(state.snapshot.project.edits.map(edit=>(edit as {fret:number}).fret),'the last edit was taken back').toEqual([5]);
      expect(state.takenBack,'the user is told how many edits were taken back').toBe(1);
      expect(controller.isBroken()).toBe(false);expect(controller.isVerified()).toBe(true);expect(state.error).toBeNull();
      await controller.save();
      expect(saved).toHaveLength(1);expect(saved[0]).not.toContain('13');
    } finally {errors.mockRestore();warn.mockRestore();}
  },60000);
  it('stays broken when native cannot take the edit back, refuses Save and export with a reason, keeps the alert, and heals with Undo',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const {bridge,saved}=withBridge(blank());
      const controller=await DocumentController.create(bridge);
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      refuseBad();
      await controller.edit({type:'setNote',target:at(1),string:2,fret:13});
      vi.mocked(bridge.undo).mockRejectedValueOnce(new Error('native undo failed'));
      await controller.verifyNow(async()=>{});
      expect(controller.isBroken()).toBe(true);
      const alert=controller.getState().error;expect(alert).toMatch(/Undo/i);expect(alert).toMatch(/without saving/i);
      // Not saveable and not exportable in its broken form; each refusal says why, and none clears the alert.
      await expect(controller.save()).rejects.toThrow(/Undo/i);await expect(controller.save(true)).rejects.toThrow(/Undo/i);
      await expect(controller.export()).rejects.toThrow(/Undo/i);
      await expect(controller.edit({type:'setNote',target:at(2),string:2,fret:6})).rejects.toThrow(/Undo/i);
      await expect(controller.copyMusic({kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack')).rejects.toThrow(/Undo/i);
      expect(saved,'nothing was written').toHaveLength(0);expect(bridge.exportGp).not.toHaveBeenCalled();
      expect(controller.getState().error,'the alert stays while the document is broken').toBe(alert);
      // Undo is allowed: native takes the edit back, then the document is rebuilt from what native holds.
      await controller.undo();
      expect(controller.isBroken()).toBe(false);expect(controller.getState().error).toBeNull();
      expect(controller.getState().takenBack).toBe(1);expect(controller.isVerified()).toBe(true);
      expect(controller.getState().snapshot.project.edits).toHaveLength(1);
      await controller.save();expect(saved).toHaveLength(1);expect(saved[0]).not.toContain('13');
    } finally {errors.mockRestore();warn.mockRestore();}
  },60000);
  it('can be closed while broken without asking to save the broken history',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const {bridge}=withBridge(blank());
      const asked=vi.fn(async()=>'save' as const);bridge.askUnsaved=asked;
      const controller=await DocumentController.create(bridge);
      await controller.edit({type:'setNote',target:at(0),string:2,fret:5});
      refuseBad();
      await controller.edit({type:'setNote',target:at(1),string:2,fret:13});
      vi.mocked(bridge.undo).mockRejectedValueOnce(new Error('native undo failed'));
      await controller.verifyNow(async()=>{});
      expect(controller.isBroken()).toBe(true);
      expect(await controller.requestClose(),'close does not offer to save what cannot be saved').toBe(true);
      expect(asked).not.toHaveBeenCalled();expect(bridge.saveProject).not.toHaveBeenCalled();
    } finally {errors.mockRestore();warn.mockRestore();}
  },60000);
});
