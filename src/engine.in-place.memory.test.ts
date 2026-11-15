import { expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { buildDocument, checkEditInPlace, editInPlace, journalDepth, trackIdentity, undoInPlace, type BuiltDocument } from './engine';
import { blankProject, projectCommands, type EditCommand, type Project } from './project';
import { defaultEngraving, projectEngraving } from './engraving/projection';
import { followProjection, type ProjectionBasis } from './engraving/follow';

// A score edited in place becomes a new object with every edit. Earlier ones must not pile up behind the current one: each keeps what it takes to take its edit back
// (the frets and links of a whole track) and a rendered copy with maps over the whole score.
v8.setFlagsFromString('--expose-gc');
const collect=vm.runInNewContext('gc') as ()=>void;
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
async function collectAll() {for(let round=0;round<4;round++){await settle();collect();}}

const project=():Project=>({...blankProject(),base:{kind:'blank',title:'T',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:40},edits:[]});
// Edits a person makes by typing: a note per beat, now and then a beat inserted or taken away, now and then one taken back.
const edit=(index:number):EditCommand=>{
  const target={track:0,staff:0,bar:index%40,voice:0,beat:index%4};
  return index%7===3?{type:'insertBeat',target,duration:16,dots:0}:index%11===5?{type:'deleteBeat',target}:{type:'setNote',target,string:1+index%6,fret:index%12};
};

it('keeps a bounded number of earlier scores, journals and rendered copies alive through hundreds of edits in place, undo included',async()=>{
  let current=project(),built:BuiltDocument=buildDocument(current);
  const value=defaultEngraving(),ids=(score:BuiltDocument['score'])=>score.tracks.map(trackIdentity);
  let basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  const scores:WeakRef<object>[]=[],copies:WeakRef<object>[]=[];
  let applied=0,followed=0,deepest=0;
  for(let i=0;i<320;i++) {
    const command=edit(i);
    try {checkEditInPlace(built,command,projectCommands(current).length);} catch {continue;}
    built=editInPlace(built,command,projectCommands(current).length);current={...current,edits:[...current.edits,command]};applied++;
    if(i%9===8&&journalDepth(built.score)>0){built=undoInPlace(built);current={...current,edits:current.edits.slice(0,-1)};}
    scores.push(new WeakRef(built.score));
    // The view draws after each edit (and sometimes once for two).
    if(i%5!==2){
      const next=followProjection(basis,built.score,ids(built.score),value);
      if(next){followed++;copies.push(new WeakRef(next.score));basis={source:built.score,ids:ids(built.score),value,projection:next};}
      else basis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
    }
    deepest=Math.max(deepest,journalDepth(built.score));
  }
  expect(applied,'most of the edits were applied in place').toBeGreaterThan(250);expect(followed).toBeGreaterThan(150);
  expect(deepest,'only the newest edits keep what it takes to take them back').toBeLessThanOrEqual(24);
  await collectAll();
  // The newest few are alive by design (the current score, what the view follows from, the steps a view that skipped a draw walks back through).
  const alive=(refs:WeakRef<object>[])=>refs.slice(0,-12).filter(ref=>ref.deref()!==undefined).length;
  expect(alive(scores),`of ${scores.length} earlier scores`).toBe(0);
  expect(alive(copies),`of ${copies.length} earlier rendered copies`).toBe(0);
},120000);
