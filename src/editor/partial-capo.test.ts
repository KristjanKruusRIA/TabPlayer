// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { blankProject } from '../project';
import type { EditCommand, StaffSettings } from '../edit-types';
import { buildDocument, buildScore, exportGp, previewEdit } from '../engine';
import { loadInterchangeScore } from '../interchange/gp';
import { preparePlanFromScore } from '../audio/plan';
import { editAudition } from '../audio/audition';
import { exportMidi } from '../export/midi';
import { exportAsciiTab } from '../export/ascii-tab';
import { scoreFromJson } from '../model-clone';
import { validateParityCommand } from '../parity-commands';
import { getPartialCapo, openStringKey, setPartialCapo, stringCapo, validatePartialCapo } from './partial-capo';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const base:StaffSettings={tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const open=[40,45,50,55,59,64];
const without=(settings:StaffSettings):StaffSettings=>{const {partialCapo:_,...rest}=settings;return rest;};
/** capo 2, and a partial capo at fret 5 over the three lowest strings. */
const combined:StaffSettings={...base,capo:2,partialCapo:{fret:5,strings:[1,2,3]}};
const notes:EditCommand[]=[1,2,3,4,5,6].map(string=>({type:'setNote',target,string,fret:3}));
const project=(...edits:EditCommand[])=>({...blankProject(),edits});
const written=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.notes.map(note=>note.realValue));
const replayEdits=(settings:StaffSettings):EditCommand[]=>{
  const edits:EditCommand[]=[{type:'setStaffSettings',track:0,staff:0,settings}];
  return [...edits,...notes];
};
/** One chord, a note per string at fret 3, built through the real edit path. */
function scored(settings:StaffSettings):model.Score {return buildScore(project(...replayEdits(settings)));}
/** The pitches a string and fret should sound, worked out independently of the code under test. */
const expectedKey=(string:number,fret:number,capo:number,partial:{fret:number;strings:number[]}|null)=>open[string-1]+fret+(partial?.strings.includes(string)?Math.max(capo,partial.fret):capo);
/** An independent Standard MIDI reader: the keys of every note on, in time order. */
function noteOns(bytes:Uint8Array):number[] {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),found:{tick:number;key:number}[]=[];
  let at=14;
  while(at<bytes.length){
    const end=at+8+view.getUint32(at+4);at+=8;let tick=0,status=0;
    const variable=()=>{let value=0,byte=0;do{byte=bytes[at++];value=value<<7|byte&127;}while(byte&128);return value;};
    while(at<end){
      tick+=variable();let type=bytes[at++];if(type<128){at--;type=status;}else if(type<240)status=type;
      if(type===255){at++;const length=variable();at+=length;}else if(type===240||type===247){const length=variable();at+=length;}
      else{const kind=type&240,size=kind===192||kind===208?1:2;if(kind===144&&bytes[at+1]>0)found.push({tick,key:bytes[at]});at+=size;}
    }
  }
  return found.sort((a,b)=>a.tick-b.tick).map(note=>note.key);
}
afterEach(()=>vi.restoreAllMocks());

describe('the partial capo value',()=>{
  it('accepts a fret over ascending existing strings, or none, and nothing else',()=>{
    for(const value of [{fret:5,strings:[1,2,3]},{fret:127,strings:[6]},{fret:1,strings:[1,2,3,4,5,6]},{fret:0,strings:[]}])expect(()=>validatePartialCapo(value,6)).not.toThrow();
    for(const value of [null,5,[],{fret:5},{fret:5,strings:[1],extra:0},{fret:5,strings:[]},{fret:0,strings:[1]},{fret:128,strings:[1]},{fret:-1,strings:[1]},{fret:1.5,strings:[1]},{fret:5,strings:[0]},{fret:5,strings:[7]},{fret:5,strings:[2,1]},{fret:5,strings:[1,1]},{fret:5,strings:[1.5]},{fret:'5',strings:[1]}])expect(()=>validatePartialCapo(value,6),JSON.stringify(value)).toThrow();
  });
  it('lets the higher of the capo and the partial capo act on a covered string, and the capo alone elsewhere',()=>{
    const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];staff.capo=2;staff.transpositionPitch=1;
    setPartialCapo(staff,{fret:5,strings:[1,2,3]});
    expect([1,2,3,4,5,6].map(string=>stringCapo(staff,string))).toEqual([5,5,5,2,2,2]);
    expect([1,6].map(string=>openStringKey(staff,string))).toEqual([40+5-1,64+2-1]);
    setPartialCapo(staff,{fret:1,strings:[1,2,3]});
    expect([1,2,3,4].map(string=>stringCapo(staff,string))).toEqual([2,2,2,2]);
    setPartialCapo(staff,null);expect(getPartialCapo(staff)).toBeNull();
  });
});

