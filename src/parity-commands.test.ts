import { expect, it } from 'vitest';
import commands from '../tests/protocol.json';
import { validateProject } from './engine';
import { blankProject } from './project';

const validate=(edit:unknown)=>validateProject({...blankProject(),edits:[edit]});
const entry=commands.slice(31);

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
