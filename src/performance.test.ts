import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildScore, previewEdit } from './engine';
import { blankProject, type Project } from './project';
it('loads and edits a 100-measure four-track score without a blocking stall',()=>{
  let project:Project={...blankProject(),base:{kind:'blank',title:'Performance study',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:100},edits:[
    {type:'addTrack',name:'Rhythm',tuning:[64,59,55,50,45,40],program:27},
    {type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33},
    {type:'addTrack',name:'Guitar 2',tuning:[64,59,55,50,45,40],program:25}
  ]};
  const started=performance.now();const score=buildScore(project);const loadMs=performance.now()-started;
  expect(score.masterBars.length).toBe(100);expect(score.tracks.length).toBe(4);
  const editMs=[];for(let i=0;i<20;i++){const start=performance.now();project=previewEdit(project,{type:'setNote',target:{track:i%4,staff:0,bar:i,voice:0,beat:0},string:1,fret:i%12}).project;editMs.push(performance.now()-start);}
  expect(loadMs).toBeLessThan(2000);expect(Math.max(...editMs)).toBeLessThan(2000);
  writeFileSync('.analysis/performance-project.tabplayer',JSON.stringify(project));
  writeFileSync('.analysis/performance-metrics.json',JSON.stringify({measures:100,tracks:4,loadMs,editMedianMs:[...editMs].sort((a,b)=>a-b)[10],editMaxMs:Math.max(...editMs)},null,2));
},30000);
