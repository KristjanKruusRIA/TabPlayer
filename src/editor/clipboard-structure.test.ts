import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { music } from './fixtures';
import { makeMusicClip } from './clipboard-source';
import { pasteGestureProblem,preparePasteMusic } from './clipboard-paste';
import { scoreFromJson } from '../model-clone';
import { Settings } from '@coderline/alphatab';
import type { ClipboardCommand,MusicClip,PasteFilters } from './clipboard-types';

const D=model.Direction,filters:PasteFilters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:true,sections:true};
const bars=(score:model.Score,first:number,last:number,mode:'singleTrack'|'multiTrack'='multiTrack')=>makeMusicClip(score,{kind:'bars',tracks:[0],firstBar:first,lastBar:last},mode);
const commandFor=(clip:MusicClip,bar:number,count=1):ClipboardCommand=>({type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count,placement:'beforeBar',filters:{...filters,masterAutomations:clip.mode==='multiTrack',sections:clip.mode==='multiTrack'}}});
const paste=(destination:model.Score,clip:MusicClip,bar:number,count=1)=>preparePasteMusic(destination,commandFor(clip,bar,count)).score;
const gesture=(destination:model.Score,clip:MusicClip,bar:number,count=1)=>pasteGestureProblem(destination,commandFor(clip,bar,count));
const directionsOf=(clip:MusicClip)=>scoreFromJson(clip.scoreJson,new Settings()).masterBars.map(master=>[...master.directions??[]]);
const set=(score:model.Score,bar:number,...values:model.Direction[])=>{score.masterBars[bar].directions=new Set(values);};

it('a complete direction group travels with a multitrack bar clip and lands once',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.TargetFine);set(source,2,D.JumpDalSegnoAlFine);
  const clip=bars(source,0,2);expect(directionsOf(clip)).toEqual([[D.TargetSegno],[D.TargetFine],[D.JumpDalSegnoAlFine]]);
  const result=paste(music(),clip,1);expect(result.masterBars.map(master=>[...master.directions??[]])).toEqual([[],[D.TargetSegno],[D.TargetFine],[D.JumpDalSegnoAlFine],[],[],[]]);
});
it('a jump without its target in the clip is refused with a direction message',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.TargetFine);set(source,2,D.JumpDalSegnoAlFine);
  expect(()=>bars(source,1,2)).toThrow(/Segno this navigation direction/);
  const noFine=music();set(noFine,0,D.TargetSegno);set(noFine,1,D.JumpDalSegnoAlFine);expect(()=>bars(noFine,0,1)).toThrow(/Fine this navigation direction/);
  const late=music();set(late,0,D.JumpDalSegno);set(late,1,D.TargetSegno);expect(()=>bars(late,0,1)).toThrow(/Segno this navigation direction/);
});
it('single-track clips keep dropping directions',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.JumpDalSegno);
  expect(directionsOf(bars(source,0,1,'singleTrack'))).toEqual([[],[]]);
});
it('a second target of a copied kind, or a repeated paste of one, is refused and the destination is unchanged',()=>{
  const source=music();set(source,0,D.TargetCoda);const clip=bars(source,0,0);
  const destination=music();set(destination,3,D.TargetCoda);const before=model.JsonConverter.scoreToJson(destination);
  expect(gesture(destination,clip,1)).toMatch(/already has a Coda target/);expect(model.JsonConverter.scoreToJson(destination)).toBe(before);
  expect(gesture(music(),clip,1,2)).toMatch(/one copy at a time/);expect(()=>paste(destination,clip,1)).not.toThrow();
  const other=music();set(other,3,D.TargetFine);expect(paste(other,clip,1).masterBars[1].directions?.has(D.TargetCoda)).toBe(true);
});
it('bars never land between a repeat closing and its alternate ending',()=>{
  const destination=music();destination.masterBars[0].isRepeatStart=true;destination.masterBars[1].alternateEndings=1;destination.masterBars[1].repeatCount=2;destination.masterBars[2].alternateEndings=2;
  const plain=bars(music(),0,0,'singleTrack'),source=music();source.masterBars[0].isRepeatStart=true;source.masterBars[1].repeatCount=2;
  expect(gesture(destination,plain,2)).toMatch(/alternate endings/);expect(gesture(destination,bars(source,0,1),2)).toMatch(/alternate endings/);
  expect(gesture(destination,plain,3)).toBeNull();expect(gesture(destination,plain,0)).toBeNull();expect(()=>paste(destination,plain,2)).not.toThrow();
});

it('a clip carrying a jump is refused for a repeated paste or a destination that already jumps',()=>{
  const source=music();set(source,0,D.JumpDaCapo);const clip=bars(source,0,0);
  expect(gesture(music(),clip,1,3)).toMatch(/jump.*one copy at a time/i);
  const destination=music();set(destination,0,D.TargetSegno);set(destination,3,D.JumpDalSegno);
  expect(gesture(destination,clip,1)).toMatch(/already has a navigation jump/);
  expect(gesture(music(),clip,1)).toBeNull();
});
it('copy requires a Coda after its jump, a Fine at or before it, and a Segno at or before it',()=>{
  const coda=music();set(coda,0,D.JumpDaCoda);set(coda,1,D.TargetCoda);expect(bars(coda,0,1).kind).toBe('bars');
  const early=music();set(early,0,D.TargetCoda);set(early,1,D.JumpDaCoda);expect(()=>bars(early,0,1)).toThrow(/Coda after/);
  const doubleEarly=music();set(doubleEarly,0,D.TargetDoubleCoda);set(doubleEarly,1,D.JumpDaDoubleCoda);expect(()=>bars(doubleEarly,0,1)).toThrow(/DoubleCoda after/);
  const sameBar=music();set(sameBar,0,D.TargetSegno,D.JumpDalSegno);expect(bars(sameBar,0,0).kind).toBe('bars');
});
it('a Fine sits before the jump that uses it: both standard layouts are accepted and a Fine after the jump is refused',()=>{
  const dc=music();set(dc,0,D.TargetFine);set(dc,1,D.JumpDaCapoAlFine);expect(bars(dc,0,1).kind).toBe('bars');
  const ds=music();set(ds,0,D.TargetSegno);set(ds,1,D.TargetFine);set(ds,3,D.JumpDalSegnoAlFine);expect(bars(ds,0,3).kind).toBe('bars');
  const dsSegno2=music();set(dsSegno2,0,D.TargetSegno);set(dsSegno2,1,D.TargetFine);set(dsSegno2,2,D.JumpDalSegnoSegnoAlFine);set(dsSegno2,0,D.TargetSegno,D.TargetSegnoSegno);expect(bars(dsSegno2,0,2).kind).toBe('bars');
  const late=music();set(late,0,D.JumpDaCapoAlFine);set(late,1,D.TargetFine);expect(()=>bars(late,0,1)).toThrow(/Fine at or before/);
  const lateDs=music();set(lateDs,0,D.TargetSegno);set(lateDs,1,D.JumpDalSegnoAlFine);set(lateDs,2,D.TargetFine);expect(()=>bars(lateDs,0,2)).toThrow(/Fine at or before/);
  const beforeSegno=music();set(beforeSegno,0,D.TargetFine);set(beforeSegno,1,D.TargetSegno);set(beforeSegno,2,D.JumpDalSegnoAlFine);expect(()=>bars(beforeSegno,0,2)).toThrow(/after its Segno/);
});
