import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { buildPlaybackPlan } from '../audio/plan';
import { loadInterchangeScore } from './gp';

const settings=new Settings(),path='Content/score.gpif';
const parse=(text:string)=>new DOMParser().parseFromString(text,'application/xml');
function load(gestures:boolean) {
  const entries=unzipSync(new exporter.Gp7Exporter().export(music(),settings));
  if(gestures) {
    const doc=parse(strFromU8(entries[path])),authored=parse(readFileSync('src/interchange/fixtures/gesture-routes.gpif','utf8'));
    for(const [list,item] of [['Beats','Beat'],['Notes','Note']] as const) {
      const targets=[...doc.querySelectorAll(`GPIF > ${list} > ${item}`)];
      [...authored.querySelectorAll(`GPIF > ${list} > ${item}`)].forEach((fragment,index)=>{
        for(const child of fragment.children) {
          const existing=child.localName==='Properties'?targets[index].querySelector(':scope > Properties'):null;
          if(existing)for(const property of child.children)existing.append(doc.importNode(property,true));
          else targets[index].append(doc.importNode(child,true));
        }
      });
    }
    entries[path]=strToU8(new XMLSerializer().serializeToString(doc));
  }
  return loadInterchangeScore(zipSync(entries),settings);
}
const notesAt=(score:model.Score,bar:number,beat:number)=>buildPlaybackPlan(score,1).notes.filter(note=>note.source.target.bar===bar&&note.source.target.beat===beat);

// THE-60 characterisation of the gesture sound routes of the native playback plan. The beats and notes carry
// the gestures through the hand-authored fragment in fixtures/gesture-routes.gpif, grafted onto an alphaTab-written
// skeleton of four 4/4 bars of quarter notes (fret 3 on string 6). No .analysis/compatibility folder is needed.
it('characterizes the gesture sound routes: slap, pop and tap each get their own articulation, and a dead slap becomes six dead strikes, one per string',()=>{
  const score=load(true),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  expect(beats.slice(0,4).map(beat=>[beat.slap,beat.pop,beat.tap,beat.deadSlapped])).toEqual([[true,false,false,false],[false,true,false,false],[false,false,true,false],[false,false,false,true]]);
  expect([0,1,2].map(beat=>notesAt(score,0,beat).map(note=>[note.articulation,note.key,note.velocity,note.startTick,note.endTick]))).toEqual([
    [['slap',67,95,0,960]],[['pop',67,95,960,1920]],[['tapped',67,95,1920,2880]],
  ]);
  const dead=notesAt(score,0,3);
  expect(dead.map(note=>[note.articulation,note.key,note.source.string,note.startTick,note.endTick])).toEqual([
    ['dead',64,6,2880,2940],['dead',59,5,2880,2940],['dead',55,4,2880,2940],['dead',50,3,2880,2940],['dead',45,2,2880,2940],['dead',40,1,2880,2940],
  ]);
  // The dead slap replaces the written quarter note: the beat is struck for 60 ticks, not its written 960.
  expect(notesAt(load(false),0,3).map(note=>[note.articulation,note.endTick-note.startTick])).toEqual([['picked',960]]);
});

it('characterizes golpe as having no sound route of its own: both golpe types are kept on the beat, yet the planned note equals a plain note exactly',()=>{
  const score=load(true),plain=load(false),beats=score.tracks[0].staves[0].bars[1].voices[0].beats;
  expect(beats.slice(0,3).map(beat=>beat.golpe)).toEqual([model.GolpeType.Thumb,model.GolpeType.Finger,model.GolpeType.None]);
  for(const beat of [0,1,2]) {
    const planned=notesAt(score,1,beat);
    expect(planned).toHaveLength(1);
    expect(planned).toEqual(notesAt(plain,1,beat));
    expect([planned[0].articulation,planned[0].key,planned[0].velocity,planned[0].startTick,planned[0].endTick,planned[0].lockedArticulation]).toEqual(['picked',67,95,3840+960*beat,4800+960*beat,undefined]);
  }
});
