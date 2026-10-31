import { expect, it } from 'vitest';
import commands from '../tests/protocol.json';
import { validateProject } from './engine';
import { blankProject } from './project';

const validate=(edit:unknown)=>validateProject({...blankProject(),edits:[edit]});
const entry=commands.slice(31,43);

it('accepts the shared 12 parity command shapes without changing them',()=>{
  expect(entry).toHaveLength(12);
  for(const edit of entry)expect(validate(edit).edits).toEqual([edit]);
});
it.each(entry)('rejects extra and missing required command fields: $type',edit=>{
  expect(()=>validate({...edit,unexpected:true})).toThrow();
  for(const key of Object.keys(edit).filter(key=>key!=='type')) {
    const incomplete={...edit};delete (incomplete as Record<string,unknown>)[key];
    expect(()=>validate(incomplete)).toThrow();
  }
});
it('rejects invalid note targets, pitch domains, enums and metadata shapes',()=>{
  const target={track:0,staff:0,bar:0,voice:0,beat:0};
  const invalid=[
    {type:'addPitchedNote',target,pitch:128},{type:'addPitchedNote',target,pitch:60.5},
    {type:'setPitchedNote',target,noteIndex:-1,pitch:60},
    {type:'addPitchedNote',target:{...target,beat:.5},pitch:60},
    {type:'addPercussionNote',target,articulation:-1},{type:'addPercussionNote',target,articulation:2147483648},
    {type:'addPitchedTrack',name:'Piano',program:128},
    {type:'setNoteSpelling',target,noteIndex:0,accidentalMode:7},
    {type:'setDirections',bar:0,directions:[19]},
    {type:'setScoreMetadata',fields:{...entry[0].fields,unknown:'No'}},
    {type:'setScoreMetadata',fields:{...entry[0].fields,album:null}},
    {type:'setNoteLinkByIndex',from:{target,noteIndex:0},to:{target,noteIndex:0},kind:'tie'},
    {type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{bend:false}},
    {type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{trill:{pitch:62,speed:16,unknown:true}}},
    {type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{letRing:null}},
    {type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{harmonic:{type:1,value:12,unknown:true}}},
  ];
  for(const edit of invalid)expect(()=>validate(edit),JSON.stringify(edit)).toThrow();
});

it('keepPitch is an optional boolean on setTuning and staff settings only, and absent edits keep their exact shape',()=>{
  const tuning={type:'setTuning',track:0,tuning:[64,59,55,50,45,38]},staff=commands.find(command=>command.type==='setStaffSettings')!;
  for(const keepPitch of [true,false]){
    expect(validate({...tuning,keepPitch}).edits).toEqual([{...tuning,keepPitch}]);
    expect(validate({...staff,settings:{...staff.settings,keepPitch}}).edits).toEqual([{...staff,settings:{...staff.settings,keepPitch}}]);
  }
  expect(validate(tuning).edits).toEqual([tuning]);
  for(const keepPitch of [null,1,'true',undefined]){
    expect(()=>validate({...tuning,keepPitch}),String(keepPitch)).toThrow();
    expect(()=>validate({...staff,settings:{...staff.settings,keepPitch}}),String(keepPitch)).toThrow();
  }
  expect(()=>validate({type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high',keepPitch:true})).toThrow();
  expect(()=>validate({type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33,keepPitch:true})).toThrow();
});
