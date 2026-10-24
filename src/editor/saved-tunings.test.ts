import { describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { applyStructureEdit } from './structure';
import { validateParityCommand } from '../parity-commands';
import { buildDocument,exportGp,previewEdit,validateProject } from '../engine';
import { blankProject } from '../project';
import type { EditCommand } from '../edit-types';
import { loadInterchangeScore } from '../interchange/gp';

const standard=[64,59,55,50,45,40],seven=[64,59,55,50,45,40,35],dropD=[64,59,55,50,45,38];
const awkward='Öine & <hääl> ]]>';
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const settings={tuning:standard,capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const staffOf=(score:model.Score,track=0,staff=0)=>score.tracks[track].staves[staff];
const nameOf=(score:model.Score,track=0,staff=0)=>staffOf(score,track,staff).stringTuning.name;
const notes=(score:model.Score)=>staffOf(score).bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)));
const pitches=(score:model.Score)=>notes(score).map(note=>note.realValue);
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const withNote=(edits:EditCommand[]=[])=>({...blankProject(),edits:[{type:'setNote',target,string:6,fret:3} as EditCommand,...edits]});
const base=()=>withNote();
const oddStandard=[66,59,55,50,45,40],oddSeven=[...oddStandard,35];
const summary=(score:model.Score)=>score.tracks.map(track=>track.staves.map(staff=>({tuning:staff.tuning,name:staff.stringTuning.name,notes:staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>[note.string,note.fret,note.realValue]))))})));

/** An edit is one undo step when it appends exactly one command; undo is the project without it. */
function oneStep(project:ReturnType<typeof withNote>,edit:EditCommand) {
  const before=buildDocument(project),after=previewEdit(project,edit);
  expect(after.project.edits).toHaveLength(project.edits.length+1);
  const undone=buildDocument({...after.project,edits:after.project.edits.slice(0,-1)});
  const redone=buildDocument(structuredClone(after.project));
  expect(summary(undone.score)).toEqual(summary(before.score));
  expect(summary(redone.score)).toEqual(summary(after.score));
  return {before:before.score,after:after.score,undone:undone.score,redone:redone.score};
}

describe('every tuning route carries notes and name in one edit',()=>{
  it('same-count setTuning',()=>{
    const r=oneStep(base(),{type:'setTuning',track:0,tuning:dropD,tuningName:'Drop D'});
    expect(staffOf(r.after).tuning).toEqual(dropD);expect(nameOf(r.after)).toBe('Drop D');expect(nameOf(r.redone)).toBe('Drop D');
    expect(staffOf(r.undone).tuning).toEqual(standard);expect(nameOf(r.undone)).toBe(nameOf(r.before));
  });
  it('setStringCount',()=>{
    const r=oneStep(base(),{type:'setStringCount',track:0,tuning:seven,keep:'high',tuningName:'Seven'});
    expect(staffOf(r.after).tuning).toEqual(seven);expect(nameOf(r.after)).toBe('Seven');expect(pitches(r.after)).toEqual(pitches(r.before));
    expect(staffOf(r.undone).tuning).toEqual(standard);expect(nameOf(r.undone)).toBe(nameOf(r.before));
  });
  it('addTrack',()=>{
    const r=oneStep(base(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33,tuningName:'Bass E'});
    expect(r.after.tracks).toHaveLength(2);expect(nameOf(r.after,1)).toBe('Bass E');expect(nameOf(r.redone,1)).toBe('Bass E');
    expect(r.undone.tracks).toHaveLength(1);
  });
  it('setStaffSettings',()=>{
    const r=oneStep(base(),{type:'setStaffSettings',track:0,staff:0,settings:{...settings,tuning:dropD,tuningName:'Drop D'}});
    expect(staffOf(r.after).tuning).toEqual(dropD);expect(nameOf(r.after)).toBe('Drop D');expect(nameOf(r.undone)).toBe(nameOf(r.before));
  });
  it('addStaff',()=>{
    const r=oneStep(base(),{type:'addStaff',track:0,settings:{...settings,tuning:dropD,tuningName:'Drop D'}});
    expect(nameOf(r.after,0,1)).toBe('Drop D');expect(nameOf(r.redone,0,1)).toBe('Drop D');expect(r.undone.tracks[0].staves).toHaveLength(1);
  });
});

