import { expect,it } from 'vitest';
import { buildScore,previewEdit,exportGp } from '../engine';
import { blankProject } from '../project';
import { importer,Settings } from '@coderline/alphatab';
import { music,noteAt } from '../editor/fixtures';
import { selectScore,selectStaves } from './selection';
import { mkdirSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
function phraseScore(){
  const score=music(),origin=noteAt(score),destination=noteAt(score,2);
  destination.string=5;destination.fret=7;noteAt(score,1,3).string=5;noteAt(score,1,3).fret=4;score.finish(new Settings());
  origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;return score;
}
it('selected GP snapshot keeps the chosen music and repairs relationships cut by range',()=>{
  let p=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project;
  p=previewEdit(p,{type:'setNote',target:{track:1,staff:0,bar:1,voice:0,beat:0},string:1,fret:5}).project;
  p=previewEdit(p,{type:'setNote',target:{track:1,staff:0,bar:0,voice:0,beat:3},string:1,fret:5}).project;
  const original=buildScore(p);original.title='Selected';const note=original.tracks[1].staves[0].bars[1].voices[0].beats[0].notes[0];note.isTieDestination=true;
  const selected=selectScore(original,{tracks:[1],range:{first:1,last:2}});
  expect(selected.tracks).toHaveLength(1);expect(selected.masterBars).toHaveLength(2);expect(selected.tracks[0].name).toBe('Bass');
  expect(selected.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(5);
  expect(original.tracks).toHaveLength(2);expect(original.masterBars).toHaveLength(4);
  const round=importer.ScoreLoader.loadScoreFromBytes(exportGp(selected),new Settings());expect(round.tracks).toHaveLength(1);expect(round.masterBars).toHaveLength(2);
});
it('exports only explicitly selected staves and rejects an empty staff set',()=>{
  let p=previewEdit(blankProject(),{type:'addStaff',track:0,settings:{tuning:[43,38,33,28],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true}}).project;
  p=previewEdit(p,{type:'setNote',target:{track:0,staff:1,bar:0,voice:0,beat:0},string:1,fret:5}).project;
  const original=buildScore(p);const selected=selectScore(original,{tracks:[0],range:null,staves:{0:[1]}});
  expect(selected.tracks[0].staves).toHaveLength(1);expect(selected.tracks[0].staves[0].tuning).toEqual([43,38,33,28]);expect(original.tracks[0].staves).toHaveLength(2);
  expect(()=>selectScore(original,{tracks:[0],range:null,staves:{0:[]}})).toThrow(/staff|staves/i);
});
it('retains an explicit nonadjacent cross-string phrase origin in selected copies',()=>{
  const score=phraseScore();
  for(const selected of [selectStaves(score,{tracks:[0],range:null,staves:{0:[0]}}),selectScore(score,{tracks:[0],range:{first:0,last:2}})]){
    expect(noteAt(selected,2).slurOrigin).toBe(noteAt(selected));expect(noteAt(selected).slurDestination).toBe(noteAt(selected,2));
    expect(noteAt(selected,2).slurOrigin).not.toBe(noteAt(selected,1,3));expect(noteAt(selected)).not.toBe(noteAt(score));
  }
  expect(noteAt(score).slurDestination).toBe(noteAt(score,2));expect(noteAt(score,2).slurOrigin).toBe(noteAt(score));
});
it('records public GP phrase-slur coverage independently of the selected model relationship',()=>{
  const original=phraseScore(),selected=selectScore(original,{tracks:[0],range:null});const results=[];
  for(const [kind,score]of [['direct',original],['selected',selected]] as const){
    const bytes=exportGp(score),reopened=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings()),origin=noteAt(score),destination=noteAt(score,2);
    expect(destination.slurOrigin?.id).toBe(origin.id);expect(noteAt(reopened,2).string).toBe(5);expect(noteAt(reopened,2).fret).toBe(7);
    const after=noteAt(reopened,2).slurOrigin;results.push({kind,retained:after===noteAt(reopened),before:{originBar:origin.beat.voice.bar.index,originBeat:origin.beat.index,originString:origin.string,destinationBar:destination.beat.voice.bar.index,destinationString:destination.string},after:after?{originBar:after.beat.voice.bar.index,originBeat:after.beat.index,originString:after.string}:null,exportSha256:createHash('sha256').update(bytes).digest('hex')});
    mkdirSync('.analysis/expansion',{recursive:true});writeFileSync(`.analysis/expansion/phrase-slur-${kind}.gp`,bytes);
  }
  writeFileSync('.analysis/expansion/gp-export-phrase-slur-coverage.json',JSON.stringify({engineVersion:'1.8.4',results},null,2));
  expect(noteAt(original).slurDestination).toBe(noteAt(original,2));expect(noteAt(selected).slurDestination).toBe(noteAt(selected,2));
});
it('detaches a phrase slur when either explicit endpoint falls outside the selected range',()=>{
  const score=phraseScore(),left=selectScore(score,{tracks:[0],range:{first:0,last:1}}),right=selectScore(score,{tracks:[0],range:{first:1,last:3}});
  expect(noteAt(left).slurDestination).toBeNull();expect(noteAt(right,1).slurOrigin).toBeNull();expect(noteAt(right,1).isSlurDestination).toBe(false);
  const reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(right),new Settings());expect(noteAt(reopened,1).isSlurDestination).toBe(false);
  expect(noteAt(score).slurDestination).toBe(noteAt(score,2));expect(noteAt(score,2).slurOrigin).toBe(noteAt(score));
});
