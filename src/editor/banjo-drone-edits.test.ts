// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import { strFromU8 } from 'fflate';
import { blankProject } from '../project';
import type { EditCommand, StaffSettings } from '../edit-types';
import { buildScore } from '../engine';
import { exportMusicXml } from '../export/musicxml';
import { makeMusicClip } from './clipboard-source';
import { findChordShapes } from '../harmony/chords';
import { fretExists, getBanjoDrone } from './banjo-drone';
import { applyStructureEdit } from './structure';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const tuning=[62,59,55,50,67];
const banjo:StaffSettings={tuning,capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const toFive:EditCommand={type:'setStringCount',track:0,tuning,keep:'high'};
const drone=(fret:number):EditCommand=>({type:'setStaffSettings',track:0,staff:0,settings:{...banjo,droneFret:fret}});
const project=(...edits:EditCommand[])=>({...blankProject(),edits:[toFive,...edits]});
const note=(string:number,fret:number,beat=0,bar=0):EditCommand=>({type:'setNote',target:{...target,beat,bar},string,fret});
const staffOf=(score:model.Score)=>score.tracks[0].staves[0];
const barOf=(score:model.Score,bar=0)=>staffOf(score).bars[bar].voices[0].beats.flatMap(beat=>beat.notes.map(item=>({s:item.string,f:item.fret,k:item.realValue})));
const sounds=(score:model.Score,bar=0)=>barOf(score,bar).map(item=>item.k).sort((a,b)=>a-b);
const sel=(first=0,last=0)=>({kind:'bars' as const,tracks:[0],firstBar:first,lastBar:last});
const range=(type:string,extra:object)=>({type,selection:sel(),...extra}) as unknown as EditCommand;
const real=(score:model.Score,bar=0)=>barOf(score,bar).every(item=>fretExists(staffOf(score),item.s,item.f));
const paste=(clip:unknown,bar:number)=>({type:'pasteMusic',clip,options:{target:{...target,bar},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,filters:{diagrams:false,texts:false,timers:false,trackAutomations:false,masterAutomations:false,sections:false},placement:'beforeBar'}}) as unknown as EditCommand;
const run=(base:ReturnType<typeof project>,...edits:EditCommand[])=>buildScore({...base,edits:[...base.edits,...edits]});

describe('fingering never offers a missing drone fret',()=>{
  it('refingers a bar whose pitches the drone string could also play',()=>{
    const base=project(drone(5),note(2,2),note(3,2),note(5,7));
    const before=sounds(buildScore(base)),score=run(base,range('refingerSelection',{maxFret:12}));
    expect(sounds(score)).toEqual(before);expect(real(score)).toBe(true);
  });
  it('pastes a bar of the same staff, and a plain banjo bar with string 1 fret 2, onto the drone staff',()=>{
    const same=project(drone(5),note(2,2),note(3,2),note(5,7)),source=buildScore(same);
    const pasted=run(same,paste(makeMusicClip(source,sel(),'singleTrack'),1));
    expect(sounds(pasted,1)).toEqual(sounds(pasted,0));expect(real(pasted,1)).toBe(true);
    const plain=project(note(1,2)),clip=makeMusicClip(buildScore(plain),sel(),'singleTrack');
    const onto=run(project(drone(5)),paste(clip,1));
    expect(sounds(onto,1)).toEqual([69]);expect(real(onto,1)).toBe(true);
  });
});

describe('an open drone string moves up by any interval',()=>{
  for(const semitones of [1,2,3,4,5,6,7,12])it(`transposes the open drone string +${semitones}`,()=>{
    const score=run(project(drone(5),note(1,0)),range('transposeSelection',{semitones}));
    expect(sounds(score)).toEqual([67+semitones]);expect(real(score)).toBe(true);
  });
  it('transposes a forward roll with the open drone string',()=>{
    const base=project(drone(5),note(1,0),note(2,0,1),note(3,0,2),note(4,0,3));
    const score=run(base,range('transposeSelection',{semitones:2}));
    expect(sounds(score)).toEqual([52,57,61,69]);
    expect(real(score)).toBe(true);
  });
  for(const [name,interval] of [['+2 semitones',{kind:'semitones',semitones:2}],['diatonic +1',{kind:'diatonic',steps:1}]] as const)it(`transposes the harmony of an open drone string by ${name}`,()=>{
    const score=run(project(drone(5),note(1,0)),{type:'transposeHarmony',selection:sel(),interval,includeKeySignatures:false,includeChords:false} as unknown as EditCommand);
    expect(real(score)).toBe(true);expect(sounds(score)[0]).toBeGreaterThan(67);
  });
  it('still moves a neck fret down across the missing frets',()=>{
    for(const semitones of [-1,-2,-3,-7]){
      const score=run(project(drone(5),note(1,7)),range('transposeSelection',{semitones}));
      expect(sounds(score)).toEqual([69+semitones]);expect(real(score)).toBe(true);
    }
  });
});

describe('moving across the drone string',()=>{
  it('moves string 5 fret 7 up onto the drone string, at the neck fret that sounds the same',()=>{
    const score=run(project(drone(5),note(5,7)),range('moveSelectionStrings',{direction:'higher'}));
    expect(barOf(score)).toEqual([{s:1,f:7,k:69}]);
  });
  it('moves the drone string at neck fret 7 down onto string 5',()=>{
    const score=run(project(drone(5),note(1,7)),range('moveSelectionStrings',{direction:'lower'}));
    expect(barOf(score)).toEqual([{s:5,f:7,k:69}]);
  });
  it('refuses a move whose pitch lies on a missing drone fret',()=>{
    expect(()=>run(project(drone(5),note(5,0)),range('moveSelectionStrings',{direction:'higher'}))).toThrow();
  });
});

describe('MusicXML export of a drone staff',()=>{
  it('writes the frets counted from the short string, with the same pitches, and no internal key',()=>{
    const score=buildScore(project(drone(5),note(1,0),note(1,6,1),note(1,7,2),note(1,10,3)));
    const xml=strFromU8(exportMusicXml(score,{tracks:[0],range:null}));
    expect(xml).not.toContain('tabplayerbanjodrone');
    const frets=[...xml.matchAll(/<fret>(\d+)<\/fret>/g)].map(match=>Number(match[1]));
    expect(frets).toEqual([0,1,2,5]);
    // The model is untouched afterwards.
    expect(getBanjoDrone(staffOf(score))).toBe(5);expect(barOf(score).map(item=>item.f)).toEqual([0,6,7,10]);
  });
});

describe('chord shapes on a drone staff',()=>{
  it('never use a fret the drone string does not have',()=>{
    const staff=staffOf(buildScore(project(drone(5))));
    for(const [step,formula] of [[5,'major'],[0,'major'],[1,'7']] as const){
      const shapes=findChordShapes(staff,{root:{step,alteration:0},formula,alterations:[],omissions:[],bass:null} as never,{maxFret:12,maxSpan:4,limit:12});
      expect(shapes.length).toBeGreaterThan(0);
      for(const shape of shapes){const fret=shape.frets.at(-1)!;expect(fret<1||fret>5).toBe(true);}
    }
  });
});

describe('the lows',()=>{
  it('lets a dead note on a missing fret stand while the drone is set, and refuses a live one',()=>{
    const dead=buildScore(project(note(1,3)));staffOf(dead).bars[0].voices[0].beats[0].notes[0].isDead=true;
    expect(()=>applyStructureEdit(dead,drone(5) as never,0)).not.toThrow();expect(getBanjoDrone(staffOf(dead))).toBe(5);
    expect(()=>run(project(note(1,3)),drone(5))).toThrow(/no frets/);
  });
  it('refuses a drone whose string 1 is not tuned above string 2, and a retune that makes it so',()=>{
    const low:StaffSettings={...banjo,tuning:[67,62,59,55,50],droneFret:5};
    expect(()=>buildScore({...blankProject(),edits:[{type:'setStringCount',track:0,tuning:[67,62,59,55,50],keep:'high'},{type:'setStaffSettings',track:0,staff:0,settings:low}]})).toThrow(/tuned higher/);
    expect(()=>run(project(drone(5)),{type:'setTuning',track:0,tuning:[67,62,59,55,50]} as unknown as EditCommand)).toThrow(/tuned higher/);
    expect(()=>run(project(drone(5)),{type:'setTuning',track:0,tuning:[62,59,55,50,69]} as unknown as EditCommand)).not.toThrow();
  });
  it('refuses a drone that would push a trill out of the pitch range, and keeps the interval otherwise',()=>{
    const low=buildScore(project(note(1,7)));staffOf(low).bars[0].voices[0].beats[0].notes[0].trillValue=3;
    expect(()=>applyStructureEdit(low,drone(5) as never,0)).toThrow(/trill/);expect(getBanjoDrone(staffOf(low))).toBe(0);
  });
});
