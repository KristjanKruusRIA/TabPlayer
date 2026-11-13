import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { rhythmTicks } from './common';
import { scoreFromJson } from '../model-clone';
import { restoreNoteLinks } from './links';
import type { ClipboardCommand,MusicClip } from './clipboard-types';

const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const range=(start:[number,number],end:[number,number])=>({kind:'range' as const,range:{start:{bar:start[0],tick:start[1]},end:{bar:end[0],tick:end[1]},lanes:[{track:0,staff:0,voice:0}]}});
const decode=(clip:MusicClip)=>{const score=scoreFromJson(clip.scoreJson,new Settings());restoreNoteLinks(score,clip.links.map(link=>({...link,slideOutType:link.slideOutType??undefined})));return score;};
const beatsOf=(score:model.Score,bar:number)=>score.tracks[0].staves[0].bars[bar].voices[0].beats;
const total=(score:model.Score,bar:number)=>beatsOf(score,bar).reduce((sum,beat)=>sum+rhythmTicks(beat),0);
const shapes=(score:model.Score,bar:number)=>beatsOf(score,bar).map(beat=>[beat.duration,beat.dots]);
/** Bar 0 becomes [first, then quarters]; `first` is a sustained beat of the given written length. */
function sustained(duration:number,dots=0,quarters=0) {
  const score=music(),bar=score.tracks[0].staves[0].bars[0],voice=bar.voices[0];
  const lead=voice.beats[0];lead.duration=duration;lead.dots=dots;voice.beats=[lead];
  for(let index=0;index<quarters;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=5;note.fret=2;beat.addNote(note);voice.addBeat(beat);}
  return scoreFromJson(json(score),new Settings());
}

it('a range starting inside a sustained beat copies only the tail as tied-free exact time',()=>{
  const score=sustained(2,0,2),before=json(score),clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(1440+1920);expect(shapes(copy,0)[0]).toEqual([4,1]);expect(clip.links).toEqual([]);expect(json(score)).toBe(before);
});
it('a range ending inside a sustained beat copies only the head and drops the link to the excluded remainder',()=>{
  const score=sustained(2,0,2),before=json(score),clip=makeMusicClip(score,range([0,0],[0,480]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(480);expect(shapes(copy,0)).toEqual([[8,0]]);expect(clip.links).toEqual([]);expect(json(score)).toBe(before);
});
it('cuts on both sides leave exactly the middle',()=>{
  const score=sustained(1),clip=makeMusicClip(score,range([0,960],[0,2880]),'singleTrack'),copy=decode(clip);
  expect(total(copy,0)).toBe(1920);expect(shapes(copy,0)).toEqual([[2,0]]);
});
it('a dotted note cut exactly splits into plain written lengths',()=>{
  const score=sustained(2,1,0),clip=makeMusicClip(score,range([0,0],[0,960]),'singleTrack');
  expect(total(decode(clip),0)).toBe(960);expect(shapes(decode(clip),0)).toEqual([[4,0]]);
  const tail=makeMusicClip(score,range([0,960],[0,2880]),'singleTrack');expect(shapes(decode(tail),0)).toEqual([[2,0]]);
});
it('pieces inside the selection are tied in sequence and paste as valid ties',()=>{
  const score=sustained(2,0,0),clip=makeMusicClip(score,range([0,0],[0,1200]),'singleTrack'),copy=decode(clip);
  expect(shapes(copy,0)).toEqual([[4,0],[16,0]]);expect(clip.links.map(link=>link.kind)).toEqual(['tie']);expect(total(copy,0)).toBe(1200);
  const destination=music(),command:ClipboardCommand={type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar:1,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}};
  const result=preparePasteMusic(destination,command).score,pasted=result.tracks[0].staves[0].bars[1].voices[0].beats;
  expect(pasted[0].notes[0].tieDestination).toBe(pasted[1].notes[0]);expect(pasted[1].notes[0].isTieDestination).toBe(true);
});
it('a chord ties every note',()=>{
  const score=sustained(2,0,0),beat=beatsOf(score,0)[0],extra=new model.Note();extra.string=4;extra.fret=2;beat.addNote(extra);
  const clip=makeMusicClip(score,range([0,0],[0,1200]),'singleTrack');expect(clip.links.filter(link=>link.kind==='tie')).toHaveLength(2);expect(decode(clip).tracks[0].staves[0].bars[0].voices[0].beats[1].notes).toHaveLength(2);
});
it('a cut across a barline copies the tail of one measure and the head of the next',()=>{
  const score=music(),staff=score.tracks[0].staves[0];
  for(const bar of [0,1]){const voice=staff.bars[bar].voices[0],lead=voice.beats[0];lead.duration=1;voice.beats=[lead];}
  const copy=scoreFromJson(json(score),new Settings()),clip=makeMusicClip(copy,range([0,2880],[1,480]),'singleTrack'),result=decode(clip);
  expect(total(result,0)).toBe(960);expect(total(result,1)).toBe(480);expect(shapes(result,0)).toEqual([[4,0]]);expect(shapes(result,1)).toEqual([[8,0]]);
});
it('a tuplet beat splits into the same tuplet or refuses',()=>{
  const score=sustained(8,0,0),lead=beatsOf(score,0)[0];lead.tupletNumerator=3;lead.tupletDenominator=2;
  const clip=makeMusicClip(score,range([0,0],[0,160]),'singleTrack'),piece=beatsOf(decode(clip),0)[0];
  expect([piece.duration,piece.tupletNumerator,piece.tupletDenominator]).toEqual([16,3,2]);expect(total(decode(clip),0)).toBe(160);
  expect(()=>makeMusicClip(score,range([0,0],[0,1]),'singleTrack')).toThrow(/exact written length/);
});
it('a bent note refuses the cut and a plain copy of whole beats still works',()=>{
  const score=sustained(2,0,0),note=beatsOf(score,0)[0].notes[0];note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));
  expect(()=>makeMusicClip(score,range([0,0],[0,480]),'singleTrack')).toThrow(/bent note/);
  expect(makeMusicClip(score,range([0,0],[0,1920]),'singleTrack').links).toEqual([]);
});
it('a slide leaves from the final piece, so a head-only copy drops it and a tail copy keeps it',()=>{
  const score=sustained(2,0,1),first=beatsOf(score,0)[0].notes[0],next=beatsOf(score,0)[1].notes[0];
  first.string=5;first.fret=2;first.slideOutType=model.SlideOutType.Shift;first.slideTarget=next;next.slideOrigin=first;
  const head=decode(makeMusicClip(score,range([0,0],[0,480]),'singleTrack')).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(head.slideOutType).toBe(model.SlideOutType.None);
  const clip=makeMusicClip(score,range([0,480],[1,0]),'singleTrack');expect(clip.links.map(link=>link.kind)).toEqual(['slide']);
  const tail=decode(clip).tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];expect(tail.slideOutType).toBe(model.SlideOutType.Shift);
});
it('cut refuses a range that cuts a sustained beat but cut of whole beats is unchanged',()=>{
  const score=sustained(2,0,2);
  expect(()=>makeMusicClip(score,range([0,480],[1,0]),'singleTrack',{cut:true})).toThrow(/beat boundaries/);
  expect(makeMusicClip(score,range([0,1920],[1,0]),'singleTrack',{cut:true}).kind).toBe('phrase');
});
