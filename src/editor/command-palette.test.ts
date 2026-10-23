import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { searchCommands,type PaletteContext } from './command-palette';
import { buildScore,previewEdit } from '../engine';
import { blankProject,type Project } from '../project';

const context=(patch:Partial<PaletteContext>={}):PaletteContext=>({score:music(),target,string:6,canUndo:true,canRedo:false,...patch});
const first=(query:string,patch?:Partial<PaletteContext>)=>searchCommands(query,context(patch))[0];

it('lists every command for an empty query and narrows by word prefixes in any order',()=>{
  const all=searchCommands('',context()).map(match=>match.title);
  expect(all).toEqual(expect.arrayContaining(['Go to measure','Go to track','Set fret','Set duration','Set initial tempo','Insert beat','Delete beat','Make rest','Append measure','Remove measure','Undo','Redo','Play or pause','New score','Open score','Import ASCII tab','Help topics','About and updates','Save','Save As','Export score']));
  expect(searchCommands('meas app',context()).map(match=>match.title)).toEqual(['Append measure']);
  expect(searchCommands('zzz',context())).toEqual([]);
  expect(searchCommands('measure 3',context()).map(match=>match.title)).toEqual(['Go to measure']);
  expect(all).not.toContain('Set time signature');
  // Title words outrank aliases, so "remove" offers Remove measure before anything else.
  expect(searchCommands('remove',context()).map(match=>match.title)).toEqual(['Remove measure']);
  expect(searchCommands('delete',context()).map(match=>match.title)).toEqual(['Delete beat','Remove measure']);
});

it('builds validated edits and navigation from typed parameters',()=>{
  expect(first('go to measure 3')).toMatchObject({title:'Go to measure',action:{kind:'select',target:{track:0,staff:0,bar:2,voice:0,beat:0}}});
  expect(first('fret 7')).toMatchObject({title:'Set fret',action:{kind:'edit',command:{type:'setNote',target,string:6,fret:7}}});
  expect(first('tempo 96')).toMatchObject({action:{kind:'edit',command:{type:'setScoreInfo',title:'',artist:'',tempo:96}}});
  expect(first('duration 1/8')).toMatchObject({action:{kind:'edit',command:{type:'setBeatRhythm',target,duration:8,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0}}});
  expect(first('duration 1 / 8')?.action).toMatchObject({command:{duration:8}});
  expect(first('tempo 92.5')).toMatchObject({title:'Set initial tempo',action:{command:{tempo:92.5}}});
  expect(first('duration 16')?.action).toMatchObject({command:{duration:16}});
  expect(first('insert beat')).toMatchObject({action:{kind:'edit',command:{type:'insertBeat',target,duration:4,dots:0}}});
  expect(first('remove measure')).toMatchObject({action:{kind:'edit',command:{type:'removeMeasure',bar:0}}});
  expect(first('undo')).toMatchObject({action:{kind:'app',name:'undo'}});
  expect(first('track 1',{target:{...target,bar:2,beat:3,voice:1}})).toMatchObject({action:{kind:'select',target:{track:0,staff:0,bar:2,voice:0,beat:0}}});
});

it('explains missing or invalid parameters instead of offering an action',()=>{
  const cases:[string,string][]=[
    ['measure','Type a measure number from 1 to 4.'],['measure 5','Type a measure number from 1 to 4.'],['measure 2.5','Type a measure number from 1 to 4.'],
    ['track 2','Type a track number from 1 to 1.'],['fret','Type a fret from 0 to 99.'],['fret 100','Type a fret from 0 to 99.'],
    ['tempo 0','Type a tempo from 1 to 999 BPM.'],['duration 3','Type a duration: 1, 2, 4, 8, 16, 32 or 64 (or 1/8).'],
    ['fret -1','Type a fret from 0 to 99.'],['measure 1 2','Type a single value after the command.'],['tempo 1000','Type a tempo from 1 to 999 BPM.'],
  ];
  for(const [query,error] of cases){expect(first(query),query).toMatchObject({error});expect(first(query)?.action,query).toBeUndefined();}
  expect(first('redo')).toMatchObject({error:'Nothing to redo.'});expect(first('redo')?.action).toBeUndefined();
  expect(first('remove measure',{score:(()=>{const score=music();score.masterBars.splice(1);for(const staff of score.tracks[0].staves)staff.bars.splice(1);return score;})()})).toMatchObject({error:'A score needs at least one measure.'});
});

it('refuses note commands where they cannot apply',()=>{
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;drums.finish(new Settings());
  expect(first('fret 3',{score:drums})).toMatchObject({error:'Frets apply to fretted tracks.'});expect(first('fret 3',{score:drums})?.action).toBeUndefined();
  const empty=music(),voice=empty.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(0);const placeholder=new model.Beat();placeholder.isEmpty=true;voice.addBeat(placeholder);empty.finish(new Settings());
  expect(first('delete beat',{score:empty})).toMatchObject({error:'Select an existing beat.'});
  // String 1 is the low E (40), which stops at fret 87; string 6 is the high E (64), which stops at fret 63.
  expect(first('fret 87',{string:1})?.action).toBeDefined();expect(first('fret 88',{string:1})).toMatchObject({error:'That fret would sound above the highest MIDI pitch.'});
  expect(first('fret 64',{string:6})).toMatchObject({error:'That fret would sound above the highest MIDI pitch.'});expect(first('fret 63',{string:6})?.action).toBeDefined();
  expect(first('duration 8',{score:empty})).toMatchObject({error:'Select an existing beat.'});
});

it('builds edits the engine accepts on a real document',()=>{
  let project:Project=blankProject();
  for(const query of ['fret 5','duration 8','tempo 96.5','insert beat','make rest','append measure','remove measure','delete beat']){
    const match=first(query,{score:buildScore(project),string:1});
    expect(match?.action?.kind,query).toBe('edit');
    if(match?.action?.kind!=='edit')continue;
    project=previewEdit(project,match.action.command).project;
  }
  expect(project.edits.map(edit=>edit.type)).toEqual(['setNote','setBeatRhythm','setScoreInfo','insertBeat','setRest','appendMeasure','removeMeasure','deleteBeat']);
});