describe('omitted names keep each route old behavior',()=>{
  const named=(name:string)=>withNote([{type:'setTuning',track:0,tuning:standard,tuningName:name}]);
  it('setTuning and setStaffSettings keep an existing name; setStringCount clears it; creation has none',()=>{
    expect(nameOf(previewEdit(named('Custom'),{type:'setTuning',track:0,tuning:dropD}).score)).toBe('Custom');
    const clef={...settings,clef:model.Clef.F4,capo:2};
    expect(nameOf(previewEdit(named('Custom'),{type:'setStaffSettings',track:0,staff:0,settings:clef}).score)).toBe('Custom');
    expect(nameOf(previewEdit(named('Custom'),{type:'setStringCount',track:0,tuning:oddSeven,keep:'high'}).score)).toBe('');
    expect(nameOf(previewEdit(base(),{type:'addTrack',name:'B',tuning:oddStandard,program:25}).score,1)).toBe('');
    expect(nameOf(previewEdit(named('Custom'),{type:'addStaff',track:0,settings:{...settings,tuning:oddStandard}}).score,0,1)).toBe('');
  });
  it('an imported name survives capo/clef-only settings and is cleared by an empty name',()=>{
    const score=music();staffOf(score).stringTuning.name='Imported';
    applyStructureEdit(score,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,capo:2}},0);expect(nameOf(score)).toBe('Imported');
    applyStructureEdit(score,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,tuning:standard,capo:2,tuningName:''}},1);expect(nameOf(score)).toBe('');
    staffOf(score).stringTuning.name='Imported';
    applyStructureEdit(score,{type:'setStringCount',track:0,tuning:oddSeven,keep:'high',tuningName:''},2);expect(nameOf(score)).toBe('');
  });
  it('explicit empty clears on setTuning',()=>{
    const cleared=previewEdit(named('Custom'),{type:'setTuning',track:0,tuning:oddStandard,tuningName:''});
    expect(nameOf(cleared.score)).toBe('');expect(staffOf(cleared.score).tuning).toEqual(oddStandard);
  });
});

describe('failures change nothing',()=>{
  it('a failed remap applies neither notes nor name',()=>{
    const score=music();applyStructureEdit(score,{type:'setStringCount',track:0,tuning:seven,keep:'high'},0);
    const beat=staffOf(score).bars[1].voices[0].beats[0],deep=new model.Note();deep.string=1;deep.fret=2;beat.addNote(deep);score.finish(new Settings());
    staffOf(score).stringTuning.name='Before';const before=json(score);
    expect(()=>applyStructureEdit(score,{type:'setStringCount',track:0,tuning:standard,keep:'high',tuningName:'After'},1)).toThrow('no playable string');
    expect(json(score)).toEqual(before);
  });
  it('a failed retune/settings/add leaves tuning and name alone',()=>{
    const project=withNote([{type:'setTuning',track:0,tuning:standard,tuningName:'Keep'}]);
    const high=[127,59,55,50,45,40];
    expect(()=>previewEdit(project,{type:'setTuning',track:0,tuning:[127,127,127,127,127,127],tuningName:'Nope'})).toThrow();
    expect(()=>previewEdit(project,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,tuning:high,capo:127,tuningName:'Nope'}})).toThrow();
    expect(()=>previewEdit(project,{type:'setTuning',track:0,tuning:dropD,tuningName:'bad\u0001'})).toThrow('XML');
    expect(()=>previewEdit(project,{type:'addTrack',name:'x',tuning:standard,program:25,tuningName:'￾'})).toThrow('XML');
    const built=buildDocument(project).score;expect(nameOf(built)).toBe('Keep');expect(staffOf(built).tuning).toEqual(standard);
  });
});

describe('command validation matches the native accept/reject list',()=>{
  const forms:Record<string,(extra:object)=>object>={
    addTrack:extra=>({type:'addTrack',name:'x',tuning:standard,program:25,...extra}),
    setTuning:extra=>({type:'setTuning',track:0,tuning:dropD,...extra}),
    setStringCount:extra=>({type:'setStringCount',track:0,tuning:seven,keep:'high',...extra}),
    setStaffSettings:extra=>({type:'setStaffSettings',track:0,staff:0,settings:{...settings,...extra}}),
    addStaff:extra=>({type:'addStaff',track:0,settings:{...settings,...extra}}),
  };
  const accepted=['','Drop D',awkward,'x'.repeat(500),'tab\tlf\ncr\r','\u{1F3B8}'];
  const rejected:unknown[]=[null,1,{},[],'bad\u0001','￾','￿','lone\uD800','lone\uDC00','\u0008'];
  for(const [type,make] of Object.entries(forms)) {
    it(`${type}: legacy shape plus optional string name`,()=>{
      expect(()=>validateParityCommand(make({}))).not.toThrow();
      for(const name of accepted)expect(()=>validateParityCommand(make({tuningName:name})),JSON.stringify(name)).not.toThrow();
      for(const name of rejected)expect(()=>validateParityCommand(make({tuningName:name})),JSON.stringify(name)).toThrow();
      expect(()=>validateParityCommand(make({tuningName:'ok',extra:1}))).toThrow();
      expect(()=>validateParityCommand(make({extra:1}))).toThrow();
    });
  }
  it('project validation round-trips an explicit empty name',()=>{
    const edit={type:'setTuning',track:0,tuning:dropD,tuningName:''};
    expect(validateProject({...blankProject(),edits:[edit]}).edits).toEqual([edit]);
  });
});

