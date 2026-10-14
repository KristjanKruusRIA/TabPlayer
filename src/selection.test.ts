import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildScore } from './engine';
import { blankProject, type BeatTarget } from './project';
import { repairSelection, validSelectionIndices } from './selection';

const origin: BeatTarget={track:0,staff:0,bar:0,voice:0,beat:0};

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
