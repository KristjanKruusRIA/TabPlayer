import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, model, Settings } from '@coderline/alphatab';
import { buildDocument, canEditInPlace, canUndoInPlace, checkEditInPlace, editInPlace, exportGp, scoreLineage, undoInPlace, verifyEditInPlace, type BuiltDocument } from './engine';
import { duplicateIds } from './engine-verify';
import { blankProject, projectCommands, type EditCommand, type Project } from './project';

/** A small deterministic random source, so a failing run can be repeated. */
function random(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

const B=String.fromCharCode(92),N=String.fromCharCode(10);
/** Two tracks with the features a note edit has to keep intact: ties, hammer-ons, slides, bends, grace notes, a triplet, let ring, palm mute, and dynamics. */
const richTex=[
  `${B}title "Rich"`,`${B}tempo 100`,
  `${B}track "Lead"`,`${B}staff {tabs}`,`${B}instrument 25`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,
  `:8 3.3{h} 5.3{h} 7.3{h} 5.3 7.2{b (0 4)} 3.1{pm} 0.6 2.6 |`,`:8 5.2{sl} 7.2{sl} 9.2 7.2{ss} 5.2 5.2 5.2 5.2 |`,
  `:4 5.3 -.3 7.2{sl} 9.2 |`,
  `:8 3.2{gr} 5.2 5.2{lr} 7.1 (3.2 5.3) 0.1 5.2{d} 1.1 |`,
  `:4 (5.3 7.4) 3.3 :8 3.3{tu 3} 5.3 7.3 :4 0.6 |`,
  `:4 3.1 3.1 3.1 3.1 |`,`:2 5.3 5.3 |`,`:4 r r r r |`,`:1 3.3 |`,
  `${B}track "Rhythm"`,`${B}staff {tabs}`,`${B}instrument 29`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,
  `:4 0.6 0.5 0.4 0.3 |`,`:4 2.5 2.5 2.5 2.5 |`,`:8 3.3 3.3 3.3 3.3 5.3 5.3 5.3 5.3 |`,`:4 0.6 0.5 0.4 0.3 |`,`:4 0.6 r 0.4 r |`,`:4 2.5 2.5 2.5 2.5 |`,`:4 r r r r |`,`:1 0.6 |`,
].join(N);
const fileProject=():Project=>{
  const settings=new Settings(),imp=new importer.AlphaTexImporter();imp.initFromString(richTex,settings);
  const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'rich.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};
/** Everything else a note edit has to leave right: a pickup bar, repeats, a fermata, plain lyrics, two voices, two staves, a percussion track. */
const sinkTex=[
  `${B}title "Sink"`,`${B}tempo 100`,
  `${B}track "Lead"`,`${B}lyrics "la la la la la la la la la la la la"`,`${B}staff {score tabs}`,`${B}instrument 25`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,
  `${B}ac :4 3.3 |`,`${B}ro :4 5.3 5.3 5.3 5.3 |`,`${B}rc 2 :4 3.3{fermata medium} 3.3 3.3 3.3 |`,`:8 3.3{h} 5.3 7.3 5.3 3.3 3.3 3.3 r |`,
  `${B}voice`,`:4 r r r r |`,`r.1 |`,`r.1 |`,`r.1 |`,
  `${B}staff {score}`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,`:4 3.3 3.3 3.3 3.3 |`,`:4 3.3 3.3 3.3 3.3 |`,`:4 3.3 3.3 3.3 3.3 |`,`:4 3.3 3.3 3.3 3.3 |`,
  `${B}track "Drums"`,`${B}staff {score}`,`${B}instrument percussion`,`:4 38 36 38 36 |`,`:4 38 36 38 36 |`,`:4 38 36 38 36 |`,`:4 38 36 38 36 |`,
].join(N);
const sinkProject=():Project=>{
  const imp=new importer.AlphaTexImporter();imp.initFromString(sinkTex,new Settings());const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'sink.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};
const blankWithTracks=():Project=>({...blankProject(),base:{kind:'blank',title:'Blank',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:6},edits:[
  {type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33},
  {type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:3},
]});

/** Random edits of the kinds that are applied in place, aimed at what the score has so that most of them are accepted. */
function randomEdit(built:BuiltDocument,next:()=>number):EditCommand {
  const score=built.score,pick=(count:number)=>Math.floor(next()*count);
  // A quarter of the edits aim at the end of a track, where a beat has no successor.
  const track=pick(score.tracks.length),staffIndex=pick(score.tracks[track].staves.length),staff=score.tracks[track].staves[staffIndex],atEnd=next()<.25,bar=atEnd?staff.bars.length-1:pick(staff.bars.length),voices=staff.bars[bar].voices,voice=pick(voices.length),beats=voices[voice].beats;
  const target={track,staff:staffIndex,bar,voice,beat:beats.length?atEnd?beats.length-1:pick(beats.length):0},string=1+pick(staff.tuning.length||6);
  switch(pick(8)) {
    case 0: case 1: case 2: return {type:'setNote',target,string,fret:pick(15)};
    case 3: return {type:'removeNote',target,string};
    case 4: return {type:'setRest',target};
    case 5: return {type:'setDuration',target,duration:[1,2,4,8,16][pick(5)],dots:pick(4)};
    case 6: return pick(2)?{type:'insertBeat',target,duration:[4,8,16][pick(3)],dots:0}:{type:'deleteBeat',target};
    default: return {type:'sequence',commands:[{type:'setDuration',target,duration:[4,8][pick(2)],dots:0},{type:'setNote',target,string,fret:pick(12)}]};
  }
}

/**
 * Runs `count` random steps. Most are edits, applied in place when allowed and compared with a full rebuild after each accepted one. Some open another
 * score (which sets the id counters back, as another tab does), some undo (a rebuild from the history) and some redo what was undone.
 */
function run(project:Project,seed:number,count:number,{other=blankWithTracks()}:{other?:Project}={}) {
  const next=random(seed);let built=buildDocument(project),inPlace=0,refused=0,full=0,undone:EditCommand[]=[],undoneInPlace=0;const marks=new WeakMap<model.Score,number>();
  const apply=(edit:EditCommand,label:string)=>{
    const after:Project={...project,edits:[...project.edits,edit]};
    if(!canEditInPlace(built,edit)){
      try{built=buildDocument(after);project=after;full++;return true;}catch{refused++;return false;}
    }
    // The full path decides whether the edit is accepted; the in-place path must agree.
    let expected:Error|null=null;try{buildDocument(after);}catch(error){expected=error as Error;}
    let failure:Error|null=null;
    try{checkEditInPlace(built,edit,projectCommands(project).length);}catch(error){failure=error as Error;}
    if(expected){
      expect(failure?.message,`${label} ${JSON.stringify(edit)} was refused by the full build`).toBe(expected.message);
      // The check works on copies: a refused edit leaves the document exactly as the project says.
      expect(verifyEditInPlace(project,built),`after refused ${label}`).toBeNull();
      refused++;return false;
    }
    expect(failure,`${label} ${JSON.stringify(edit)} refused by the check but not by the full build`).toBeNull();
    const candidate=editInPlace(built,edit,projectCommands(project).length);
    project=after;built=candidate;inPlace++;marks.set(built.score,project.edits.length);
    expect(verifyEditInPlace(project,built),`after ${label} ${JSON.stringify(edit)}`).toBeNull();
    return true;
  };
  for(let i=0;i<count;i++) {
    const roll=next();
    if(roll<.1){buildDocument(other);continue;}
    if(roll<.17&&project.edits.length){
      undone.push(project.edits.at(-1)!);const before=project.edits.length;project={...project,edits:project.edits.slice(0,-1)};
      // Taken back in place when the last edit was applied in place, as the controller does; otherwise rebuilt from the history.
      if(marks.get(built.score)===before&&canUndoInPlace(built.score)){
        built=undoInPlace(built);undoneInPlace++;if(canUndoInPlace(built.score))marks.set(built.score,before-1);
        expect(verifyEditInPlace(project,built,true),`after undo in place ${i}`).toBeNull();
      } else built=buildDocument(project,true);
      expect(duplicateIds(built.score),`after undo ${i}`).toBeNull();continue;
    }
    if(roll<.24&&undone.length){const again=undone.pop()!;apply(again,`redo ${i}`);continue;}
    if(apply(randomEdit(built,next),`edit ${i}`))undone=[];
  }
  return {inPlace,refused,full,built,project,undoneInPlace};
}

describe('editing a built document in place',()=>{
  it('equals a full rebuild after every edit on a score with ties, slides, bends, grace notes and two tracks',()=>{
    const features=buildDocument(fileProject()).score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(e=>e.notes)))));
    // The score really holds the features the edits have to keep intact.
    for(const [name,count] of Object.entries({tie:features.filter(n=>n.isTieDestination).length,hammer:features.filter(n=>n.isHammerPullOrigin).length,slide:features.filter(n=>n.slideOutType!==0).length,bend:features.filter(n=>n.hasBend).length,letRing:features.filter(n=>n.isLetRing).length,palmMute:features.filter(n=>n.isPalmMute).length,effectSlur:features.filter(n=>n.hasEffectSlur).length}))expect(count,name).toBeGreaterThan(0);
    const result=run(fileProject(),Number(process.env.TP_FUZZ_SEED??7),Number(process.env.TP_FUZZ_COUNT??150));
    expect(result.inPlace).toBeGreaterThan(70);expect(result.undoneInPlace,'some undos were taken back in place').toBeGreaterThan(2);
  },240000);
  it('equals a full rebuild on a score with a pickup bar, repeats, a fermata, lyrics, two voices, two staves and a drum track, with other scores opened and undo and redo between',()=>{
    const result=run(sinkProject(),Number(process.env.TP_FUZZ_SEED??3),Number(process.env.TP_FUZZ_COUNT??120));
    expect(result.inPlace).toBeGreaterThan(15);
  },300000);
  it('equals a full rebuild on a blank score with an added track',()=>{
    const result=run(blankWithTracks(),Number(process.env.TP_FUZZ_SEED??11),Number(process.env.TP_FUZZ_COUNT??60));
    expect(result.inPlace).toBeGreaterThan(30);
  },240000);
  it('leaves the old score untouched in identity and gives the new one a lineage',()=>{
    const project=blankWithTracks(),built=buildDocument(project);
    const edit:EditCommand={type:'setNote',target:{track:0,staff:0,bar:1,voice:0,beat:0},string:2,fret:5};
    const next=editInPlace(built,edit,1);
    expect(next.score).not.toBe(built.score);
    expect(scoreLineage(next.score)).toMatchObject({previous:built.score,track:0});
    expect(next.score.tracks.every(track=>track.score===next.score)).toBe(true);
    expect(next.score.masterBars.every(master=>master.score===next.score)).toBe(true);
    expect(verifyEditInPlace({...project,edits:[...project.edits,edit]},next)).toBeNull();
  });
  it('refuses to apply in place what it does not know to be safe',()=>{
    const built=buildDocument(blankWithTracks());
    expect(canEditInPlace(built,{type:'appendMeasure'})).toBe(false);
    // A running-time marker is worked out from the whole score's playback, so edits to such a score are rebuilt.
    const timed=buildDocument(blankWithTracks());timed.score.tracks[0].staves[0].bars[0].voices[0].beats[0].showTimer=true;
    expect(canEditInPlace(timed,{type:'setNote',target:{track:0,staff:0,bar:1,voice:0,beat:0},string:1,fret:1})).toBe(false);
    expect(canEditInPlace(built,{type:'setNote',target:{track:9,staff:0,bar:0,voice:0,beat:0},string:1,fret:1})).toBe(false);
    expect(canEditInPlace(built,{type:'sequence',commands:[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:1},{type:'setNote',target:{track:1,staff:0,bar:0,voice:0,beat:0},string:1,fret:1}]})).toBe(false);
  });
});