describe('cleared names',()=>{
  it('stay cleared through rebuilds even when the pitches match a tuning alphaTab knows',()=>{
    const named=withNote([{type:'setTuning',track:0,tuning:standard,tuningName:'My Drop D'}]);
    const cleared=previewEdit(named,{type:'setTuning',track:0,tuning:dropD,tuningName:''});
    expect(nameOf(cleared.score)).toBe('');
    expect(nameOf(buildDocument(cleared.project).score)).toBe('');
  });
});

describe('omitted names on new tunings',()=>{
  it('take the label alphaTab gives a tuning it knows, as before S15',()=>{
    const project={...blankProject(),edits:[
      {type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33},
      {type:'setStringCount',track:0,tuning:seven,keep:'high'},
      {type:'addStaff',track:0,settings},
    ] as EditCommand[]};
    const score=buildDocument(project).score;
    expect(nameOf(score,1)).toBe(model.Tuning.findTuning([43,38,33,28])!.name);
    expect(nameOf(score,0,1)).toBe(model.Tuning.findTuning(standard)!.name);
    expect(nameOf(score,0,0)).toBe(model.Tuning.findTuning(seven)!.name);
    expect(nameOf(score,1)).not.toBe('');
  });
  it('fill an empty name on an older retune, but never replace a name',()=>{
    const odd={...blankProject(),edits:[{type:'setTuning',track:0,tuning:oddStandard,tuningName:''}] as EditCommand[]};
    const retuned=buildDocument({...odd,edits:[...odd.edits,{type:'setTuning',track:0,tuning:standard}]}).score;
    expect(nameOf(retuned)).toBe(model.Tuning.findTuning(standard)!.name);
    const configured=buildDocument({...odd,edits:[...odd.edits,{type:'setStaffSettings',track:0,staff:0,settings}]}).score;
    expect(nameOf(configured)).toBe(model.Tuning.findTuning(standard)!.name);
    const named=buildDocument({...blankProject(),edits:[{type:'setTuning',track:0,tuning:oddStandard,tuningName:'Mine'},{type:'setTuning',track:0,tuning:standard}] as EditCommand[]}).score;
    expect(nameOf(named)).toBe('Mine');
  });
});

describe('GP labels by position',()=>{
  it('keep carriage returns and tell apart names that differ only in line endings',()=>{
    const score=music(),cr=String.fromCharCode(13),lf=String.fromCharCode(10);
    applyStructureEdit(score,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,tuning:dropD,tuningName:'x'+cr+']]>'}},0);
    applyStructureEdit(score,{type:'addStaff',track:0,settings:{...settings,tuning:dropD,tuningName:'x'+lf+']]>'}},1);
    applyStructureEdit(score,{type:'addStaff',track:0,settings:{...settings,tuning:dropD,tuningName:'a'+cr+'b'}},2);
    const loaded=loadInterchangeScore(exportGp(score),new Settings());
    expect([0,1,2].map(staff=>nameOf(loaded,0,staff))).toEqual(['x'+cr+']]>','x'+lf+']]>','a'+cr+'b']);
  });
});

describe('GP roundtrip',()=>{
  // An unnamed staff gets alphaTab's preset label on finish, so the empty case uses a tuning with no preset.
  it.each([[awkward,dropD],['',oddStandard],['x'.repeat(500),dropD],['a]]>b]]>c & <d>',dropD],['a'+String.fromCharCode(13)+'b]]>c',dropD]])('keeps tuning name %j with high-to-low pitches',(name,tuning)=>{
    const score=music();applyStructureEdit(score,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,tuning,tuningName:name}},0);
    const before=json(score),bytes=exportGp(score);
    expect(json(score)).toEqual(before);
    expect(nameOf(score)).toBe(name);
    const loaded=loadInterchangeScore(bytes,new Settings());
    expect(nameOf(loaded)).toBe(name);expect(staffOf(loaded).tuning).toEqual(tuning);
    expect(pitches(loaded)).toEqual(pitches(score));
    expect(createHash('sha256').update(exportGp(score)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('splits only the labels that carry the terminator',()=>{
    const project=withNote([{type:'addTrack',name:'Plain & <x>',tuning:oddStandard,program:25,tuningName:'Plain & <x>'},{type:'setStringCount',track:0,tuning:seven,keep:'high',tuningName:awkward}]);
    const score=buildDocument(project).score,loaded=loadInterchangeScore(exportGp(score),new Settings());
    expect(nameOf(loaded)).toBe(awkward);expect(staffOf(loaded).tuning).toEqual(seven);expect(pitches(loaded)).toEqual(pitches(score));
    expect(nameOf(loaded,1)).toBe('Plain & <x>');expect(loaded.tracks[1].name).toBe('Plain & <x>');
  });
});
