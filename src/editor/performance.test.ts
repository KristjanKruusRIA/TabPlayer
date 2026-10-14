import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildScore, previewEdit } from '../engine';
import { blankProject, type EditCommand } from '../project';
import { target } from './fixtures';

it('records expanded 100-bar four-track replay and voice-copy timings',()=>{
  const initial=blankProject();if(initial.base.kind==='blank')initial.base.measureCount=100;
  const edits:EditCommand[]=[];
  for(let track=1;track<4;track++)edits.push({type:'addTrack',name:`Instrument ${track+1}`,tuning:[64,59,55,50,45,40],program:25+track});
  for(let track=0;track<4;track++)for(let voice=1;voice<4;voice++)edits.push({type:'addVoice',track,staff:0});
  edits.push({type:'setNote',target,string:6,fret:3});const project={...initial,edits};
  let start=performance.now();const score=buildScore(project),buildMs=performance.now()-start;expect(score.tracks).toHaveLength(4);expect(score.masterBars).toHaveLength(100);
  start=performance.now();const technique=previewEdit(project,{type:'setNoteTechniques',target,string:6,patch:{palmMute:true}}),techniqueMs=performance.now()-start;
  start=performance.now();const copy=previewEdit(technique.project,{type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:0,endBar:99}),voiceCopyMs=performance.now()-start;
  expect(copy.score.tracks[0].staves[0].bars[0].voices[1].beats[0].notes[0].isPalmMute).toBe(true);
  mkdirSync('.analysis/expansion',{recursive:true});writeFileSync('.analysis/expansion/editor-performance.json',JSON.stringify({bars:100,tracks:4,voicesPerStaff:4,buildMs,techniqueMs,voiceCopyMs},null,2));
},30_000);
