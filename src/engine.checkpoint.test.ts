import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, Settings } from '@coderline/alphatab';
import { buildDocument, buildDocumentSteps, checkpointFits, cloneDocument, compareDocuments, exportGp, makeCheckpoint, verifyEditStepwise, type BuiltDocument, type Checkpoint } from './engine';
import { duplicateIds } from './engine-verify';
import { blankProject, projectCommands, type EditCommand, type Project } from './project';

/**
 * The idle check replays only the edits after a checkpoint (a copy of a document that was a real rebuild). That is only a check against a rebuild if the replay
 * from a checkpoint gives what the replay from the file gives; these tests compare the two after every step of random histories.
 */
function random(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const B=String.fromCharCode(92),N=String.fromCharCode(10);
const richTex=[
  `${B}title "Rich"`,`${B}tempo 100`,
  `${B}track "Lead"`,`${B}staff {tabs}`,`${B}instrument 25`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,
  `:8 3.3{h} 5.3{h} 7.3{h} 5.3 7.2{b (0 4)} 3.1{pm} 0.6 2.6 |`,`:8 5.2{sl} 7.2{sl} 9.2 7.2{ss} 5.2 5.2 5.2 5.2 |`,
  `:4 5.3 -.3 7.2{sl} 9.2 |`,`:8 3.2{gr} 5.2 5.2{lr} 7.1 (3.2 5.3) 0.1 5.2{d} 1.1 |`,`:4 (5.3 7.4) 3.3 :8 3.3{tu 3} 5.3 7.3 :4 0.6 |`,`:4 3.1 3.1 3.1 3.1 |`,`:4 r r r r |`,
  `${B}track "Rhythm"`,`${B}staff {tabs}`,`${B}instrument 29`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,
  `:4 0.6 0.5 0.4 0.3 |`,`:4 2.5 2.5 2.5 2.5 |`,`:8 3.3 3.3 3.3 3.3 5.3 5.3 5.3 5.3 |`,`:4 0.6 0.5 0.4 0.3 |`,`:4 0.6 r 0.4 r |`,`:4 2.5 2.5 2.5 2.5 |`,`:4 r r r r |`,
].join(N);
const fileProject=():Project=>{
  const imp=new importer.AlphaTexImporter();imp.initFromString(richTex,new Settings());const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'rich.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};
const blankProjectWith=():Project=>({...blankProject(),base:{kind:'blank',title:'Blank',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:6},edits:[
  {type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33},
]});

function randomEdit(built:BuiltDocument,next:()=>number):EditCommand {
  const score=built.score,pick=(count:number)=>Math.floor(next()*count);
  const track=pick(score.tracks.length),staffIndex=pick(score.tracks[track].staves.length),staff=score.tracks[track].staves[staffIndex],bar=pick(staff.bars.length);
  const beats=staff.bars[bar].voices[0].beats,target={track,staff:staffIndex,bar,voice:0,beat:beats.length?pick(beats.length):0},string=1+pick(staff.tuning.length||6);
  switch(pick(14)) {
    case 0: case 1: case 2: return {type:'setNote',target,string,fret:pick(15)};
    case 3: return {type:'removeNote',target,string};
    case 4: return {type:'setRest',target};
    case 5: return {type:'setDuration',target,duration:[1,2,4,8,16][pick(5)],dots:pick(4)};
    case 6: return {type:'insertBeat',target,duration:[4,8,16][pick(3)],dots:0};
    case 7: return {type:'deleteBeat',target};
    // Settings edits, which keep the score and change what is kept beside it.
    case 8: return {type:'setTrackMix',trackId:`base/${track}`,mix:{gain:pick(10)/10,pan:0,mute:false,solo:false}};
    // Edits that are never made in place.
    case 9: return {type:'appendMeasure'};
    case 10: return score.masterBars.length>2?{type:'removeMeasure',bar:pick(score.masterBars.length)}:{type:'appendMeasure'};
    case 11: return {type:'addTrack',name:`T${pick(100)}`,tuning:[64,59,55,50,45,40],program:25};
    case 12: return {type:'sequence',commands:[{type:'setDuration',target,duration:8,dots:0},{type:'setNote',target,string,fret:pick(12)}]};
    default: return {type:'setNote',target,string,fret:pick(15)};
  }
}
const replayFrom=(project:Project,canRedo:boolean,from?:Checkpoint):BuiltDocument=>{
  const steps=buildDocumentSteps(project,canRedo,from);
  for(;;){const step=steps.next();if(step.done)return step.value;}
};

function fuzz(start:Project,seed:number,count:number) {
  const next=random(seed);let project=start,canRedo=false,undone:EditCommand[]=[],checkpoint:Checkpoint|null=null;
  let replays=0,discarded=0,fits=0;
  for(let i=0;i<count;i++) {
    const roll=next();
    if(roll<.15&&project.edits.length){undone.push(project.edits.at(-1)!);project={...project,edits:project.edits.slice(0,-1)};canRedo=true;}
    else if(roll<.25&&undone.length){const again=undone.pop()!;try{buildDocument({...project,edits:[...project.edits,again]},true);project={...project,edits:[...project.edits,again]};}catch{/* refused */}}
    else {
      const edit=randomEdit(buildDocument(project,canRedo),next);
      try{buildDocument({...project,edits:[...project.edits,edit]},canRedo);project={...project,edits:[...project.edits,edit]};undone=[];canRedo=false;}catch{continue;}
    }
    const full=buildDocument(project,canRedo);
    if(checkpoint) {
      const edits=projectCommands(project),stale=checkpoint.index>edits.length||JSON.stringify(edits.slice(0,checkpoint.index))!==checkpoint.prefix;
      expect(checkpointFits(checkpoint,project,canRedo),`step ${i}: a checkpoint at ${checkpoint.index} of ${edits.length} edits`).toBe(!stale);
      if(stale){checkpoint=null;discarded++;}
      else {
        fits++;
        const replayed=replayFrom(project,canRedo,checkpoint);replays++;
        expect(duplicateIds(replayed.score),`step ${i}`).toBeNull();
        expect(compareDocuments(replayed,full),`step ${i}: the replay from a checkpoint at ${checkpoint.index} of ${edits.length} edits, after ${JSON.stringify(project.edits.at(-1))}`).toBeNull();
        // What a check keeps when it finds the two equal: the replayed document itself.
        if(next()<.5)checkpoint=makeCheckpoint(project,replayed,canRedo);
      }
    }
    // A checkpoint is also taken from a real rebuild (the open document's copy), at any point of the history.
    if(!checkpoint||next()<.12)checkpoint=makeCheckpoint(project,cloneDocument(full),canRedo);
  }
  return {replays,discarded,fits};
}

describe('a replay from a checkpoint equals the rebuild from the file and every edit',()=>{
  it('after every step of random histories on a score with ties, slides, bends, grace notes and two tracks, with settings edits, undo and redo',()=>{
    const result=fuzz(fileProject(),Number(process.env.TP_FUZZ_SEED??5),Number(process.env.TP_FUZZ_COUNT??70));
    expect(result.replays).toBeGreaterThan(20);expect(result.discarded,'a checkpoint above the log after an undo is discarded').toBeGreaterThan(0);
  },300000);
  it('after every step of random histories on a blank score with added tracks and measures',()=>{
    const result=fuzz(blankProjectWith(),Number(process.env.TP_FUZZ_SEED??9),Number(process.env.TP_FUZZ_COUNT??80));
    expect(result.replays).toBeGreaterThan(20);expect(result.discarded).toBeGreaterThan(0);
  },300000);
  it('is not offered to a history that differs below the checkpoint, to another file, or to a base the partial capo reads differently',()=>{
    const project={...blankProjectWith(),edits:[{type:'appendMeasure'} as EditCommand,{type:'appendMeasure'} as EditCommand]};
    const checkpoint=makeCheckpoint(project,cloneDocument(buildDocument(project)),false);
    expect(checkpointFits(checkpoint,project,false)).toBe(true);
    expect(checkpointFits(checkpoint,{...project,edits:[...project.edits,{type:'appendMeasure'}]},false),'edits after it').toBe(true);
    expect(checkpointFits(checkpoint,{...project,edits:project.edits.slice(0,1)},true),'undone below it').toBe(false);
    expect(checkpointFits(checkpoint,{...project,edits:[project.edits[0],{type:'removeMeasure',bar:0}]},false),'another second edit').toBe(false);
    expect(checkpointFits(checkpoint,{...project,base:{...project.base,title:'Other'} as Project['base']},false),'another base').toBe(false);
  });
  it('is what the stepwise check replays from, and finds a document that differs from it',async()=>{
    const project={...blankProjectWith(),edits:[{type:'appendMeasure'} as EditCommand,{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:2,fret:4} as EditCommand]};
    const full=buildDocument(project),checkpoint=makeCheckpoint({...project,edits:project.edits.slice(0,1)},cloneDocument(buildDocument({...project,edits:project.edits.slice(0,1)})),false);
    const same=await verifyEditStepwise(project,full,false,async()=>{},()=>false,checkpoint);
    expect(same?.problem).toBeNull();
    full.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=9;
    const differs=await verifyEditStepwise(project,full,false,async()=>{},()=>false,checkpoint);
    expect(differs?.problem).not.toBeNull();
  });
});
