// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { buildDocument,previewEdit,replayDocumentSettings,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { BAR_SCALE_BIG_STEP,BAR_SCALE_STEP,barScaleOf,clampBarScale,mapBarWidths,scaleAfterDrag,sourceBarScale,sourceWeight,validateBarWidths,withBarScale,withBarWidths } from './bar-widths';
import { defaultEngraving,projectEngraving,validateEngraving } from './projection';
import { defaultStyle,styleApplied,styleOf } from './style-library';
import { withTypography } from './typography';
import type { EngravingOverrides } from './types';

const widths=(...entries:Array<[number,number]>):EngravingOverrides=>withBarWidths(defaultEngraving(),entries.map(([bar,scale])=>({bar,scale})));
const midiBytes=(score:model.Score)=>{
  const file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file,true)).generate();
  return Buffer.from(file.toBinary()).toString('base64');
};
const authored=()=>previewEdit(previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5}).project,{type:'setNote',target:{track:0,staff:0,bar:2,voice:0,beat:0},string:5,fret:3});

it('accepts only ordered, bounded, non-default widths and keeps old shapes valid',()=>{
  validateEngraving(defaultEngraving());validateEngraving(widths([0,1.5],[1,1],[3,.25],[99_999,4]));validateEngraving({...defaultEngraving(),barWidths:[]});
  for(const bad of [[{bar:1,scale:.24}],[{bar:1,scale:4.01}],[{bar:1,scale:0}],[{bar:1,scale:-2}],[{bar:1,scale:Number.NaN}],[{bar:1,scale:Number.POSITIVE_INFINITY}],[{bar:1,scale:'2'}],[{bar:-1,scale:2}],[{bar:1.5,scale:2}],[{bar:100_000,scale:2}],[{bar:2,scale:2},{bar:1,scale:2}],[{bar:2,scale:2},{bar:2,scale:3}],[{bar:1}],[{bar:1,scale:2,extra:true}],[null],{bar:1,scale:2},null])
    expect(()=>validateEngraving({...defaultEngraving(),barWidths:bad}),JSON.stringify(bad)).toThrow();
  expect(()=>validateBarWidths(Array.from({length:10_001},(_,bar)=>({bar,scale:2})))).toThrow();
  expect(()=>validateBarWidths(Array.from({length:10_000},(_,bar)=>({bar,scale:2})))).not.toThrow();
  // The default engraving, and one saved before bar widths, carry no such field.
  expect(Object.hasOwn(defaultEngraving(),'barWidths')).toBe(false);
});

it('records a width as one change, drops a restored bar, and records nothing for the current value',()=>{
  const base=defaultEngraving(),one=withBarScale(base,2,1.5);
  expect(one.barWidths).toEqual([{bar:2,scale:1.5}]);expect(base.barWidths).toBeUndefined();
  expect(withBarScale(one,2,1.5)).toBe(one);expect(withBarScale(base,2,1)).toBe(base);expect(withBarScale(one,2,1.504)).toBe(one);
  const two=withBarScale(one,0,.5);expect(two.barWidths).toEqual([{bar:0,scale:.5},{bar:2,scale:1.5}]);
  const back=withBarScale(two,2,1);expect(back.barWidths).toEqual([{bar:0,scale:.5}]);
  const none=withBarScale(back,0,1);expect(Object.hasOwn(none,'barWidths')).toBe(false);expect(none).toEqual(base);
  expect(barScaleOf(two,0)).toBe(.5);expect(barScaleOf(two,1)).toBe(1);
  expect(withBarScale(base,1,9).barWidths).toEqual([{bar:1,scale:4}]);expect(withBarScale(base,1,0).barWidths).toEqual([{bar:1,scale:.25}]);
  expect(()=>withBarScale(base,-1,2)).toThrow();expect(()=>withBarScale(base,1.5,2)).toThrow();
  // Other engraving choices ride along untouched.
  const typed=withTypography(base,{family:'serif',textScale:null,titleScale:null,tabScale:null});
  expect(withBarScale(typed,1,2).typography?.family).toBe('serif');
  expect(clampBarScale(BAR_SCALE_STEP+1)).toBe(1.1);expect(clampBarScale(1+BAR_SCALE_BIG_STEP)).toBe(1.5);
});

