import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8,unzipSync } from 'fflate';
import { blankProject } from '../project';
import { buildDocument,exportGp,previewEdit } from '../engine';
import { validateParityCommand } from '../parity-commands';
import { copyGpInterchangeSource,loadInterchangeScore } from '../interchange/gp';
import { scoreFromJson } from '../model-clone';
import { selectScore } from '../export/selection';
import { music,noteAt,target } from '../editor/fixtures';
import {
  applyScaleDiagramEdit,blankScaleDiagram,copyScaleDiagrams,getScaleDiagram,listScaleDiagrams,markAt,newMark,resized,scaleDiagramFromPitchClasses,
  scaleDiagramFromSelection,setScaleDiagram,validateScaleDiagram,withMark,withoutMark,type ScaleDiagram,
} from './scale-diagram';

const diagram=():ScaleDiagram=>({
  name:'A minor pentatonic',strings:6,frets:5,firstFret:5,orientation:'vertical',showFretMarkers:false,
  marks:[newMark(6,5,'circle','#b5df73','A','#161c24'),newMark(6,8,'square','#ffffff','1','#000000'),newMark(1,0,'cross','#ff0000','','#ffffff'),newMark(2,9,'triangle','#123456','♯♭♮','#abcdef')],
});
const beatAt=(score:model.Score,bar=0,beat=0)=>score.tracks[0].staves[0].bars[bar].voices[0].beats[beat];
const command=(value:ScaleDiagram|null,at=target)=>({type:'setScaleDiagram' as const,target:at,diagram:value});

describe('scale diagram validation',()=>{
  it('accepts open and windowed marks and refuses the same cases as the native check',()=>{
    expect(()=>validateScaleDiagram(diagram())).not.toThrow();
    const bad:Array<(value:ScaleDiagram)=>void>=[
      value=>{value.strings=2;},value=>{value.strings=11;},value=>{value.frets=3;},value=>{value.frets=25;},value=>{value.firstFret=0;},value=>{value.firstFret=124;},
      value=>{value.name='x'.repeat(65);},value=>{value.orientation='diagonal' as never;},value=>{value.marks[0].string=0;},value=>{value.marks[0].string=7;},
      value=>{value.marks[0].fret=4;},value=>{value.marks[0].fret=10;},value=>{value.marks[1].fret=5;},value=>{value.marks[0].shape='star' as never;},
      value=>{value.marks[0].text='abcd';},value=>{value.marks[0].color='red';},value=>{value.marks[0].textColor='#12345g';},value=>{(value as unknown as Record<string,unknown>).extra=1;},
    ];
    for(const change of bad){const value=diagram();change(value);expect(()=>validateScaleDiagram(value)).toThrow();}
  });
  it('accepts the command envelope and refuses a missing or extra field',()=>{
    expect(()=>validateParityCommand(command(diagram()))).not.toThrow();expect(()=>validateParityCommand(command(null))).not.toThrow();
    expect(()=>validateParityCommand({type:'setScaleDiagram',target})).toThrow();
    expect(()=>validateParityCommand({...command(diagram()),extra:true})).toThrow();
    expect(()=>validateParityCommand(command({...diagram(),marks:[{...diagram().marks[0],shape:'star' as never}]}))).toThrow();
  });
});

describe('scale diagram editing',()=>{
  it('sets and clears a diagram on a written beat, keeping every mark',()=>{
    const score=music();expect(applyScaleDiagramEdit(score,command(diagram()))).toBe(true);
    expect(getScaleDiagram(beatAt(score))).toEqual(diagram());expect(getScaleDiagram(beatAt(score,0,1))).toBeNull();
    applyScaleDiagramEdit(score,command(null));expect(getScaleDiagram(beatAt(score))).toBeNull();expect(listScaleDiagrams(score)).toEqual([]);
  });
  it('refuses an empty beat, a missing beat and a drum staff',()=>{
    const score=music();beatAt(score).isEmpty=true;
    expect(()=>applyScaleDiagramEdit(score,command(diagram()))).toThrow('Select an existing beat.');
    expect(()=>applyScaleDiagramEdit(score,command(diagram(),{...target,beat:9}))).toThrow('Select an existing beat.');
    const drums=music();drums.tracks[0].staves[0].isPercussion=true;expect(()=>applyScaleDiagramEdit(drums,command(diagram()))).toThrow('drum');
  });
  it('replays through the project, so undo and a restart keep the marks',()=>{
    const first=previewEdit(blankProject(),{type:'setNote',target,string:1,fret:3});
    const added=previewEdit(first.project,command(diagram()),first);
    expect(getScaleDiagram(beatAt(added.score))).toEqual(diagram());
    expect(getScaleDiagram(beatAt(buildDocument(JSON.parse(JSON.stringify(added.project))).score))).toEqual(diagram());
    expect(getScaleDiagram(beatAt(buildDocument(first.project).score))).toBeNull();
    const removed=previewEdit(added.project,command(null),added);expect(getScaleDiagram(beatAt(removed.score))).toBeNull();
  });
  it('follows its beat when measures are inserted before it',()=>{
    const first=previewEdit(blankProject(),{type:'setNote',target,string:1,fret:3});
    const added=previewEdit(first.project,command(diagram()),first),moved=previewEdit(added.project,{type:'insertMeasures',beforeBar:0,count:1},added);
    expect(listScaleDiagrams(moved.score).map(item=>item.target.bar)).toEqual([1]);
  });
  it('survives detached clones and export selections of the same shape',()=>{
    const score=music();applyScaleDiagramEdit(score,command(diagram()));
    const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());copyGpInterchangeSource(score,copy);
    expect(getScaleDiagram(beatAt(copy))).toEqual(diagram());
    const plain=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());copyScaleDiagrams(score,plain);copyScaleDiagrams(plain,plain);
    expect(listScaleDiagrams(plain)).toHaveLength(1);expect(getScaleDiagram(beatAt(selectScore(score,{tracks:[0],range:null})))).toEqual(diagram());
  });
  it('keeps stored data independent of the caller object',()=>{
    const score=music(),value=diagram();setScaleDiagram(beatAt(score),value);value.marks.length=0;
    const read=getScaleDiagram(beatAt(score))!;read.marks.length=0;expect(getScaleDiagram(beatAt(score))).toEqual(diagram());
  });
});

