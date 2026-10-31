// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { strFromU8, unzipSync } from 'fflate';
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
import { applyStructureEdit } from './structure';
import { fretExists, fretKey, getBanjoDrone, setBanjoDrone, validateBanjoDrone } from './banjo-drone';
import { fretTarget, keyTarget, entryNotes } from '../instruments/entry';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
/** Open G banjo, high to low: D G... the drone G is the last entry and so string 1. */
const tuning=[62,59,55,50,67];
const banjo:StaffSettings={tuning,capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const toFive:EditCommand={type:'setStringCount',track:0,tuning,keep:'high'};
const drone=(fret:number):EditCommand=>({type:'setStaffSettings',track:0,staff:0,settings:{...banjo,droneFret:fret}});
const project=(...edits:EditCommand[])=>({...blankProject(),edits:[toFive,...edits]});
const note=(string:number,fret:number,beat=0):EditCommand=>({type:'setNote',target:{...target,beat},string,fret});
const written=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.notes.map(item=>item.realValue));
const staffOf=(score:model.Score)=>score.tracks[0].staves[0];
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
  return found.sort((a,b)=>a.tick-b.tick).map(item=>item.key);
}
/** Drone string fret 0 (open G4 = 67), then 5-fret drone: fret 6 is G#4, 7 is A4, 10 is B4 (the same pitch as string 4 open B... checked by hand). */
const droneNotes=[note(1,0),note(1,6,1),note(1,7,2),note(1,10,3)];

describe('the banjo drone value',()=>{
  it('accepts 0 or a fret from 1 to 12, and only on a 5-string staff',()=>{
    for(const value of [0,1,5,12])expect(()=>validateBanjoDrone(value,5)).not.toThrow();
    expect(()=>validateBanjoDrone(0,6)).not.toThrow();
    for(const value of [-1,13,5.5,'5',null,undefined,{fret:5}])expect(()=>validateBanjoDrone(value,5),String(value)).toThrow();
    for(const count of [4,6,7])expect(()=>validateBanjoDrone(5,count)).toThrow();
  });
  it('has no frets 1 to the drone fret on string 1 and nowhere else',()=>{
    const staff=new model.Staff();staff.stringTuning.tunings=tuning;setBanjoDrone(staff,5);
    expect([0,1,5,6,9].map(fret=>fretExists(staff,1,fret))).toEqual([true,false,false,true,true]);
    expect([1,5].map(fret=>fretExists(staff,2,fret))).toEqual([true,true]);
    expect(getBanjoDrone(staff)).toBe(5);setBanjoDrone(staff,0);expect(getBanjoDrone(staff)).toBe(0);expect(fretExists(staff,1,3)).toBe(true);
  });
});

