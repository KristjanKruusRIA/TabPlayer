import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, Settings } from '@coderline/alphatab';
import { buildDocument, checkEditInPlace, editInPlace, exportGp, trackIdentity, undoInPlace } from '../engine';
import { describeScore, firstDifference } from '../engine-verify';
import { blankProject, projectCommands, type EditCommand, type Project } from '../project';
import { defaultEngraving, projectEngraving } from './projection';
import { followProjection, type ProjectionBasis } from './follow';

const B=String.fromCharCode(92),N=String.fromCharCode(10);
const tex=[`${B}title "Follow"`,`${B}tempo 100`,
  `${B}track "Lead"`,`${B}staff {tabs}`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,`:8 3.3{h} 5.3{h} 7.3 5.3 7.2{b (0 4)} 3.1 0.6 2.6 |`,`:4 5.3 -.3 7.2 9.2 |`,`:4 3.1 3.1 3.1 3.1 |`,`:4 r r r r |`,
  `${B}track "Rhythm"`,`${B}staff {tabs}`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,`:4 0.6 0.5 0.4 0.3 |`,`:4 2.5 2.5 2.5 2.5 |`,`:8 3.3 3.3 3.3 3.3 5.3 5.3 5.3 5.3 |`,`:4 0.6 r 0.4 r |`].join(N);
function project():Project {
  const imp=new importer.AlphaTexImporter();imp.initFromString(tex,new Settings());const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'f.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
const same=(a:ReturnType<typeof projectEngraving>,b:ReturnType<typeof projectEngraving>)=>{
  expect(firstDifference(describeScore(a.score),describeScore(b.score))).toBeNull();
  expect(a.beats.size).toBe(b.beats.size);expect(a.notes.size).toBe(b.notes.size);
  expect(a.bracketMode).toBe(b.bracketMode);
};

it('follows an edit made in place to the same projection a new one gives, with engraving overrides and several edits between draws',()=>{
  let current=project(),built=buildDocument(current);
  const value={...defaultEngraving(),profiles:[{trackId:'base/1',profile:'tablature' as const}]};
  const ids=(score:typeof built.score)=>score.tracks.map(trackIdentity);
  let basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  const edits:EditCommand[]=[
    {type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:2},string:2,fret:9},
    {type:'removeNote',target:{track:1,staff:0,bar:1,voice:0,beat:0},string:5},
    {type:'setDuration',target:{track:0,staff:0,bar:2,voice:0,beat:1},duration:8,dots:0},
    {type:'deleteBeat',target:{track:1,staff:0,bar:3,voice:0,beat:3}},
    {type:'insertBeat',target:{track:1,staff:0,bar:3,voice:0,beat:3},duration:4,dots:0},
    {type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}},
  ];
  let followed=0;
  for(const [i,edit] of edits.entries()) {
    checkEditInPlace(built,edit,projectCommands(current).length);
    built=editInPlace(built,edit,projectCommands(current).length);current={...current,edits:[...current.edits,edit]};
    // Two edits are drawn at once every third time.
    if(i%3===1)continue;
    const next=followProjection(basis,built.score,ids(built.score),value);
    expect(next,`edit ${i}`).not.toBeNull();followed++;
    same(next!,projectEngraving(built.score,ids(built.score),value));
    basis={source:built.score,ids:ids(built.score),value,projection:next!};
  }
  expect(followed).toBe(4);
  // A basis that is not the score's ancestor, or other engraving settings, are not followed.
  const unrelated=buildDocument(project());
  expect(followProjection(basis,unrelated.score,ids(unrelated.score),value)).toBeNull();
  const edit:EditCommand={type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:1};
  const other=editInPlace(built,edit,0);
  expect(followProjection({...basis,source:built.score},other.score,ids(other.score),{...value,profiles:[]})).toBeNull();
});

