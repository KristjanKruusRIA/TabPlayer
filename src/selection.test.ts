import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildScore,previewEdit } from './engine';
import { blankProject, type BeatTarget } from './project';
import { followSelectedTrack,movedTrackIndex,repairMeasureSelection,repairSelection, validSelectionIndices } from './selection';

const origin: BeatTarget={track:0,staff:0,bar:0,voice:0,beat:0};
it('maps a measure cursor to retained music or the removed bar successor',()=>{
  const inserted=previewEdit(blankProject(),{type:'insertMeasures',beforeBar:1,count:2});
  expect(repairMeasureSelection(inserted.score,{...origin,bar:2},{oldToNew:[0,3,4,5],inserted:[1,2]})).toEqual({...origin,bar:4});
  const removed=previewEdit(inserted.project,{type:'removeMeasures',firstBar:0,lastBar:1});
  const map={oldToNew:[null,null,0,1,2,3],inserted:[]};
  expect(repairMeasureSelection(removed.score,{...origin,bar:4},map)).toEqual({...origin,bar:2});
  expect(repairMeasureSelection(removed.score,{...origin,bar:0},map)).toEqual(origin);
});

it('rejects fractional, negative and non-finite selection indices',()=>{
  expect(validSelectionIndices(origin)).toBe(true);
  for (const field of Object.keys(origin)) {
    for (const value of [1.5,-1,NaN,Infinity,-Infinity]) {
      expect(validSelectionIndices({...origin,[field]:value})).toBe(false);
    }
  }
});

it('repairs_deleted_staff_voice_and_empty_bar',()=>{
  const score=buildScore(blankProject());
  const staff=new model.Staff();score.tracks[0].addStaff(staff);
  for (const _ of score.masterBars) {
    const bar=new model.Bar();
    for (let i=0;i<2;i++) {const voice=new model.Voice();voice.addBeat(new model.Beat());bar.addVoice(voice);}
    staff.addBar(bar);
  }
  const selected={track:0,staff:1,bar:3,voice:1,beat:0};
  expect(repairSelection(score,selected)).toEqual(selected);
  score.tracks[0].staves.pop();
  score.tracks[0].staves[0].bars[3].voices[0].beats.splice(0);
  expect(repairSelection(score,selected)).toEqual({track:0,staff:0,bar:3,voice:0,beat:0});
});

it('repairs malformed indices to zero and clamps existing beat locations',()=>{
  const score=buildScore(blankProject());
  for (const field of Object.keys(origin)) {
    for (const value of [1.5,-1,NaN,Infinity]) {
      expect(repairSelection(score,{...origin,[field]:value})).toEqual(origin);
    }
  }
  expect(repairSelection(score,{track:5,staff:3,bar:8,voice:2,beat:10})).toEqual({track:0,staff:0,bar:3,voice:0,beat:3});
});

it('follows tracks through a move',()=>{
  const move={track:1,to:3};
  // The moved track goes to its target; the tracks it passed shift back by one.
  expect([0,1,2,3,4].map(index=>movedTrackIndex(index,move))).toEqual([0,3,1,2,4]);
  expect([0,1,2,3].map(index=>movedTrackIndex(index,{track:3,to:0}))).toEqual([1,2,3,0]);
});

it('keeps the selected track when Undo or Redo reorders tracks',()=>{
  const added=previewEdit(previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project,{type:'addPitchedTrack',name:'Keys',program:0});
  const moved=previewEdit(added.project,{type:'moveTrack',track:1,to:0}),target={track:0,staff:0,bar:0,voice:0,beat:0};
  // Undo: Bass at 0 returns to 1; Redo: back to 0. A track that no longer exists keeps its index for repair.
  expect(followSelectedTrack(moved.score,added.score,target).track).toBe(1);
  expect(followSelectedTrack(added.score,moved.score,{...target,track:1}).track).toBe(0);
  expect(followSelectedTrack(added.score,moved.score,{...target,track:2}).track).toBe(2);
  expect(followSelectedTrack(added.score,previewEdit(added.project,{type:'removeTrack',track:2}).score,{...target,track:2}).track).toBe(2);
});