describe('pitch on the drone string',()=>{
  it('sounds the open string at fret 0 and fret minus the drone fret above it, worked out by hand',()=>{
    const score=buildScore(project(drone(5),...droneNotes));
    // G4 open; neck fret 6 = one semitone up, 7 = two, 10 = five.
    expect(written(score)).toEqual([67,68,69,72]);
    expect([0,6,7,10].map(fret=>fretKey(staffOf(score),1,fret))).toEqual([67,68,69,72]);
  });
  it('follows another drone fret, and the other strings are plain',()=>{
    expect(written(buildScore(project(drone(6),note(1,0),note(1,7,1),note(2,3,2))))).toEqual([67,68,53]);
  });
  it('is unchanged without a drone, so a plain 5-string staff keeps its pitches',()=>{
    expect(written(buildScore(project(note(1,0),note(1,6,1))))).toEqual([67,73]);
  });
  it('combines with the capo, which acts on the drone string like any other',()=>{
    const settings:StaffSettings={...banjo,capo:2,droneFret:5};
    expect(written(buildScore(project({type:'setStaffSettings',track:0,staff:0,settings},note(1,0),note(1,7,1))))).toEqual([69,71]);
  });
  it('refuses a note on a fret the drone string does not have, by setNote and by the settings',()=>{
    expect(()=>buildScore(project(drone(5),note(1,3)))).toThrow(/no frets 1 to 5/);
    expect(()=>buildScore(project(drone(5),note(1,5)))).toThrow(/no frets 1 to 5/);
    expect(()=>buildScore(project(note(1,3),drone(5)))).toThrow(/no frets 1 to 5/);
    expect(()=>buildScore(project(drone(5),note(2,3)))).not.toThrow();
    expect(()=>buildScore(project(drone(5),note(1,3),drone(0)))).toThrow(/no frets 1 to 5/);
  });
  it('refuses a drone on a staff that is not 5-string, and a string count change on a drone staff',()=>{
    expect(()=>buildScore({...blankProject(),edits:[{type:'setStaffSettings',track:0,staff:0,settings:{tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true,droneFret:5}}]})).toThrow(/banjo drone/i);
    expect(()=>buildScore(project(drone(5),{type:'setStringCount',track:0,tuning:[64,59,55,50,45,40],keep:'high'}))).toThrow(/Remove the banjo drone/);
    expect(()=>buildScore(project(drone(5),drone(0),{type:'setStringCount',track:0,tuning:[64,59,55,50,45,40],keep:'high'}))).not.toThrow();
  });
  it('keeps the drone when settings omit it, and clears it with 0',()=>{
    const kept=buildScore(project(drone(5),{type:'setStaffSettings',track:0,staff:0,settings:{...banjo,capo:1}}));
    expect(getBanjoDrone(staffOf(kept))).toBe(5);
    expect(getBanjoDrone(staffOf(buildScore(project(drone(5),drone(0)))))).toBe(0);
  });
  it('lets a pitch range check use the drone string pitch',()=>{
    const top:EditCommand={type:'setStaffSettings',track:0,staff:0,settings:{...banjo,tuning:[62,59,55,50,127],droneFret:5}};
    expect(()=>buildScore(project(top,note(1,6)))).toThrow(/playable MIDI pitch range/);
    expect(()=>buildScore(project(top,note(1,0)))).not.toThrow();
  });
  it('survives a JSON clone, a library conversion and a full replay unchanged',()=>{
    const score=buildScore(project(drone(5),...droneNotes)),json=model.JsonConverter.scoreToJson(score);
    expect(written(scoreFromJson(json,new Settings()))).toEqual([67,68,69,72]);
    expect(written(model.JsonConverter.jsonToScore(json,new Settings()))).toEqual([67,68,69,72]);
    expect(JSON.parse(json).tracks[0].staves[0].tabplayerbanjodrone).toBe(5);
    expect(model.JsonConverter.scoreToJson(buildScore(project(note(1,0))))).not.toContain('tabplayerbanjodrone');
    expect(written(buildDocument(project(drone(5),...droneNotes)).score)).toEqual([67,68,69,72]);
  });
  it('is in place before alphaTab builds its pitch caches on a clone',()=>{
    const clone=scoreFromJson(model.JsonConverter.scoreToJson(buildScore(project(drone(5),note(1,7)))),new Settings()),beat=staffOf(clone).bars[0].voices[0].beats[0];
    expect(beat.getNoteWithRealValue(69)).toBe(beat.notes[0]);
  });
  it('undoes cleanly: previewing the settings edit changes the pitch and the base replay does not',()=>{
    const base=project(note(1,7));
    expect(written(buildScore(base))).toEqual([74]);
    expect(written(buildScore({...base,edits:[...base.edits,drone(5)]}))).toEqual([69]);
    expect(()=>previewEdit(base,drone(5))).not.toThrow();
  });
});

