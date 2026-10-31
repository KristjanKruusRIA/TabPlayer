import { expect,it } from 'vitest';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { initialDocumentView,repairDocumentView } from './view-state';
import type { DocumentViewState } from './types';

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
it.each([25,137.5,300,120])('preserves valid zoom %s',zoom=>expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom}).zoom).toBe(zoom));
it.each([24,301,NaN,Infinity,-Infinity])('resets invalid zoom %s',zoom=>expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom}).zoom).toBe(100));

it('retains supplied score display preferences and fractional manual zoom',()=>{
  const view={...initialDocumentView(),scoreDisplay:{layout:'grid' as const,zoomMode:'fitPage' as const},zoom:137.5};
  expect(repairDocumentView(buildScore(blankProject()),view)).toEqual(view);
});

it('repairs old views without adding a score display field',()=>{
  const repaired=repairDocumentView(buildScore(blankProject()),initialDocumentView());
  expect(repaired).toEqual({target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:6,selectedNoteIndex:null,zoom:100,trackView:{kind:'selected'},instrumentVisible:false});
  expect(Object.hasOwn(repaired,'scoreDisplay')).toBe(false);
});
it.each([null,{},[],{layout:'grid'},{layout:'grid',zoomMode:'fitPage',extra:true},{layout:'unknown',zoomMode:'manual'}])('drops malformed score display %j',scoreDisplay=>{
  const view={...initialDocumentView(),scoreDisplay,zoom:137.5} as DocumentViewState;
  const repaired=repairDocumentView(buildScore(blankProject()),view);
  expect(Object.hasOwn(repaired,'scoreDisplay')).toBe(false);
  expect(repaired.zoom).toBe(137.5);
});
it.each(['parchment','verticalScreen','horizontalScreen'] as const)('repairs endless %s fit page while retaining manual zoom',layout=>{
  expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom:137.5,scoreDisplay:{layout,zoomMode:'fitPage'}})).toEqual({...initialDocumentView(),zoom:137.5,scoreDisplay:{layout,zoomMode:'fitWidth'}});
});
it.each([25,137.5,300].flatMap(zoom=>(['manual','fitWidth','fitPage'] as const).map(zoomMode=>({zoom,zoomMode}))))('retains manual $zoom with $zoomMode preference',({zoom,zoomMode})=>{
  expect(repairDocumentView(buildScore(blankProject()),{...initialDocumentView(),zoom,scoreDisplay:{layout:'grid',zoomMode}})).toEqual({...initialDocumentView(),zoom,scoreDisplay:{layout:'grid',zoomMode}});
});
