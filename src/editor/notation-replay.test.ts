import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { blankProject,type EditCommand } from '../project';
import { buildScore,previewEdit } from '../engine';
import { getTrackLyrics } from './lyrics';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const beat=(score:model.Score,bar=0,index=0)=>score.tracks[0].staves[0].bars[bar].voices[0].beats[index];
const replay=(edits:EditCommand[])=>buildScore({...blankProject(),edits});
const notes:EditCommand[]=Array.from({length:8},(_,i)=>({type:'setNote',target:{...target,bar:Math.floor(i/4),beat:i%4},string:1,fret:i}));

it('replays lyrics raw source through history, structural rebuilds and note-rest changes',()=>{
  const raw='[VERSE]\nHel-lo  world+today end';
  const edits:EditCommand[]=[...notes,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:raw}]},{type:'appendMeasure'},{type:'setRest',target:{...target,beat:0}}];
  const score=replay(edits);
  expect(getTrackLyrics(score,0)).toEqual({visible:true,lines:[{startBar:0,text:raw}],source:'raw'});
  expect(beat(score).lyrics).toBeNull();expect(beat(score,0,1).lyrics).toEqual(['Hel-']);expect(beat(score,0,2).lyrics).toEqual(['lo']);
  const project={...blankProject(),edits};
  const hidden=previewEdit(project,{type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:0,text:raw}]}).project;
  expect(beat(buildScore(JSON.parse(JSON.stringify(hidden))),0,1).lyrics).toBeNull();
  expect(beat(buildScore({...hidden,edits:hidden.edits.slice(0,-1)}),0,1).lyrics).toEqual(['Hel-']);
  expect(getTrackLyrics(buildScore(hidden),0).visible).toBe(false);
  const before=JSON.stringify(project);expect(()=>previewEdit(project,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:99,text:'bad'}]})).toThrow();expect(JSON.stringify(project)).toBe(before);
});
it('retains lyrics identity after removing preceding tracks and adjusts starts before bar deletion',()=>{
  const edits:EditCommand[]=[{type:'addPitchedTrack',name:'Singer',program:0},{type:'addPitchedNote',target:{...target,track:1,bar:2},pitch:60},
    {type:'setTrackLyrics',track:1,visible:true,lines:[{startBar:2,text:'voice'}]},{type:'removeTrack',track:0},{type:'removeMeasure',bar:0}];
  const score=replay(edits);expect(score.tracks[0].name).toBe('Singer');
  expect(getTrackLyrics(score,0).lines).toEqual([{startBar:1,text:'voice'}]);expect(beat(score,1).lyrics).toEqual(['voice']);
});
it('replays gesture ranges, audible dynamics and bar fields with exact undo prefixes',()=>{
  const edits:EditCommand[]=[...notes,
    {type:'setBeatGestures',target,patch:{slap:true,stem:'inverted',showTimer:true}},
    {type:'setOttava',from:target,to:{...target,beat:2},ottava:1},
    {type:'setCrescendo',from:target,to:{...target,beat:3},crescendo:1,targetDynamics:7},
    {type:'setBarGestures',track:0,staff:0,bar:0,clefOttava:1},
    {type:'setMasterBarGestures',bar:0,commonTime:true,doubleBar:true,tripletFeel:0,beaming:null},
    {type:'setSimile',track:0,staff:0,bar:1,kind:'single'}];
  const score=replay(edits);
  expect(beat(score)).toMatchObject({slap:true,invertBeamDirection:true,showTimer:true,ottava:1,dynamics:5});
  expect(beat(score,0,3).notes[0].dynamics).toBe(7);expect(beat(score,0,3).ottava).toBe(model.Ottavia.Regular);
  expect(score.masterBars[0]).toMatchObject({timeSignatureCommon:true,isDoubleBar:true});
  expect(score.tracks[0].staves[0].bars[0].clefOttava).toBe(1);expect(score.tracks[0].staves[0].bars[1].simileMark).toBe(model.SimileMark.Simple);
  expect(beat(score).timer).toBe(0);expect(score.tracks[0].staves[0].bars[1].simileMark).not.toBe(replay(edits.slice(0,-1)).tracks[0].staves[0].bars[1].simileMark);
});
it('resolves fermata offset from current rhythm and clearing survives full replay',()=>{
  const edits:EditCommand[]=[...notes,{type:'setDuration',target,duration:8,dots:0},
    {type:'setFermata',target:{...target,beat:1},fermata:{type:2,length:1.5}},{type:'appendMeasure'}];
  const score=replay(edits);expect(score.masterBars[0].fermata?.get(480)).toMatchObject({type:2,length:1.5});expect(beat(score,0,1).fermata).not.toBeNull();
  const cleared=replay([...edits,{type:'setFermata',target:{...target,beat:1},fermata:null}]);
  expect(cleared.masterBars[0].fermata?.size??0).toBe(0);expect(beat(cleared,0,1).fermata).toBeNull();
});