it('edits the rendered copy once however often the same projection is asked for, and keeps what a click can still reach until the redraw',()=>{
  let built=buildDocument(project());
  const value=defaultEngraving(),ids=(score:typeof built.score)=>score.tracks.map(trackIdentity);
  const basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  const before=basis.projection;
  const kept=built.score.tracks[0].staves[0].bars[0].voices[0].beats[3],gone=built.score.tracks[0].staves[0].bars[3].voices[0].beats[3];
  const keptRendered=before.beats.get(kept.id)!.rendered,goneRendered=before.beats.get(gone.id)!.rendered;
  const edits:EditCommand[]=[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:1},string:2,fret:9},{type:'deleteBeat',target:{track:0,staff:0,bar:3,voice:0,beat:3}}];
  for(const edit of edits)built=editInPlace(built,edit,0);
  const first=followProjection(basis,built.score,ids(built.score),value),second=followProjection(basis,built.score,ids(built.score),value);
  expect(first).not.toBeNull();expect(second).toBe(first);
  same(first!,projectEngraving(built.score,ids(built.score),value));
  // Between the edit and the redraw alphaTab still answers a click with the beats it laid out: a beat the edit left is still found, one it removed is not.
  expect(first!.beats.get(kept.id)!.rendered).toBe(keptRendered);
  expect(first!.beats.has(gone.id)).toBe(false);
  void goneRendered;
});

it('follows an edit that was taken back in place to the projection a new one gives',()=>{
  let built=buildDocument(project());
  const value={...defaultEngraving(),profiles:[{trackId:'base/1',profile:'tablature' as const}]},ids=(score:typeof built.score)=>score.tracks.map(trackIdentity);
  let basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  const draw=(label:string)=>{
    const next=followProjection(basis,built.score,ids(built.score),value);
    expect(next,label).not.toBeNull();same(next!,projectEngraving(built.score,ids(built.score),value));
    basis={source:built.score,ids:ids(built.score),value,projection:next!};
  };
  const edits:EditCommand[]=[{type:'setNote',target:{track:1,staff:0,bar:0,voice:0,beat:1},string:2,fret:9},{type:'deleteBeat',target:{track:1,staff:0,bar:3,voice:0,beat:3}}];
  for(const edit of edits){built=editInPlace(built,edit,0);draw(`edit ${edit.type}`);}
  built=undoInPlace(built);draw('undo of the second');
  built=undoInPlace(built);draw('undo of the first');
  // Taken back and written again between two draws.
  built=editInPlace(built,edits[0],0);built=undoInPlace(built);built=editInPlace(built,{type:'setNote',target:{track:1,staff:0,bar:0,voice:0,beat:1},string:2,fret:12},0);draw('write, undo, write');
});

it('finds the document beat and note of every rendered one, new ones included, whatever ids the copy gave them',()=>{
  let built=buildDocument(project());
  const value=defaultEngraving(),ids=(score:typeof built.score)=>score.tracks.map(trackIdentity);
  const basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  // A beat is inserted and a note typed on it, then a note written on an existing rest: new objects in the document, made again in the copy.
  const edits:EditCommand[]=[
    {type:'deleteBeat',target:{track:0,staff:0,bar:2,voice:0,beat:3}},
    {type:'insertBeat',target:{track:0,staff:0,bar:2,voice:0,beat:1},duration:4,dots:0},
    {type:'setNote',target:{track:0,staff:0,bar:2,voice:0,beat:1},string:2,fret:7},
  ];
  for(const edit of edits)built=editInPlace(built,edit,0);
  const next=followProjection(basis,built.score,ids(built.score),value)!;expect(next).not.toBeNull();
  const sourceBeat=built.score.tracks[0].staves[0].bars[2].voices[0].beats[1],sourceNote=sourceBeat.notes[0];
  const renderedBeat=next.beats.get(sourceBeat.id)!.rendered,renderedNote=next.notes.get(sourceNote.id)!.rendered;
  expect(next.renderedBeats?.get(renderedBeat),'a click on the new beat').toBe(sourceBeat);
  expect(next.renderedNotes?.get(renderedNote),'a click on the new note').toBe(sourceNote);
  // Every rendered beat and note leads back to the one it is a copy of.
  for(const [,pair] of next.beats)expect(next.renderedBeats?.get(pair.rendered)).toBe(pair.source);
  for(const [,pair] of next.notes)expect(next.renderedNotes?.get(pair.rendered)).toBe(pair.source);
  // The same for a projection made whole.
  const whole=projectEngraving(built.score,ids(built.score),value);
  for(const [,pair] of whole.beats)expect(whole.renderedBeats?.get(pair.rendered)).toBe(pair.source);
});
