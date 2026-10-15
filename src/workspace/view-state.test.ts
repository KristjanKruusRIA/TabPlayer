import { expect,it } from 'vitest';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { initialDocumentView,repairDocumentView } from './view-state';

it('starts with the exact per-document view and no transient editor or transport state',()=>{
  expect(initialDocumentView()).toEqual({target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:6,selectedNoteIndex:null,zoom:100,trackView:{kind:'selected'},instrumentVisible:false});
});
it('repairs cursor, fretted string, note index and removed custom track identities',()=>{
  const score=buildScore(blankProject());
  const view=repairDocumentView(score,{...initialDocumentView(),target:{track:99,staff:-1,bar:99,voice:NaN,beat:99},selectedString:99,selectedNoteIndex:0,trackView:{kind:'custom',trackIds:['gone',trackIdentity(score.tracks[0])]}});
  expect(view.target).toEqual({track:0,staff:0,bar:3,voice:0,beat:3});
  expect(view.selectedString).toBe(6);expect(view.selectedNoteIndex).toBeNull();expect(view.trackView).toEqual({kind:'custom',trackIds:['base/0']});
  expect(repairDocumentView(score,{...view,trackView:{kind:'custom',trackIds:['gone']}}).trackView).toEqual({kind:'selected'});
});
it('uses string one on nonfretted staff and preserves only existing selected note indices',()=>{
  const score=buildScore({...blankProject(),edits:[{type:'setNote',target:initialDocumentView().target,string:6,fret:7}]});
  expect(repairDocumentView(score,{...initialDocumentView(),selectedNoteIndex:0}).selectedNoteIndex).toBe(0);
  score.tracks[0].staves[0].stringTuning.tunings=[];
  expect(repairDocumentView(score,initialDocumentView()).selectedString).toBe(1);
});
it.each([25,300,120])('preserves valid zoom %s',zoom=>expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom}).zoom).toBe(zoom));
it.each([24,301,NaN,Infinity,-Infinity])('resets invalid zoom %s',zoom=>expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom}).zoom).toBe(100));