describe('pitch from string and fret',()=>{
  it('is worked out per string by the model, with the capo and the partial capo combined',()=>{
    const score=scored(combined);
    expect(written(score)).toEqual([1,2,3,4,5,6].map(string=>expectedKey(string,3,2,combined.partialCapo!)));
    expect(written(score)).toEqual([48,53,58,60,64,69]);
    // Without the partial capo the same frets sound only the whole-neck capo.
    expect(written(scored(without(combined)))).toEqual([1,2,3,4,5,6].map(string=>expectedKey(string,3,2,null)));
  });
  it('compares the strings independently when the partial capo is lower than the capo',()=>{
    expect(written(scored({...base,capo:4,partialCapo:{fret:2,strings:[1,6]}}))).toEqual([1,2,3,4,5,6].map(string=>expectedKey(string,3,4,null)));
  });
  it('keeps the staff partial capo when settings omit it, and clears it with fret 0',()=>{
    const kept=buildScore(project({type:'setStaffSettings',track:0,staff:0,settings:combined},{type:'setStaffSettings',track:0,staff:0,settings:{...without(combined),capo:3}}));
    expect(getPartialCapo(kept.tracks[0].staves[0])).toEqual({fret:5,strings:[1,2,3]});expect(kept.tracks[0].staves[0].capo).toBe(3);
    const cleared=buildScore(project({type:'setStaffSettings',track:0,staff:0,settings:combined},{type:'setStaffSettings',track:0,staff:0,settings:{...combined,partialCapo:{fret:0,strings:[]}}}));
    expect(getPartialCapo(cleared.tracks[0].staves[0])).toBeNull();
  });
  it('refuses settings a note cannot sound under, a partial capo over missing strings, and a changed string count',()=>{
    const high:EditCommand={type:'setNote',target,string:1,fret:100};
    expect(()=>buildScore(project({type:'setStaffSettings',track:0,staff:0,settings:{...base,partialCapo:{fret:20,strings:[1]}}},high))).toThrow(/playable MIDI pitch range/);
    expect(()=>buildScore(project({type:'setNote',target,string:1,fret:80},{type:'setStaffSettings',track:0,staff:0,settings:{...base,partialCapo:{fret:60,strings:[1]}}}))).toThrow(/outside the playable MIDI pitch range/);
    expect(()=>buildScore(project({type:'setStaffSettings',track:0,staff:0,settings:{...base,partialCapo:{fret:5,strings:[7]}}}))).toThrow(/partial capo/i);
    expect(()=>previewEdit(project({type:'setStaffSettings',track:0,staff:0,settings:combined}),{type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high'})).toThrow(/partial capo/i);
  });
  it('checks a typed fret against the pitch range of its own string',()=>{
    const edits:EditCommand[]=[{type:'setStaffSettings',track:0,staff:0,settings:{...base,partialCapo:{fret:60,strings:[6]}}}];
    expect(()=>buildScore(project(...edits,{type:'setNote',target,string:6,fret:30}))).toThrow(/outside the playable MIDI pitch range/);
    expect(()=>buildScore(project(...edits,{type:'setNote',target,string:5,fret:30}))).not.toThrow();
  });
  it('survives replay, a JSON clone and a rebuild unchanged',()=>{
    const score=scored(combined),json=model.JsonConverter.scoreToJson(score);
    expect(written(scoreFromJson(json,new Settings()))).toEqual(written(score));
    expect(written(model.JsonConverter.jsonToScore(json,new Settings()))).toEqual(written(score));
    // A clone through the library's own converter, as tests and tools use it, keeps the field, and a plain score has none.
    expect(JSON.parse(json).tracks[0].staves[0].tabplayerpartialcapo).toEqual({fret:5,strings:[1,2,3]});
    expect(model.JsonConverter.scoreToJson(scored(base))).not.toContain('tabplayerpartialcapo');
    expect(written(buildDocument(project(...replayEdits(combined))).score)).toEqual(written(score));
  });
  it('is in place before alphaTab builds its pitch caches on a clone',()=>{
    const score=scored(combined),clone=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings()),beat=clone.tracks[0].staves[0].bars[0].voices[0].beats[0];
    expect(beat.getNoteWithRealValue(48)).toBe(beat.notes[0]);
    expect(beat.minNote?.realValue).toBe(48);
  });
});

describe('every place that turns a string and fret into a pitch',()=>{
  it('plays the planned notes at the combined pitches',async()=>{
    const plan=await preparePlanFromScore(scored(combined),1);
    expect(plan.notes.map(note=>note.key)).toEqual([48,53,58,60,64,69]);
  });
  it('sounds an edited fret in the audition, matching the plan',()=>{
    const score=scored(combined);
    for(const [string,key] of [[1,48],[3,58],[4,60],[6,69]] as const)expect(editAudition(score,{type:'setNote',target,string,fret:3})?.notes[0].key).toBe(key);
  });
  it('exports the combined pitches to MIDI',()=>{
    expect(noteOns(exportMidi(scored(combined),{tracks:[0],range:null})).sort((a,b)=>a-b)).toEqual([48,53,58,60,64,69]);
  });
  it('writes the partial capo to a GP file, and reads it back with the same pitches',()=>{
    const score=scored(combined),bytes=exportGp(score),doc=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['Content/score.gpif']),'application/xml');
    const property=(name:string)=>[...doc.querySelectorAll('Staff > Properties > Property')].find(item=>item.getAttribute('name')===name)!;
    expect(property('CapoFret').querySelector('Fret')!.textContent).toBe('2');
    expect(property('PartialCapoFret').querySelector('Fret')!.textContent).toBe('5');
    // One flag per string, lowest first, as for the staff's Pitches.
    expect(property('PartialCapoStringFlags').querySelector('Bitset')!.textContent).toBe('111000');
    const reopened=loadInterchangeScore(bytes,new Settings());
    expect(getPartialCapo(reopened.tracks[0].staves[0])).toEqual({fret:5,strings:[1,2,3]});expect(reopened.tracks[0].staves[0].capo).toBe(2);
    expect(written(reopened)).toEqual(written(score));
    // A second trip is byte-stable for the capo properties.
    expect(getPartialCapo(loadInterchangeScore(exportGp(reopened),new Settings()).tracks[0].staves[0])).toEqual({fret:5,strings:[1,2,3]});
  });
  it('writes an empty partial capo for a staff without one',()=>{
    const doc=new DOMParser().parseFromString(strFromU8(unzipSync(exportGp(scored(base)))['Content/score.gpif']),'application/xml');
    const property=[...doc.querySelectorAll('Staff > Properties > Property')].find(item=>item.getAttribute('name')==='PartialCapoStringFlags')!;
    expect(property.querySelector('Bitset')!.textContent).toBe('000000');
  });
  it('skips a malformed partial capo in a GP file with a warning, and still loads the file',()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const entries=unzipSync(exportGp(scored(combined))),xml=strFromU8(entries['Content/score.gpif']);
    for(const [flags,fret] of [['11100','5'],['1x1000','5'],['111000','x'],['111000','200']]){
      const broken=xml.replace(/(<Property name="PartialCapoFret">\s*<Fret>)\d+/,`$1${fret}`).replace(/111000/,flags);
      expect(broken).not.toBe(xml);
      const score=loadInterchangeScore(zipSync({...entries,'Content/score.gpif':strToU8(broken)}),new Settings());
      expect(getPartialCapo(score.tracks[0].staves[0])).toBeNull();expect(score.tracks[0].staves[0].capo).toBe(2);
    }
    expect(warn).toHaveBeenCalled();
  });
  it('writes the partial capo in the ASCII tab heading',()=>{
    const heading=(score:model.Score)=>new TextDecoder().decode(exportAsciiTab(score,{tracks:[0],range:null})).split('\n').find(line=>line.includes('['))!;
    expect(heading(scored(combined))).toContain('capo 2, partial capo 5 on strings 1, 2, 3');
    expect(heading(scored({...base,partialCapo:{fret:7,strings:[6]}}))).toContain('] partial capo 7 on string 6');
    expect(heading(scored(base))).not.toContain('partial');
  });
});

describe('the command envelope',()=>{
  const command=(partialCapo?:unknown)=>({type:'setStaffSettings',track:0,staff:0,settings:{...base,...(partialCapo===undefined?{}:{partialCapo})}});
  it('takes an optional, well-formed partial capo on staff settings',()=>{
    for(const partial of [undefined,{fret:5,strings:[1,2]},{fret:0,strings:[]}])expect(()=>validateParityCommand(command(partial))).not.toThrow();
    expect(()=>validateParityCommand({type:'addStaff',track:0,settings:command({fret:3,strings:[6]}).settings})).not.toThrow();
    for(const partial of [null,{fret:5},{fret:5,strings:[7]},{fret:5,strings:[]},'x'])expect(()=>validateParityCommand(command(partial))).toThrow();
  });
});

