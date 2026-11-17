import {expect,it} from 'vitest';
import {model} from '@coderline/alphatab';
import {blankProject} from '../project';
import {buildScore} from '../engine';
import type {EditCommand} from '../edit-types';
import {preparePlanFromScore} from './plan';
import {chordAudition,editAudition,readAuditionWhileEditing,scaleAudition,tuningAudition,writeAuditionWhileEditing} from './audition';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const standard=[64,59,55,50,45,40];
it('builds one-string and low-to-high strum notes at the tuning pitch',()=>{
  expect(tuningAudition([40],false)).toEqual({notes:[{key:40,startMs:0,velocity:96}],durationMs:1500});
  expect(tuningAudition(standard,true)).toEqual({notes:[40,45,50,55,59,64].map((key,index)=>({key,startMs:index*60,velocity:96})),durationMs:1500});
  expect(tuningAudition(Array.from({length:14},(_,index)=>30+index),true).notes).toHaveLength(12);
});
it('sounds an edited fret at tuning + fret + capo - transposition, matching the playback plan',async()=>{
  const score=buildScore(blankProject()),staff=score.tracks[0].staves[0];
  expect(editAudition(score,{type:'setNote',target,string:6,fret:5})).toEqual({track:0,percussion:false,notes:[{key:69,startMs:0,velocity:96}],durationMs:800});
  staff.capo=2;staff.transpositionPitch=3;
  const command:EditCommand={type:'setNote',target,string:5,fret:7},heard=editAudition(score,command)!;
  expect(heard.notes).toEqual([{key:59+7+2-3,startMs:0,velocity:96}]);
  // The same note as planned for playback.
  const beat=staff.bars[0].voices[0].beats[0],note=new model.Note();note.string=5;note.fret=7;beat.addNote(note);beat.isEmpty=false;
  const plan=await preparePlanFromScore(score,1);expect(plan.notes.map(item=>item.key)).toContain(heard.notes[0].key);
});
it('hears pitched and percussion entries, and nothing else',()=>{
  const piano=buildScore({...blankProject(),edits:[{type:'addPitchedTrack',name:'Keys',program:0}]}),drums=buildScore({...blankProject(),edits:[{type:'addPercussionTrack',name:'Drums',program:0}]});
  piano.tracks[1].staves[0].transpositionPitch=-12;
  expect(editAudition(piano,{type:'addPitchedNote',target:{...target,track:1},pitch:60})?.notes[0].key).toBe(72);
  expect(editAudition(piano,{type:'setPitchedNote',target:{...target,track:1},noteIndex:0,pitch:62})?.notes[0].key).toBe(74);
  const kick=editAudition(drums,{type:'addPercussionNote',target:{...target,track:1},articulation:36});
  expect(kick).toMatchObject({track:1,percussion:true,notes:[{key:36}]});
  expect(editAudition(drums,{type:'setPercussionNote',target:{...target,track:1},noteIndex:0,articulation:-3})).toBeNull();
  const silent:EditCommand[]=[{type:'setRest',target},{type:'removeNote',target,string:6},{type:'removeNoteByIndex',target,noteIndex:0},{type:'deleteBeat',target},{type:'setDuration',target,duration:4,dots:0},{type:'insertBeat',target,duration:4,dots:0},{type:'setTuning',track:0,tuning:standard}];
  for(const command of silent)expect(editAudition(piano,command)).toBeNull();
  expect(editAudition(piano,{type:'setNote',target:{...target,track:9},string:1,fret:0})).toBeNull();
});
it('stores the editing preference with a default of on and survives broken storage',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  expect(readAuditionWhileEditing(storage)).toBe(true);
  writeAuditionWhileEditing(false,storage);expect([...values]).toEqual([['tabplayer.audition.whileEditing','off']]);expect(readAuditionWhileEditing(storage)).toBe(false);
  writeAuditionWhileEditing(true,storage);expect(readAuditionWhileEditing(storage)).toBe(true);
  const broken={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  expect(readAuditionWhileEditing(broken)).toBe(true);expect(()=>writeAuditionWhileEditing(false,broken)).not.toThrow();expect(readAuditionWhileEditing(undefined)).toBe(true);
});

it('strums a chord low to high at the staff keys, skipping muted strings',()=>{
  const score=buildScore(blankProject()),staff=score.tracks[0].staves[0];
  // A major, strings listed high to low: x 0 2 2 2 0 read from the low end.
  expect(chordAudition(staff,[0,2,2,2,0,-1])).toEqual({notes:[45,52,57,61,64].map((key,index)=>({key,startMs:index*60,velocity:96})),durationMs:1500});
  staff.capo=2;staff.transpositionPitch=3;
  expect(chordAudition(staff,[-1,-1,-1,-1,-1,0])?.notes).toEqual([{key:40+2-3,startMs:0,velocity:96}]);
  expect(chordAudition(staff,[-1,-1,-1,-1,-1,-1])).toBeNull();
  expect(chordAudition(staff,[0,0,0])).toBeNull();
  staff.isPercussion=true;expect(chordAudition(staff,[0,0,0,0,0,0])).toBeNull();
});
it('bounds a chord to twelve notes inside the native start limit',()=>{
  const score=buildScore(blankProject()),staff=score.tracks[0].staves[0];
  staff.stringTuning.tunings=Array.from({length:14},(_,index)=>30+index);
  const heard=chordAudition(staff,Array.from({length:14},()=>0))!;
  expect(heard.notes).toHaveLength(12);expect(Math.max(...heard.notes.map(note=>note.startMs))).toBeLessThanOrEqual(1000);
});
it('plays a scale ascending from the root, moved by octaves into the instrument range',()=>{
  const score=buildScore(blankProject()),staff=score.tracks[0].staves[0],cMajor=[60,62,64,65,67,69,71,72];
  expect(scaleAudition(staff,cMajor)).toEqual({notes:cMajor.map((key,index)=>({key,startMs:index*120,velocity:96})),durationMs:600});
  staff.stringTuning.tunings=[43,38,33,28];
  expect(scaleAudition(staff,cMajor)?.notes.map(note=>note.key)).toEqual(cMajor.map(key=>key-12));
  expect(scaleAudition(staff,Array.from({length:14},(_,index)=>60+index))?.notes).toHaveLength(12);
  expect(Math.max(...scaleAudition(staff,Array.from({length:14},(_,index)=>60+index))!.notes.map(note=>note.startMs))).toBeLessThanOrEqual(1000);
  expect(scaleAudition(staff,[])).toBeNull();
  staff.isPercussion=true;expect(scaleAudition(staff,cMajor)).toBeNull();
});