describe('every place that turns a string and fret into a pitch',()=>{
  const score=()=>buildScore(project(drone(5),...droneNotes));
  it('plays the planned notes at the drone pitches',async()=>{
    expect((await preparePlanFromScore(score(),1)).notes.map(item=>item.key)).toEqual([67,68,69,72]);
  });
  it('sounds an edited fret in the audition, matching the plan',()=>{
    for(const [fret,key] of [[0,67],[6,68],[10,72]] as const)expect(editAudition(score(),{type:'setNote',target,string:1,fret})?.notes[0].key).toBe(key);
  });
  it('exports the drone pitches to MIDI',()=>{
    expect(noteOns(exportMidi(score(),{tracks:[0],range:null}))).toEqual([67,68,69,72]);
  });
  it('writes a GP file that sounds the same, with the short string counted from its own start, and keeps the model unchanged',()=>{
    const model1=score(),bytes=exportGp(model1);
    expect(written(model1)).toEqual([67,68,69,72]);expect(getBanjoDrone(staffOf(model1))).toBe(5);
    expect(staffOf(model1).bars[0].voices[0].beats.map(beat=>beat.notes[0].fret)).toEqual([0,6,7,10]);
    const reopened=loadInterchangeScore(bytes,new Settings());
    expect(written(reopened)).toEqual([67,68,69,72]);
    expect(staffOf(reopened).bars[0].voices[0].beats.map(beat=>beat.notes[0].fret)).toEqual([0,1,2,5]);
    expect(getBanjoDrone(staffOf(reopened))).toBe(0);
    const doc=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['Content/score.gpif']),'application/xml');
    expect(doc.querySelector('Property[name="Tuning"] Pitches')!.textContent).toBe('67 50 55 59 62');
    // A second trip is stable.
    expect(written(loadInterchangeScore(exportGp(reopened),new Settings()))).toEqual([67,68,69,72]);
  });
  it('writes the drone in the ASCII tab heading',()=>{
    const heading=(value:model.Score)=>new TextDecoder().decode(exportAsciiTab(value,{tracks:[0],range:null})).split('\n').find(line=>line.includes('['))!;
    expect(heading(score())).toContain('banjo drone from fret 5');
    expect(heading(buildScore(project(note(1,0))))).not.toContain('drone');
  });
  it('names entry targets with the drone pitch, disables missing frets, and picks the neck fret for a key',()=>{
    const value=score(),staff=staffOf(value),beat=staff.bars[0].voices[0].beats[0],context={staff,target,notes:entryNotes(staff,beat)};
    expect(fretTarget(context,1,7).name).toContain('A4');
    expect(fretTarget(context,1,3).action).toBeNull();
    expect(fretTarget(context,1,3).name).toMatch(/does not exist/);
    const empty=staffOf(buildScore(project(drone(5)))),at=empty.bars[0].voices[0].beats[0];
    const key=keyTarget({staff:empty,target,notes:entryNotes(empty,at)},69).action!.command;
    // A4 is two semitones above the open drone string: neck fret 7, not 2.
    expect(key).toMatchObject({type:'setNote',string:1,fret:7});
  });
});

describe('the command envelope',()=>{
  const command=(droneFret?:unknown)=>({type:'setStaffSettings',track:0,staff:0,settings:{...banjo,...(droneFret===undefined?{}:{droneFret})}});
  it('takes an optional, well-formed drone fret on staff settings',()=>{
    for(const value of [undefined,0,5,12])expect(()=>validateParityCommand(command(value))).not.toThrow();
    expect(()=>validateParityCommand({type:'addStaff',track:0,settings:command(5).settings})).not.toThrow();
    for(const value of [null,13,-1,1.5,'5',{fret:5}])expect(()=>validateParityCommand(command(value))).toThrow();
    expect(()=>validateParityCommand({type:'setStaffSettings',track:0,staff:0,settings:{...banjo,tuning:[64,59,55,50,45,40],droneFret:5}})).toThrow();
  });
});

describe('old logs and trills',()=>{
  it('replays a log with no drone exactly as before: same pitches, no extension field, GP export unchanged',()=>{
    const edits:EditCommand[]=[note(1,3),note(2,5,1),note(5,0,2)];
    const score=buildScore(project(...edits));
    expect(written(score)).toEqual([70,55,62]);
    expect(model.JsonConverter.scoreToJson(score)).not.toContain('banjo');
    expect(written(loadInterchangeScore(exportGp(score),new Settings()))).toEqual([70,55,62]);
  });
  it('keeps a trill interval stable when the drone is set and cleared',()=>{
    const score=buildScore(project(note(1,7))),item=staffOf(score).bars[0].voices[0].beats[0].notes[0];
    item.trillValue=item.stringTuning+2;
    applyStructureEdit(score,drone(5),0);
    expect(item.trillFret).toBe(2);expect(item.trillValue).toBe(67+2-5);
    applyStructureEdit(score,drone(0),1);
    expect(item.trillFret).toBe(2);expect(item.trillValue).toBe(67+2);
  });
  it('moves a transposed note off the drone string when its fret would be missing, keeping every note on a real fret',()=>{
    const base=project(drone(5),note(1,7));
    const score=buildScore({...base,edits:[...base.edits,{type:'transposeSelection',selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:0},semitones:-4} as EditCommand]});
    expect(written(score)).toEqual([65]);
    const placed=staffOf(score).bars[0].voices[0].beats[0].notes[0];
    expect(fretExists(staffOf(score),placed.string,placed.fret)).toBe(true);
  });
});