it('turns a drag into a bounded weight, ignoring a bar with no width or a bad distance',()=>{
  expect(scaleAfterDrag(1,200,100)).toBe(1.5);expect(scaleAfterDrag(1,200,-100)).toBe(.5);expect(scaleAfterDrag(2,100,-1000)).toBe(.25);expect(scaleAfterDrag(2,100,100000)).toBe(4);
  expect(scaleAfterDrag(1,0,50)).toBe(1);expect(scaleAfterDrag(1,200,Number.NaN)).toBe(1);
});

it('lays the widths on the rendered copy only and leaves the source and its MIDI untouched',()=>{
  const built=authored(),source=built.score,ids=source.tracks.map(trackIdentity);
  const before=model.JsonConverter.scoreToJson(source),beforeMidi=midiBytes(source);
  const projected=projectEngraving(source,ids,widths([1,2],[2,.5],[3,1.25],[40,3]));
  expect(projected.score.masterBars.map(bar=>bar.displayScale)).toEqual([1,2,.5,1.25]);
  for(const staff of projected.score.tracks.flatMap(track=>track.staves))expect(staff.bars.map(bar=>bar.displayScale)).toEqual([1,2,.5,1.25]);
  expect(source.masterBars.every(bar=>bar.displayScale===1)).toBe(true);expect(model.JsonConverter.scoreToJson(source)).toBe(before);
  // Timing is the music's alone: the rendered copy and the source generate the same MIDI file.
  expect(midiBytes(projected.score)).toBe(beforeMidi);expect(midiBytes(source)).toBe(beforeMidi);
  expect(projected.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(5);
});

it('replays an old log with default widths and keeps new widths through undo, redo, save and reopen',()=>{
  const built=authored(),base=built.settings.engraving;
  expect(base.barWidths).toBeUndefined();
  const widened=previewEdit(built.project,{type:'setEngraving',engraving:withBarScale(base,1,1.6)},built);
  expect(widened.settings.engraving.barWidths).toEqual([{bar:1,scale:1.6}]);expect(widened.project.edits).toHaveLength(built.project.edits.length+1);
  // The music and its timing are exactly what they were.
  expect(widened.score).toBe(built.score);expect(midiBytes(widened.score)).toBe(midiBytes(built.score));
  const narrowed=previewEdit(widened.project,{type:'setEngraving',engraving:withBarScale(widened.settings.engraving,3,.4)},widened);
  expect(narrowed.settings.engraving.barWidths).toEqual([{bar:1,scale:1.6},{bar:3,scale:.4}]);
  const restored=previewEdit(narrowed.project,{type:'setEngraving',engraving:withBarWidths(narrowed.settings.engraving,[])},narrowed);
  expect(restored.settings.engraving).toEqual(base);expect(Object.hasOwn(JSON.parse(JSON.stringify(restored.project.edits.at(-1))).engraving,'barWidths')).toBe(false);
  const undone=replayDocumentSettings(narrowed.project,restored),twice=replayDocumentSettings(widened.project,undone),first=replayDocumentSettings(built.project,twice),redone=replayDocumentSettings(restored.project,first);
  expect(undone.settings.engraving.barWidths).toEqual([{bar:1,scale:1.6},{bar:3,scale:.4}]);expect(twice.settings.engraving.barWidths).toEqual([{bar:1,scale:1.6}]);
  expect(first.settings.engraving).toEqual(base);expect(redone.settings.engraving).toEqual(base);
  // Saved and reopened: the log is plain JSON and rebuilds the same settings.
  const reopened=buildDocument(JSON.parse(JSON.stringify(narrowed.project)));
  expect(reopened.settings.engraving.barWidths).toEqual([{bar:1,scale:1.6},{bar:3,scale:.4}]);expect(midiBytes(reopened.score)).toBe(midiBytes(built.score));
  // An old log, written before bar widths existed, rebuilds with every bar at its default.
  const old=JSON.parse(JSON.stringify(previewEdit(built.project,{type:'setEngraving',engraving:{...defaultEngraving(),systemSpacing:1.5}},built).project));
  expect(JSON.stringify(old)).not.toContain('barWidths');
  expect(buildDocument(old).settings.engraving).toEqual({...defaultEngraving(),systemSpacing:1.5});
});

it('refuses out-of-range widths in a command or a saved log, and tolerates a width for a bar that is gone',()=>{
  const built=authored(),bad=(barWidths:unknown)=>({...defaultEngraving(),barWidths} as EngravingOverrides);
  for(const barWidths of [[{bar:1,scale:9}],[{bar:2,scale:2},{bar:1,scale:2}]]){
    expect(()=>previewEdit(built.project,{type:'setEngraving',engraving:bad(barWidths)},built)).toThrow();
    const log={...built.project,edits:[...built.project.edits,{type:'setEngraving',engraving:bad(barWidths)}]};
    expect(()=>buildDocument(JSON.parse(JSON.stringify(log)))).toThrow();
  }
  // A width past the end of the score (a log that shrank some other way) is ignored, not an error.
  const stale=previewEdit(built.project,{type:'setEngraving',engraving:widths([3,2])},built);
  expect(()=>projectEngraving(stale.score,stale.score.tracks.map(trackIdentity),widths([40,2]))).not.toThrow();
});

it('keeps widths out of saved styles while a style applied to a document keeps its own widths',()=>{
  const current=widths([1,2]);current.systemSpacing=2;
  expect(styleOf(current).barWidths).toBeUndefined();expect(defaultStyle().barWidths).toBeUndefined();
  const applied=styleApplied(defaultStyle(),current);expect(applied.barWidths).toEqual([{bar:1,scale:2}]);expect(applied.systemSpacing).toBeNull();
  expect(styleApplied(defaultStyle(),defaultEngraving())).toEqual(defaultEngraving());
});

it('sets a width against the weight the score itself gives the bar, so an imported weight is visible and restorable',()=>{
  expect(sourceBarScale(2)).toBe(2);expect(sourceBarScale(0)).toBe(1);expect(sourceBarScale(Number.NaN)).toBe(1);expect(sourceBarScale(undefined)).toBe(1);expect(sourceBarScale(99)).toBe(4);
  const base=defaultEngraving();
  // A bar imported at 2: showing 2, the current value records nothing, 1 is a real override, and 2 again clears it.
  expect(barScaleOf(base,0,2)).toBe(2);expect(withBarScale(base,0,2,2)).toBe(base);
  const one=withBarScale(base,0,1,2);expect(one.barWidths).toEqual([{bar:0,scale:1}]);expect(barScaleOf(one,0,2)).toBe(1);
  expect(Object.hasOwn(withBarScale(one,0,2,2),'barWidths')).toBe(false);
  // The imported weight is what a rendered copy without an override keeps, and an override replaces.
  const score=authored().score;score.masterBars[0].displayScale=2;score.tracks[0].staves[0].bars[0].displayScale=2;
  const ids=score.tracks.map(trackIdentity);
  expect(projectEngraving(score,ids,base).score.masterBars[0].displayScale).toBe(2);
  expect(projectEngraving(score,ids,one).score.masterBars[0].displayScale).toBe(1);expect(projectEngraving(score,ids,one).score.tracks[0].staves[0].bars[0].displayScale).toBe(1);
});

it('moves widths with their bars when measures are inserted or removed, in the same replay as the edit',()=>{
  const map=(removed:number)=>Array.from({length:4},(_,bar)=>bar<removed?bar:bar===removed?null:bar-1);
  const set=widths([0,.5],[1,2],[3,3]);
  expect(mapBarWidths(set,map(1)).barWidths).toEqual([{bar:0,scale:.5},{bar:2,scale:3}]);
  expect(Object.hasOwn(mapBarWidths(widths([1,2]),map(1)),'barWidths')).toBe(false);expect(mapBarWidths(defaultEngraving(),map(0))).toEqual(defaultEngraving());
  expect(mapBarWidths(widths([1,2]),[0,2,3,4]).barWidths).toEqual([{bar:2,scale:2}]);expect(mapBarWidths(widths([9,2]),map(0)).barWidths).toBeUndefined();
  const built=authored(),styled=previewEdit(built.project,{type:'setEngraving',engraving:set},built);
  const removed=previewEdit(styled.project,{type:'removeMeasure',bar:1},styled);
  expect(removed.settings.engraving.barWidths).toEqual([{bar:0,scale:.5},{bar:2,scale:3}]);
  expect(buildDocument(JSON.parse(JSON.stringify(removed.project))).settings.engraving.barWidths).toEqual([{bar:0,scale:.5},{bar:2,scale:3}]);
  const replayed=replayDocumentSettings(removed.project,styled);expect(replayed.settings.engraving.barWidths).toEqual([{bar:0,scale:.5},{bar:2,scale:3}]);
  const inserted=previewEdit(styled.project,{type:'insertMeasures',beforeBar:1,count:2},styled);
  expect(inserted.settings.engraving.barWidths).toEqual([{bar:0,scale:.5},{bar:3,scale:2},{bar:5,scale:3}]);
  expect(replayDocumentSettings(inserted.project,styled).settings.engraving.barWidths).toEqual([{bar:0,scale:.5},{bar:3,scale:2},{bar:5,scale:3}]);
  const several=previewEdit(styled.project,{type:'removeMeasures',firstBar:0,lastBar:1},styled);
  expect(several.settings.engraving.barWidths).toEqual([{bar:1,scale:3}]);
  expect(buildDocument(JSON.parse(JSON.stringify(several.project))).settings.engraving.barWidths).toEqual([{bar:1,scale:3}]);
});

it('reads the own weight of the score where alphaTab does: the bar for one staff, the master bar for several',()=>{
  const bar=(displayScale:number)=>({displayScale}),staff=(...scales:number[])=>({bars:scales.map(bar)});
  const score=(master:number[],tracks:number[][][])=>({masterBars:master.map(bar),tracks:tracks.map(staves=>({staves:staves.map(scales=>staff(...scales))}))});
  // Bar-only weights (master bars at 1) and master-bar-only weights (bars at 1), in one-track and two-track views.
  const barOnly=score([1,1],[[[2,3]],[[1,1]]]),masterOnly=score([2,3],[[[1,1]],[[1,1]]]);
  expect([sourceWeight(barOnly,[0],0),sourceWeight(barOnly,[0],1)]).toEqual([2,3]);
  expect([sourceWeight(barOnly,[0,1],0),sourceWeight(barOnly,[0,1],1)]).toEqual([1,1]);
  expect([sourceWeight(masterOnly,[0],0),sourceWeight(masterOnly,[0],1)]).toEqual([1,1]);
  expect([sourceWeight(masterOnly,[0,1],0),sourceWeight(masterOnly,[0,1],1)]).toEqual([2,3]);
  // Two staves of one track also use the master bar; a missing or unusable weight reads 1.
  expect(sourceWeight(score([2],[[[1],[1]]]),[0],0)).toBe(2);expect(sourceWeight(barOnly,[0],9)).toBe(1);expect(sourceWeight(score([0],[[[Number.NaN]]]),[0],0)).toBe(1);
});
