import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { importer,model,Settings } from '@coderline/alphatab';
import { buildDocument,checkEditInPlace,editInPlace,exportGp,trackIdentity } from '../engine';
import { describeScore,firstDifference } from '../engine-verify';
import { blankProject,type EditCommand,type Project } from '../project';
import { defaultEngraving,projectEngraving } from './projection';
import { followProjection,type ProjectionBasis } from './follow';
import type { TrackProfile } from './types';

/**
 * THE-220: a track shown as drum tab is never followed in place; edits to other tracks are. The tab always shows what the source holds.
 */
const B=String.fromCharCode(92),N=String.fromCharCode(10);
const tex=[`${B}title "Drums follow"`,`${B}tempo 100`,
  `${B}track "Lead"`,`${B}staff {tabs}`,`${B}tuning (e4 b3 g3 d3 a2 e2)`,`:4 3.3 5.3 7.2 9.2 |`,`:4 3.1 3.1 3.1 3.1 |`,`:4 0.6 0.5 0.4 0.3 |`,`:4 r r r r |`].join(N);
const DRUMS=1,drumAt=(beat:number,bar=0)=>({track:DRUMS,staff:0,bar,voice:0,beat});
function project():Project {
  const imp=new importer.AlphaTexImporter();imp.initFromString(tex,new Settings());const bytes=exportGp(imp.readScore());
  const edits:EditCommand[]=[
    {type:'addPercussionTrack',name:'Drums',program:0},
    {type:'addPercussionNote',target:drumAt(0),articulation:36},{type:'addPercussionNote',target:drumAt(0),articulation:42},
    {type:'addPercussionNote',target:drumAt(1),articulation:38},
  ];
  return {...blankProject(),base:{kind:'file',filename:'f.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},edits};
}
const ids=(score:model.Score)=>score.tracks.map(trackIdentity);
const withProfile=(score:model.Score,profile:TrackProfile)=>({...defaultEngraving(),profiles:[{trackId:ids(score)[DRUMS],profile}]});
/** What the drum tab of a projection holds: per bar and beat, the numbers on the tab, sorted. */
function written(projected:model.Score,staffIndex:number) {
  return projected.tracks[DRUMS].staves[staffIndex].bars.map(bar=>bar.voices[0].beats.map(beat=>beat.notes.map(note=>note.fret).sort((a,b)=>a-b)));
}
/** What the source drum staff holds, as the numbers the tab must show. */
const sourceHits=(score:model.Score)=>score.tracks[DRUMS].staves[0].bars.map(bar=>bar.voices[0].beats.map(beat=>beat.notes.map(note=>note.percussionArticulation).sort((a,b)=>a-b)));
const edited=(base:Project,...more:EditCommand[])=>buildDocument({...base,edits:[...base.edits,...more]});

for(const profile of ['tablature','standardTab'] as const) {
  const staff=profile==='tablature'?0:1;
  it(`${profile}: a drum note added, changed or deleted, and a beat's duration changed, are all drawn on the tab as the source holds them`,()=>{
    const base=project(),first=buildDocument(base);
    const value=withProfile(first.score,profile);
    expect(written(projectEngraving(first.score,ids(first.score),value).score,staff)[0].slice(0,2)).toEqual([[36,42],[38]]);
    const steps:EditCommand[]=[
      {type:'addPercussionNote',target:drumAt(1),articulation:49},
      {type:'setPercussionNote',target:drumAt(0),noteIndex:0,articulation:35},
      {type:'removeNoteByIndex',target:drumAt(0),noteIndex:1},
      {type:'setDuration',target:drumAt(1),duration:8,dots:0},
      {type:'insertBeat',target:drumAt(2),duration:8,dots:0},
      {type:'deleteBeat',target:drumAt(0)},
    ];
    let project_=base;
    for(const [index,step] of steps.entries()) {
      project_={...project_,edits:[...project_.edits,step]};
      const document=buildDocument(project_);
      const projection=projectEngraving(document.score,ids(document.score),value);
      expect(written(projection.score,staff)[0],`${step.type} #${index}`).toEqual(sourceHits(document.score)[0]);
      // The whole score lines up too: every bar and beat of the source has its drawn beat.
      expect(written(projection.score,staff)).toEqual(sourceHits(document.score));
      for(const note of document.score.tracks[DRUMS].staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes))){
        const pair=projection.notes.get(note.id)!;
        expect((profile==='tablature'?pair.rendered:pair.tab!).fret).toBe(note.percussionArticulation);
      }
    }
  });
  it(`${profile}: an edit made in place to a drum track is not followed; the same edit to another track is, and the drum tab stays right`,()=>{
    let built=buildDocument(project());
    const value=withProfile(built.score,profile);
    let basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
    // The duration of a drum beat: an edit made in place, but on the drum track, so the copy is built again.
    const drumEdit:EditCommand={type:'setDuration',target:drumAt(1),duration:8,dots:0};
    checkEditInPlace(built,drumEdit,built.score.tracks.length);
    const afterDrum=editInPlace(built,drumEdit,project().edits.length);
    expect(followProjection(basis,afterDrum.score,ids(afterDrum.score),value)).toBeNull();
    const rebuilt=projectEngraving(afterDrum.score,ids(afterDrum.score),value);
    expect(written(rebuilt.score,staff)).toEqual(sourceHits(afterDrum.score));
    expect(rebuilt.score.tracks[DRUMS].staves[staff].bars[0].voices[0].beats[1].duration).toBe(model.Duration.Eighth);
    // A change to the guitar is followed, and the result is the projection a full rebuild gives, with the tab intact.
    basis={source:afterDrum.score,ids:ids(afterDrum.score),value,projection:rebuilt};
    const guitarEdit:EditCommand={type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:2},string:2,fret:9};
    built=editInPlace(afterDrum,guitarEdit,project().edits.length+1);
    const followed=followProjection(basis,built.score,ids(built.score),value);
    expect(followed).not.toBeNull();
    const full=projectEngraving(built.score,ids(built.score),value);
    expect(firstDifference(describeScore(followed!.score),describeScore(full.score))).toBeNull();
    expect(followed!.beats.size).toBe(full.beats.size);expect(followed!.notes.size).toBe(full.notes.size);
    expect(written(followed!.score,staff)).toEqual(sourceHits(built.score));
    // Every drum note still leads to its tab note, and back, on the followed projection.
    for(const note of built.score.tracks[DRUMS].staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes))){
      const pair=followed!.notes.get(note.id)!,drawn=profile==='tablature'?pair.rendered:pair.tab!;
      expect(drawn.fret).toBe(note.percussionArticulation);expect(followed!.renderedNotes!.get(drawn)).toBe(note);
    }
    // Taking the guitar edit back in place is followed as well.
    expect(followed!.drumTab).toBe(basis.projection.drumTab);
  });
}

it('a score with no drum tab profile still follows an edit to the drum track in place',()=>{
  const built=buildDocument(project()),value=defaultEngraving();
  const basis:ProjectionBasis={source:built.score,ids:ids(built.score),value,projection:projectEngraving(built.score,ids(built.score),value)};
  const edit:EditCommand={type:'setDuration',target:drumAt(1),duration:8,dots:0};
  const next=editInPlace(built,edit,project().edits.length);
  const followed=followProjection(basis,next.score,ids(next.score),value);
  expect(followed).not.toBeNull();expect(followed!.drumTab).toBeUndefined();
});
