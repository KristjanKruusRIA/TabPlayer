import { expect, it } from 'vitest';
import { buildDocument, editsFitLive, previewEdit, registerLiveDocument } from '../engine';
import { blankProject, type EditCommand, type Project } from '../project';
import { applyInOrder } from './input-preferences';

const slow=(project:Project,commands:EditCommand[])=>{try{let built=previewEdit(project,commands[0]);for(const command of commands.slice(1))built=previewEdit(built.project,command,built);return true;}catch{return false;}};
const at=(bar:number,beat:number)=>({track:0,staff:0,bar,voice:0,beat});

it('answers whether commands apply in order from the open document, as building a document for each would',()=>{
  const project:Project={...blankProject(),base:{kind:'blank',title:'T',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:4},edits:[]};
  const built=buildDocument(project);registerLiveDocument(project,{...built,snapshot:{project} as never} as never);
  const cases:EditCommand[][]=[
    [{type:'setDuration',target:at(0,0),duration:8,dots:0},{type:'setNote',target:at(0,0),string:2,fret:5}],
    [{type:'setNote',target:at(0,0),string:2,fret:5}],
    [{type:'setNote',target:at(0,0),string:9,fret:5}],
    [{type:'setDuration',target:at(0,0),duration:1,dots:0},{type:'insertBeat',target:at(0,1),duration:4,dots:0}],
    [{type:'setDuration',target:at(0,0),duration:2,dots:0},{type:'insertBeat',target:at(0,1),duration:2,dots:0},{type:'setNote',target:at(0,1),string:1,fret:3}],
  ];
  for(const commands of cases)expect(applyInOrder(project,commands),JSON.stringify(commands)).toBe(slow(project,commands));
  // They were answered from the open document, not by building one.
  for(const commands of cases)expect(editsFitLive(project,commands),JSON.stringify(commands)).not.toBeNull();
});

it('does not answer for what a sequence cannot hold: it says it does not know',()=>{
  const project:Project={...blankProject(),base:{kind:'blank',title:'T',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:4},edits:[]};
  registerLiveDocument(project,{...buildDocument(project),snapshot:{project} as never} as never);
  const note=(fret:number):EditCommand=>({type:'setNote',target:at(0,0),string:2,fret});
  expect(editsFitLive(project,[note(1),{type:'deleteBeat',target:at(0,0)}]),'a pair with a beat deletion').toBeNull();
  expect(editsFitLive(project,Array.from({length:9},(_,index)=>note(index))),'more than eight commands').toBeNull();
  expect(editsFitLive(project,Array.from({length:8},(_,index)=>note(index))),'eight commands are a sequence').toBe(true);
  // The full path still gives the caller its answer.
  expect(applyInOrder(project,[note(1),{type:'deleteBeat',target:at(0,0)}]),'one after the other, which a sequence is not').toBe(true);
});
