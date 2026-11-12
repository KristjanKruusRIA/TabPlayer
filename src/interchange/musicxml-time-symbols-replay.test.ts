// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { blankProject,type Project } from '../project';
import type { EditCommand } from '../edit-types';
import { buildScore } from '../engine';
import { loadInterchangeScore } from './gp';

// The MusicXML time-symbol carry changes the score a MusicXML-based project replays from. Palette edits record
// `commonTime` per bar, so a log made over the stock import must keep replaying over it. The carry is gated like
// the file's partial capo: a project with history and no marker replays stock; a project with none, or marked, carries.
const settings=new Settings();
const measure=(number:number,time:string)=>`<measure number="${number}"><attributes><divisions>1</divisions>${time}</attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>`;
const header='<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">';
const symbolOnFirst=strToU8(`${header}${measure(1,'<time symbol="common"><beats>4</beats><beat-type>4</beat-type></time>')}${measure(2,'')}${measure(3,'')}</part></score-partwise>`);
const numeric=strToU8(`${header}${measure(1,'<time><beats>4</beats><beat-type>4</beat-type></time>')}${measure(2,'')}${measure(3,'')}</part></score-partwise>`);
const baseOf=(bytes:Uint8Array):Project['base']=>({kind:'file',filename:'source.musicxml',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:'0'.repeat(64)});
const projectOf=(bytes:Uint8Array,edits:EditCommand[]=[],marked=false):Project=>({...blankProject(),base:baseOf(bytes),edits,...marked?{partialCapo:true as const}:{}});
const flags=(score:model.Score)=>score.masterBars.slice(0,3).map(master=>master.timeSignatureCommon);
const edit:EditCommand={type:'appendMeasure'};
const oldCommonTime:EditCommand={type:'setMasterBarGestures',bar:1,commonTime:false,doubleBar:false,tripletFeel:0,beaming:null};

describe('replay of a MusicXML project',()=>{
  it('an old log over the symbol on measure 1 replays to the flags it always did',()=>{
    expect(flags(loadInterchangeScore(symbolOnFirst,settings,false))).toEqual([true,false,false]);
    const old=projectOf(symbolOnFirst,[oldCommonTime,edit]);
    expect(flags(buildScore(old))).toEqual([true,false,false]);
  });
  it('a project with no history carries the symbol, as does plain open and a marked one',()=>{
    expect(flags(buildScore(projectOf(symbolOnFirst)))).toEqual([true,true,true]);
    expect(flags(buildScore(projectOf(symbolOnFirst,[edit],true)))).toEqual([true,true,true]);
    expect(flags(loadInterchangeScore(symbolOnFirst,settings))).toEqual([true,true,true]);
  });
});

/** A native stand-in with the same refusals as `ProjectSession::mark_partial_capo`. */
async function controllerFor(bytes:Uint8Array) {
  const { DocumentController } = await import('../controller');
  let project=projectOf(bytes),revision=0;
  const record=()=>({documentId:'document-a',revision,snapshot:{project:structuredClone(project),canUndo:project.edits.length>0,canRedo:false,redoEdit:null,dirty:false,path:null}});
  const markPartialCapo=vi.fn(async(expected:number)=>{expect(expected).toBe(revision);project={...project,partialCapo:true};revision++;return record();});
  const applyEdit=vi.fn(async(command:EditCommand,expected:number)=>{expect(expected).toBe(revision);project={...project,edits:[...project.edits,command]};revision++;return record();});
  const controller=await DocumentController.create({documentId:'document-a',snapshot:async()=>record(),markPartialCapo,applyEdit} as never);
  return {controller,markPartialCapo,project:()=>project};
}
describe('the first edit of a MusicXML file whose symbol was carried',()=>{
  it('marks the project first, so the log keeps replaying over the carry',async()=>{
    const held=await controllerFor(symbolOnFirst);
    expect(flags(held.controller.getState().score)).toEqual([true,true,true]);
    await held.controller.edit(edit);
    expect(held.markPartialCapo).toHaveBeenCalledTimes(1);expect(held.project().partialCapo).toBe(true);
    expect(flags(buildScore(held.project()))).toEqual([true,true,true]);
  });
  it('does not mark a file the carry did not change',async()=>{
    const plain=await controllerFor(numeric);
    await plain.controller.edit(edit);
    expect(plain.markPartialCapo).not.toHaveBeenCalled();
  });
});
