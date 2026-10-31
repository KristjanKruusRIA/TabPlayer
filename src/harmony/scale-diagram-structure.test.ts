import { describe,expect,it,vi } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { blankProject } from '../project';
import { buildDocument,exportGp,previewEdit } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import { music,noteAt,target } from '../editor/fixtures';
import {
  applyScaleDiagramEdit,getScaleDiagram,listScaleDiagrams,markAt,newMark,sameScaleDiagram,scaleDiagramFromPitchClasses,scaleDiagramFromSelection,
  validateScaleDiagram,type ScaleDiagram,
} from './scale-diagram';

const diagram=():ScaleDiagram=>({
  name:'A minor pentatonic',strings:6,frets:5,firstFret:5,orientation:'vertical',showFretMarkers:false,
  marks:[newMark(6,5,'circle','#b5df73','A','#161c24'),newMark(6,8,'square','#ffffff','1','#000000'),newMark(1,0,'cross','#ff0000','','#ffffff')],
});
const beatAt=(score:model.Score,bar=0,beat=0)=>score.tracks[0].staves[0].bars[bar].voices[0].beats[beat];
const command=(value:ScaleDiagram|null,at=target)=>({type:'setScaleDiagram' as const,target:at,diagram:value});

describe('scale diagrams keep their beat through structural edits',()=>{
  type Edit=Parameters<typeof previewEdit>[1];
  const at=(track:number,bar:number,beat:number)=>({track,staff:0,bar,voice:0,beat});
  const note=(track:number,bar:number,beat:number,fret:number):Edit=>({type:'setNote',target:at(track,bar,beat),string:1,fret});
  const insert=(track:number,bar:number,beat:number):Edit=>({type:'insertBeat',target:at(track,bar,beat),duration:4,dots:0});
  // Track "Guitar": bar 0 holds frets 1, 2, 3 and bar 1 holds fret 4; the diagram goes on fret 2. Track "Second" holds fret 9 in bar 0.
  const base=():Edit[]=>[
    ...[0,1,2].map(beat=>note(0,0,beat,beat+1)),note(0,1,0,4),
    {type:'addTrack',name:'Second',tuning:[64,59,55,50,45,40],program:25},note(1,0,0,9),
  ];
  const run=(edits:Edit[])=>{let built=previewEdit(blankProject(),edits[0]);for(const edit of edits.slice(1))built=previewEdit(built.project,edit,built);return built;};
  const where=(score:model.Score)=>listScaleDiagrams(score).map(({target:place,diagram:value})=>{
    const beat=score.tracks[place.track].staves[0].bars[place.bar].voices[0].beats[place.beat];
    return {track:score.tracks[place.track].name,bar:place.bar,beat:place.beat,fret:beat.notes[0]?.fret,name:value.name};
  });
  const mark=(name:string,place=at(0,0,1)):Edit=>({type:'setScaleDiagram',target:place,diagram:{...diagram(),name}});
  /** The expected places, checked live and again after replaying the saved project from JSON. */
  function expectWhere(edits:Edit[],expected:ReturnType<typeof where>) {
    const built=run(edits);expect(where(built.score)).toEqual(expected);
    expect(where(buildDocument(JSON.parse(JSON.stringify(built.project))).score)).toEqual(expected);
  }
  it('stays on its note after deleting an earlier beat',()=>expectWhere([...base(),mark('d'),{type:'deleteBeat',target:at(0,0,0)}],[{track:'Guitar',bar:0,beat:0,fret:2,name:'d'}]));
  it('stays on its note after inserting a beat before it',()=>expectWhere([...base(),{type:'deleteBeat',target:at(0,0,3)},mark('d'),insert(0,0,0)],[{track:'Guitar',bar:0,beat:2,fret:2,name:'d'}]));
  it('stays on its note after removing an earlier measure',()=>expectWhere([...base(),mark('d',at(0,1,0)),{type:'removeMeasure',bar:0}],[{track:'Guitar',bar:0,beat:0,fret:4,name:'d'}]));
  it('stays on its track after removing an earlier track',()=>expectWhere([...base(),mark('d',at(1,0,0)),{type:'removeTrack',track:0}],[{track:'Second',bar:0,beat:0,fret:9,name:'d'}]));
  it('follows its track when tracks are moved',()=>{
    expectWhere([...base(),mark('d',at(1,0,0)),{type:'moveTrack',track:1,to:0}],[{track:'Second',bar:0,beat:0,fret:9,name:'d'}]);
    expectWhere([...base(),mark('d'),{type:'moveTrack',track:0,to:1}],[{track:'Guitar',bar:0,beat:1,fret:2,name:'d'}]);
  });
  it('is copied with a duplicated track and leaves the later track alone',()=>{
    const built=run([...base(),mark('d'),{type:'duplicateTrack',track:0}]);
    expect(built.score.tracks.map(track=>track.name)).toEqual(['Guitar','Guitar','Second']);
    expect(listScaleDiagrams(built.score).map(item=>item.target.track)).toEqual([0,1]);
    expect(where(built.score)).toEqual([{track:'Guitar',bar:0,beat:1,fret:2,name:'d'},{track:'Guitar',bar:0,beat:1,fret:2,name:'d'}]);
    expect(listScaleDiagrams(buildDocument(JSON.parse(JSON.stringify(built.project))).score).map(item=>item.target.track)).toEqual([0,1]);
  });
});

