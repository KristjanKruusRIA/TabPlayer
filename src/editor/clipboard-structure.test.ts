import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { music } from './fixtures';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { scoreFromJson } from '../model-clone';
import { Settings } from '@coderline/alphatab';
import type { ClipboardCommand,MusicClip,PasteFilters } from './clipboard-types';

const D=model.Direction,filters:PasteFilters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:true,sections:true};
const bars=(score:model.Score,first:number,last:number,mode:'singleTrack'|'multiTrack'='multiTrack')=>makeMusicClip(score,{kind:'bars',tracks:[0],firstBar:first,lastBar:last},mode);
const paste=(destination:model.Score,clip:MusicClip,bar:number,count=1)=>{const command:ClipboardCommand={type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count,placement:'beforeBar',filters:{...filters,masterAutomations:clip.mode==='multiTrack',sections:clip.mode==='multiTrack'}}};return preparePasteMusic(destination,command).score;};
const directionsOf=(clip:MusicClip)=>scoreFromJson(clip.scoreJson,new Settings()).masterBars.map(master=>[...master.directions??[]]);
const set=(score:model.Score,bar:number,...values:model.Direction[])=>{score.masterBars[bar].directions=new Set(values);};

it('a complete direction group travels with a multitrack bar clip and lands once',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.JumpDalSegnoAlFine);set(source,2,D.TargetFine);
  const clip=bars(source,0,2);expect(directionsOf(clip)).toEqual([[D.TargetSegno],[D.JumpDalSegnoAlFine],[D.TargetFine]]);
  const result=paste(music(),clip,1);expect(result.masterBars.map(master=>[...master.directions??[]])).toEqual([[],[D.TargetSegno],[D.JumpDalSegnoAlFine],[D.TargetFine],[],[],[]]);
});
it('a jump without its target in the clip is refused with a direction message',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.JumpDalSegnoAlFine);set(source,2,D.TargetFine);
  expect(()=>bars(source,1,2)).toThrow(/Segno this navigation direction/);
  expect(()=>bars(source,0,1)).toThrow(/Fine this navigation direction/);
  const late=music();set(late,0,D.JumpDalSegno);set(late,1,D.TargetSegno);expect(()=>bars(late,0,1)).toThrow(/Segno this navigation direction/);
});
it('single-track clips keep dropping directions',()=>{
  const source=music();set(source,0,D.TargetSegno);set(source,1,D.JumpDalSegno);
  expect(directionsOf(bars(source,0,1,'singleTrack'))).toEqual([[],[]]);
});
it('a second target of a copied kind, or a repeated paste of one, is refused and the destination is unchanged',()=>{
  const source=music();set(source,0,D.TargetCoda);const clip=bars(source,0,0);
  const destination=music();set(destination,3,D.TargetCoda);const before=model.JsonConverter.scoreToJson(destination);
  expect(()=>paste(destination,clip,1)).toThrow(/already has a Coda target/);expect(model.JsonConverter.scoreToJson(destination)).toBe(before);
  expect(()=>paste(music(),clip,1,2)).toThrow(/one copy at a time/);
  const other=music();set(other,3,D.TargetFine);expect(paste(other,clip,1).masterBars[1].directions?.has(D.TargetCoda)).toBe(true);
});
it('bars never land between a repeat closing and its alternate ending',()=>{
  const destination=music();destination.masterBars[0].isRepeatStart=true;destination.masterBars[1].alternateEndings=1;destination.masterBars[1].repeatCount=2;destination.masterBars[2].alternateEndings=2;
  const plain=bars(music(),0,0,'singleTrack'),source=music();source.masterBars[0].isRepeatStart=true;source.masterBars[1].repeatCount=2;
  expect(()=>paste(destination,plain,2)).toThrow(/alternate endings/);expect(()=>paste(destination,bars(source,0,1),2)).toThrow(/alternate endings/);
  expect(paste(destination,plain,3).masterBars).toHaveLength(5);expect(paste(destination,plain,0).masterBars).toHaveLength(5);
});