describe('scale diagram authoring helpers',()=>{
  it('builds a fingered diagram from selected notes, labelled with sounding names',()=>{
    const score=music();noteAt(score,0,1).fret=5;noteAt(score,0,2).fret=7;noteAt(score,0,3).fret=7;
    const staff=score.tracks[0].staves[0],selection={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:0};
    const value=scaleDiagramFromSelection(score,selection,staff);
    expect(value).toMatchObject({strings:6,firstFret:3,frets:5,orientation:'horizontal'});
    expect(value.marks.map(mark=>[mark.string,mark.fret,mark.text])).toEqual([[6,3,'G'],[6,5,'A'],[6,7,'B']]);
    expect(()=>validateScaleDiagram(value)).not.toThrow();
  });
  it('refuses a selection with no stringed notes or a span over 24 frets',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    expect(()=>scaleDiagramFromSelection(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},{...staff,isPercussion:true} as never)).toThrow();
    noteAt(score,0,1).fret=1;noteAt(score,0,2).fret=30;
    expect(()=>scaleDiagramFromSelection(score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},staff)).toThrow('24 frets');
  });
  it('lays out a scale over the window and marks the root',()=>{
    const score=music(),staff=score.tracks[0].staves[0],value=scaleDiagramFromPitchClasses(staff,9,new Set([9,0,2,4,7]),'A minor pentatonic',5,5);
    validateScaleDiagram(value);
    expect(markAt(value,6,5)).toMatchObject({text:'A',color:'#b5df73'});expect(markAt(value,6,8)).toMatchObject({text:'C',color:'#2f6fed'});expect(markAt(value,6,6)).toBeUndefined();
    expect(markAt(value,1,0)).toMatchObject({text:'E'});
  });
  it('adds, replaces and removes marks and resizes without breaking validity',()=>{
    let value=blankScaleDiagram(6);value=withMark(value,newMark(3,4));value=withMark(value,newMark(3,4,'diamond'));
    expect(value.marks).toHaveLength(1);expect(value.marks[0].shape).toBe('diamond');
    value=withMark(value,newMark(1,0));value=withMark(value,newMark(6,12));
    const smaller=resized(value,{frets:6,strings:5});expect(smaller.marks.map(mark=>[mark.string,mark.fret])).toEqual([[3,4],[1,0]]);validateScaleDiagram(smaller);
    expect(resized(value,{firstFret:5}).marks.map(mark=>mark.fret)).toEqual([0,12]);expect(resized(value,{firstFret:500}).firstFret).toBe(116);
    expect(withoutMark(value,3,4).marks).toHaveLength(2);
  });
});

describe('scale diagrams in GP export',()=>{
  const pack=(score:model.Score)=>{
    const bytes=exportGp(score);return {bytes,reopened:loadInterchangeScore(bytes,new Settings()),gpif:strFromU8(unzipSync(bytes)['Content/score.gpif'])};
  };
  it('writes every mark and reads them back on another beat and track',()=>{
    const score=music(),second=diagram();second.name='Quotes "&" <b>';second.marks[0].text='a&b';
    applyScaleDiagramEdit(score,command(diagram()));applyScaleDiagramEdit(score,command(second,{...target,bar:2,beat:3}));
    const {reopened,gpif}=pack(score);
    expect(gpif).toContain('TabPlayerScaleDiagrams');
    expect(getScaleDiagram(beatAt(reopened))).toEqual(diagram());expect(getScaleDiagram(beatAt(reopened,2,3))).toEqual(second);
    expect(listScaleDiagrams(reopened).map(item=>item.target.bar)).toEqual([0,2]);
  });
  it('is byte-identical on a second export and reaches a third generation unchanged',()=>{
    const score=music();applyScaleDiagramEdit(score,command(diagram()));
    const first=pack(score);expect(Array.from(exportGp(score))).toEqual(Array.from(first.bytes));
    const again=pack(first.reopened);expect(getScaleDiagram(beatAt(again.reopened))).toEqual(diagram());
  });
  it('leaves a score without diagrams free of the property',()=>{
    expect(pack(music()).gpif).not.toContain('TabPlayerScaleDiagrams');
  });
  it('keeps the music of the exported score unchanged',()=>{
    const score=music(),before=model.JsonConverter.scoreToJson(score);applyScaleDiagramEdit(score,command(diagram()));
    expect(model.JsonConverter.scoreToJson(pack(score).reopened)).toBe(model.JsonConverter.scoreToJson(loadInterchangeScore(exportGp(music()),new Settings())));
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
});
