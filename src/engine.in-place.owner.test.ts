import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync,readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument,checkEditInPlace,editInPlace,inPlaceRefusal,verifyEditInPlace,type BuiltDocument } from './engine';
import { blankProject,projectCommands,type EditCommand,type Project } from './project';

/**
 * Real scores, kept out of the repository: set TP_OWNER_SCORES to a folder of .gp files to run this against them (and TP_OWNER_OUT to a file for
 * the per-score report, which holds counts and reasons only). Each score gets random edits on every track and voice, each compared with a full rebuild.
 */
const folder=process.env.TP_OWNER_SCORES;
const random=(seed:number)=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
const files=folder&&existsSync(folder)?readdirSync(folder).filter(name=>name.endsWith('.gp')).sort():[];

function randomEdit(built:BuiltDocument,next:()=>number):EditCommand {
  const score=built.score,pick=(count:number)=>Math.floor(next()*count);
  const track=pick(score.tracks.length),staffIndex=pick(score.tracks[track].staves.length),staff=score.tracks[track].staves[staffIndex],bar=pick(staff.bars.length),voices=staff.bars[bar].voices,voice=pick(voices.length),beats=voices[voice].beats;
  const target={track,staff:staffIndex,bar,voice,beat:beats.length?pick(beats.length):0},string=1+pick(staff.tuning.length||6);
  switch(pick(6)) {
    case 0: case 1: return {type:'setNote',target,string,fret:pick(15)};
    case 2: return {type:'removeNote',target,string};
    case 3: return {type:'setRest',target};
    case 4: return {type:'setDuration',target,duration:[2,4,8,16][pick(4)],dots:pick(3)};
    default: return pick(2)?{type:'insertBeat',target,duration:[4,8,16][pick(3)],dots:0}:{type:'deleteBeat',target};
  }
}

describe.skipIf(files.length===0)('the owner\'s scores: edits in place equal a full rebuild',()=>{
  const report:Record<string,unknown>={};
  for(const [index,name] of files.entries()) {
    it(`score ${index+1}`,()=>{
      const bytes=readFileSync(join(folder!,name));
      let project:Project={...blankProject(),base:{kind:'file',filename:`score-${index+1}.gp`,bytesBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
      let built=buildDocument(project);
      const next=random(100+index),stats={tracks:built.score.tracks.length,bars:built.score.masterBars.length,inPlace:0,refused:0,fallback:0,fallbackByReason:{} as Record<string,number>,tracksFallingBack:new Set<number>(),tracksInPlace:new Set<number>()};
      const trackReasons=built.score.tracks.map((_,track)=>[...new Set(built.score.tracks[track].staves.flatMap((_staff,staffIndex)=>built.score.masterBars.map((__,bar)=>inPlaceRefusal(built,{type:'setRest',target:{track,staff:staffIndex,bar,voice:0,beat:0}}))))].map(reason=>reason??'ok').sort());
      const total=Number(process.env.TP_OWNER_COUNT??60);
      for(let i=0;i<total;i++) {
        const edit=randomEdit(built,next),after:Project={...project,edits:[...project.edits,edit]},track=(edit as {target:{track:number}}).target.track;
        const reason=inPlaceRefusal(built,edit);
        if(reason!==null){
          stats.fallback++;stats.fallbackByReason[reason]=(stats.fallbackByReason[reason]??0)+1;stats.tracksFallingBack.add(track);
          try{built=buildDocument(after);project=after;}catch{stats.refused++;}
          continue;
        }
        let expected:Error|null=null;try{buildDocument(after);}catch(error){expected=error as Error;}
        let failure:Error|null=null;try{checkEditInPlace(built,edit,projectCommands(project).length);}catch(error){failure=error as Error;}
        if(expected){expect(failure?.message,`edit ${i} refused by the full build`).toBe(expected.message);stats.refused++;continue;}
        expect(failure,`edit ${i} refused by the check only`).toBeNull();
        built=editInPlace(built,edit,projectCommands(project).length);project=after;stats.inPlace++;stats.tracksInPlace.add(track);
        expect(verifyEditInPlace(project,built),`score ${index+1} after edit ${i} ${JSON.stringify(edit)}`).toBeNull();
      }
      report[`score ${index+1}`]={...stats,tracksFallingBack:[...stats.tracksFallingBack].sort(),tracksInPlace:[...stats.tracksInPlace].sort(),trackReasons};
      if(process.env.TP_OWNER_OUT)writeFileSync(process.env.TP_OWNER_OUT,JSON.stringify(report,null,1));
      expect(stats.inPlace+stats.fallback+stats.refused).toBe(total);
    },600000);
  }
});
