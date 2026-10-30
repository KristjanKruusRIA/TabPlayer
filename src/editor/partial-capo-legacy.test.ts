// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject, appliesFilePartialCapo, type Project } from '../project';
import type { EditCommand, StaffSettings } from '../edit-types';
import type { HarmonyChord } from './harmony-types';
import { buildDocument, buildScore, exportGp, validateProject } from '../engine';
import { makeMusicClip } from './clipboard-source';
import { getPartialCapo } from './partial-capo';

const at=(bar:number,beat=0)=>({track:0,staff:0,bar,voice:0,beat});
const standard:StaffSettings={tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const partial={fret:2,strings:[2,3,4]};
const note=(bar:number,string:number,fret:number):EditCommand=>({type:'setNote',target:at(bar),string,fret});
/** What a GP file made before the feature looked like to the editor: frets on every string, no partial capo anywhere in the log. */
const notes:EditCommand[]=[note(0,1,5),note(0,6,0),note(1,2,0),note(1,4,2),note(1,3,2)];
const ofBlank=(...edits:EditCommand[]):Project=>({...blankProject(),edits});
/** A GP file as bytes; with `capo` it holds a partial capo over strings 2-4 at fret 2, which the older builds never read. */
const baseFile=(capo:boolean):Project['base']=>{
  const score=buildScore(ofBlank(...(capo?[{type:'setStaffSettings',track:0,staff:0,settings:{...standard,partialCapo:partial}} as EditCommand]:[]),...notes)),bytes=exportGp(score);
  return {kind:'file',filename:'old.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:'0'.repeat(64)};
};
const dump=(score:model.Score)=>score.tracks.map(track=>track.staves.map(staff=>[staff.tuning.length,staff.bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>[beat.chordId,beat.notes.map(item=>[item.string,item.fret,item.realValue,item.isPalmMute])]))) ]));
const withBase=(base:Project['base'],edits:EditCommand[],marked=false):Project=>({...blankProject(),base,edits,...(marked?{partialCapo:true as const}:{})});
const bases=()=>({plain:baseFile(false),holding:baseFile(true)});
const em:HarmonyChord={name:'Em',nameMode:'theory',recipe:{root:{step:2,alteration:0},formula:'minor',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,0,0,2,2,0],fingers:[-2,-2,-2,-2,-2,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true};
const strippedScore=()=>buildScore(withBase(bases().plain,[]));
const logs:Record<string,()=>EditCommand[]>={
  'move to the string above':()=>[{type:'moveSelectionStrings',selection:{kind:'notes',notes:[{target:at(0),noteIndex:0}]},direction:'higher'}],
  'set string count 6 to 5 keeping the high strings':()=>[{type:'setStringCount',track:0,tuning:[64,59,55,50,45],keep:'high'}],
  'transpose a note':()=>[{type:'transposeSelection',selection:{kind:'notes',notes:[{target:at(0),noteIndex:0}]},semitones:2}],
  'refinger a bar':()=>[{type:'refingerSelection',selection:{kind:'bars',tracks:[0],firstBar:1,lastBar:1},maxFret:12}],
  'refinger a palm-muted note':()=>[{type:'setSelectionSustain',selection:{kind:'bars',tracks:[0],firstBar:1,lastBar:1},strings:[2],kind:'palmMute',enabled:true},{type:'refingerSelection',selection:{kind:'bars',tracks:[0],firstBar:1,lastBar:1},maxFret:12}],
  'transpose the harmony':()=>[{type:'transposeHarmony',selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:1},interval:{kind:'semitones',semitones:2},includeKeySignatures:false,includeChords:false}],
  'paste an old clip':()=>[{type:'pasteMusic',clip:makeMusicClip(strippedScore(),{kind:'bars',tracks:[0],firstBar:1,lastBar:1},'singleTrack'),options:{target:at(0),destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}}],
  'fill a theory chord': ()=>[{type:'setHarmonyChord',target:at(2),chord:em,fillEmptyBeat:true}],
};

describe('a project logged before partial capo support, on a GP base that holds a partial capo',()=>{
  it('is not marked, and the capo in its base is not applied',()=>{
    const project=withBase(baseFile(true),[note(2,1,1)]);
    expect(appliesFilePartialCapo(project)).toBe(false);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const score=buildScore(project);
    expect(getPartialCapo(score.tracks[0].staves[0])).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not applied'));
    warn.mockRestore();
  });
  it.each(Object.keys(logs))('replays the old log "%s" exactly as before the feature',name=>{
    const {plain,holding}=bases(),edits=logs[name]();
    const before=buildScore(withBase(plain,edits));
    let after!:model.Score;
    expect(()=>{after=buildScore(withBase(holding,edits));}).not.toThrow();
    expect(dump(after)).toEqual(dump(before));
    // A saved copy reopens to the same notes, and nothing in it changed.
    const saved=JSON.parse(JSON.stringify(withBase(holding,edits)));
    expect(dump(buildScore(validateProject(saved)))).toEqual(dump(before));
    expect('partialCapo' in saved).toBe(false);
  });
  it('still takes a partial capo set by a staff settings edit',()=>{
    const score=buildScore(withBase(baseFile(true),[{type:'setStaffSettings',track:0,staff:0,settings:{...standard,partialCapo:{fret:3,strings:[1]}}}]));
    expect(getPartialCapo(score.tracks[0].staves[0])).toEqual({fret:3,strings:[1]});
    expect(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.find(item=>item.string===1)!.realValue).toBe(40+3+5);
  });
});