describe('scale diagram string direction',()=>{
  it('numbers strings like notes: string 1 is the lowest, the highest string is the last',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    // Low E2 (string 1) fret 5 is A2; A2 (string 2) fret 3 is C3; high E4 (string 6) fret 5 is A4.
    const value=scaleDiagramFromPitchClasses(staff,9,new Set([9,0]),'low',1,5);
    expect(markAt(value,1,5)).toMatchObject({text:'A'});expect(markAt(value,2,3)).toMatchObject({text:'C'});expect(markAt(value,6,5)).toMatchObject({text:'A'});
    expect(markAt(value,1,3)).toBeUndefined();
    const probe=music();noteAt(probe,0,1).string=1;noteAt(probe,0,1).fret=5;
    const fromNotes=scaleDiagramFromSelection(probe,{kind:'notes',notes:[{target:{...target,beat:1},noteIndex:0}]},probe.tracks[0].staves[0]);
    expect(fromNotes.marks).toEqual([expect.objectContaining({string:1,fret:5,text:'A'})]);
  });
});

describe('scale diagram text safety',()=>{
  it('refuses characters an XML file cannot hold, in the name and in mark text',()=>{
    for(const bad of ['\u0001','\u000b','a\nb','\u007f','\u0085','￾','￿','\ud800']){
      expect(()=>validateScaleDiagram({...diagram(),name:bad})).toThrow();
      const value=diagram();value.marks[0].text=bad;expect(()=>validateScaleDiagram(value)).toThrow();
    }
    const fine=diagram();fine.name='𝄞 Ünï';fine.marks[0].text='𝄞';expect(()=>validateScaleDiagram(fine)).not.toThrow();
  });
  it('compares diagrams ignoring mark order',()=>{
    const a=diagram(),b=diagram();b.marks.reverse();expect(sameScaleDiagram(a,b)).toBe(true);b.marks[0].text='Z';expect(sameScaleDiagram(a,b)).toBe(false);expect(sameScaleDiagram(a,null)).toBe(false);expect(sameScaleDiagram(null,null)).toBe(true);
  });
  it('writes a file that reopens when names and texts hold markup characters',()=>{
    const score=music(),value=diagram();value.name='a&b<c>"d\'';value.marks[0].text='<&>';applyScaleDiagramEdit(score,command(value));
    expect(getScaleDiagram(beatAt(loadInterchangeScore(exportGp(score),new Settings())))).toEqual(value);
  });
});

describe('a malformed scale diagram property',()=>{
  it('skips the bad item with a warning and keeps the good ones and the file open',()=>{
    const score=music();applyScaleDiagramEdit(score,command(diagram()));applyScaleDiagramEdit(score,command({...diagram(),name:'second'},{...target,bar:1}));
    const entries=unzipSync(exportGp(score)),xml=strFromU8(entries['Content/score.gpif']);
    const damaged=[
      (text:string)=>text.replace('shape="circle"','shape="star"'),
      (text:string)=>text.replace(/(<Item bar=")1(")/,'$1x$2'),
      (text:string)=>text.replace(/(<Item bar=")1(")/,'$1999$2'),
      (text:string)=>text.replace(/<Diagram [\s\S]*?<\/Diagram>/,''),
    ];
    for(const damage of damaged){
      const changed=damage(xml);expect(changed).not.toBe(xml);
      const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
      const reopened=loadInterchangeScore(zipSync({...entries,'Content/score.gpif':strToU8(changed)}),new Settings());
      expect(warn).toHaveBeenCalled();warn.mockRestore();
      expect(listScaleDiagrams(reopened)).toHaveLength(1);expect(reopened.tracks[0].staves[0].bars).toHaveLength(4);
    }
  });
});