describe('a project that has no edits, or is marked',()=>{
  it('applies the base partial capo while it has no edits, with and without the marker',()=>{
    for(const project of [withBase(baseFile(true),[]),withBase(baseFile(true),[],true)]){
      expect(appliesFilePartialCapo(project)).toBe(true);
      const staff=buildScore(project).tracks[0].staves[0];
      expect(getPartialCapo(staff)).toEqual(partial);
      expect(staff.bars[1].voices[0].beats[0].notes.find(item=>item.string===2)!.realValue).toBe(45+2+0);
    }
  });
  it('keeps applying it after the first edit once marked, and replays the same after a save and reopen',()=>{
    const marked=withBase(baseFile(true),[note(2,2,3),{type:'moveSelectionStrings',selection:{kind:'notes',notes:[{target:at(2),noteIndex:0}]},direction:'lower'}],true);
    const first=buildDocument(marked);
    expect(getPartialCapo(first.score.tracks[0].staves[0])).toEqual(partial);
    expect(first.score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].realValue).toBe(45+2+3);
    const reopened=validateProject(JSON.parse(JSON.stringify(marked)));
    expect(reopened.partialCapo).toBe(true);
    expect(dump(buildScore(reopened))).toEqual(dump(first.score));
    expect(dump(buildScore(reopened))).toEqual(dump(buildScore(reopened)));
    // The same edits without the marker are the old reading of the file.
    expect(dump(buildScore(withBase(baseFile(true),marked.edits)))).not.toEqual(dump(first.score));
  });
  it('writes the marker only when set, and only for a file base',()=>{
    expect(Object.keys(blankProject())).not.toContain('partialCapo');
    expect(()=>validateProject({...blankProject(),partialCapo:true})).toThrow(/marker/);
    expect(()=>validateProject({...withBase(baseFile(false),[]),partialCapo:false})).toThrow(/marker/);
    expect(validateProject(withBase(baseFile(false),[],true)).partialCapo).toBe(true);
  });
});

describe('the first edit of a file with a partial capo',()=>{
  /** A native stand-in that keeps the marker and edit log the way the document workspace does. */
  async function controllerFor(base:Project['base'],edits:EditCommand[]=[]) {
    const { DocumentController } = await import('../controller');
    let project:Project={...blankProject(),base,edits},revision=0;
    const record=()=>({documentId:'document-a',revision,snapshot:{project:structuredClone(project),canUndo:project.edits.length>0,canRedo:false,dirty:false,path:null}});
    const markPartialCapo=vi.fn(async(expected:number)=>{expect(expected).toBe(revision);if(!project.partialCapo){project={...project,partialCapo:true};revision++;}return record();});
    const applyEdit=vi.fn(async(command:EditCommand,expected:number)=>{expect(expected).toBe(revision);project={...project,edits:[...project.edits,command]};revision++;return record();});
    const bridge={documentId:'document-a',snapshot:async()=>record(),markPartialCapo,applyEdit,undo:vi.fn(),redo:vi.fn()} as never;
    return {controller:await DocumentController.create(bridge),markPartialCapo,applyEdit,project:()=>project};
  }
  it('marks the project before the first edit, once, and not for a file without a partial capo',async()=>{
    const held=await controllerFor(baseFile(true));
    expect(held.controller.getState().snapshot.project.partialCapo).toBeUndefined();
    await held.controller.edit(note(2,2,3));
    expect(held.markPartialCapo).toHaveBeenCalledTimes(1);expect(held.markPartialCapo.mock.invocationCallOrder[0]).toBeLessThan(held.applyEdit.mock.invocationCallOrder[0]);
    expect(held.project().partialCapo).toBe(true);
    expect(getPartialCapo(held.controller.getState().score.tracks[0].staves[0])).toEqual(partial);
    expect(held.controller.getState().score.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].realValue).toBe(45+2+3);
    await held.controller.edit(note(2,3,3));expect(held.markPartialCapo).toHaveBeenCalledTimes(1);
    const plain=await controllerFor(baseFile(false));await plain.controller.edit(note(2,2,3));expect(plain.markPartialCapo).not.toHaveBeenCalled();
    const blank=await controllerFor(blankProject().base);await blank.controller.edit(note(0,2,3));expect(blank.markPartialCapo).not.toHaveBeenCalled();
  });
  it('leaves a project that already has a log unmarked, so its file capo stays unapplied',async()=>{
    const old=await controllerFor(baseFile(true),[note(2,1,1)]);
    await old.controller.edit(note(2,2,3));
    expect(old.markPartialCapo).not.toHaveBeenCalled();expect(old.project().partialCapo).toBeUndefined();
    expect(getPartialCapo(old.controller.getState().score.tracks[0].staves[0])).toBeNull();
  });
});
