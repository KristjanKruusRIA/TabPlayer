import { describe,expect,it } from 'vitest';
import { buildDocument,describeSelection,previewEdit } from '../engine';
import type { EditCommand,StaffSettings } from '../edit-types';
import { blankProject,type BeatTarget,type Project } from '../project';
import { entryNotes } from '../instruments/entry';
import { DEFAULT_INPUT_PREFERENCES } from './input-preferences';
import { lastFingeringSearchNodes,NODE_LIMIT,planChordFingering,planMidiCapture,type CapturedNote } from './midi-capture';

const guitar=(beat:number,bar=0):BeatTarget=>({track:0,staff:0,bar,voice:0,beat});
const piano=(beat:number,bar=0):BeatTarget=>({track:1,staff:0,bar,voice:0,beat});
const project=(...edits:EditCommand[]):Project=>({...blankProject(),edits:[{type:'addPitchedTrack',name:'Piano',program:0},...edits]});
const standard:StaffSettings={tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const played=(...keys:number[]):CapturedNote[]=>keys.map(key=>({key,velocity:90,channel:0}));
const types=(command:EditCommand)=>command.type==='sequence'?command.commands.map(step=>step.type):[command.type];
const steps=(command:EditCommand)=>command.type==='sequence'?command.commands:[command];
const plan=(base:Project,target:BeatTarget,notes:CapturedNote[],options:{entry?:{duration:number;dots:number}|null;hand?:number|null;advance?:boolean}={})=>planMidiCapture({
  project:base,score:buildDocument(base).score,target,notes,preferences:{...DEFAULT_INPUT_PREFERENCES,advance:options.advance??true},entry:options.entry??null,hand:options.hand??null,
});
const planned=(...args:Parameters<typeof plan>)=>{const result=plan(...args);if('refused' in result)throw new Error(`${result.refused}: ${result.name}`);return result;};
const writtenKeys=(base:Project,command:EditCommand,target:BeatTarget)=>{
  const score=previewEdit(base,command).score,{staff,beat}=describeSelection(score,target);
  return entryNotes(staff,beat!).map(note=>note.key).sort((a,b)=>a-b);
};

describe('planChordFingering',()=>{
  const staff=()=>describeSelection(buildDocument(project()).score,guitar(0)).staff;
  it('reports no search work when a call returns before it searches',()=>{
    planChordFingering(staff(),[{key:69,string:null}],new Set(),null);
    expect(lastFingeringSearchNodes()).toBeGreaterThan(0);
    expect(planChordFingering(staff(),[],new Set(),null)).toBeNull();
    expect(lastFingeringSearchNodes()).toBe(0);
    planChordFingering(staff(),[{key:69,string:null}],new Set(),null);
    expect(planChordFingering(staff(),[{key:30,string:null}],new Set(),null)).toBeNull();
    expect(lastFingeringSearchNodes()).toBe(0);
  });
  it('puts an open E major chord on the strings and frets a guitarist plays it on',()=>{
    const result=planChordFingering(staff(),[40,47,52,56,59,64].map(key=>({key,string:null})),new Set(),null);
    expect(result).toEqual([{string:1,fret:0},{string:2,fret:2},{string:3,fret:2},{string:4,fret:1},{string:5,fret:0},{string:6,fret:0}]);
  });
  it('takes the nearest position to the hand when a pitch can be played in several places, and the lowest without one',()=>{
    expect(planChordFingering(staff(),[{key:69,string:null}],new Set(),null)).toEqual([{string:6,fret:5}]);
    expect(planChordFingering(staff(),[{key:69,string:null}],new Set(),10)).toEqual([{string:5,fret:10}]);
  });
  it('leaves out strings that are taken, and says null when no assignment exists',()=>{
    expect(planChordFingering(staff(),[{key:69,string:null}],new Set([6]),null)).toEqual([{string:5,fret:10}]);
    expect(planChordFingering(staff(),[{key:30,string:null}],new Set(),null)).toBeNull();
    expect(planChordFingering(staff(),[40,41,42,43,44,45,46].map(key=>({key,string:null})),new Set(),null)).toBeNull();
    expect(planChordFingering(staff(),[{key:40,string:null}],new Set([1,2,3,4,5,6]),null)).toBeNull();
  });
  it('honours a pinned string that can reach the pitch and falls back when it cannot',()=>{
    expect(planChordFingering(staff(),[{key:64,string:5}],new Set(),null)).toEqual([{string:5,fret:5}]);
    expect(planChordFingering(staff(),[{key:40,string:6}],new Set(),null)).toEqual([{string:1,fret:0}]);
  });
});

describe('planMidiCapture',()=>{
  it('writes a whole chord as one sequence, with the fingering the plan chose, and moves to the next beat',()=>{
    const base=project({type:'setStaffSettings',track:0,staff:0,settings:standard}),result=planned(base,guitar(0),played(40,47,52,56,59,64));
    expect(result.command.type).toBe('sequence');
    expect(types(result.command)).toEqual(Array(6).fill('setNote'));
    expect(result.next).toEqual(guitar(1));
    expect(writtenKeys(base,result.command,guitar(0))).toEqual([40,47,52,56,59,64]);
    expect(result.removes).toBe(false);
    // The fretted notes are at frets 2, 2 and 1: the hand is near the second.
    expect(result.hand).toBe(2);
  });
  it('records a single note as that one step, not a sequence',()=>{
    const result=planned(project(),guitar(0),played(52));
    expect(result.command).toMatchObject({type:'setNote',target:guitar(0)});
  });
  it('takes the same note from several channels once, and never removes a pitch the beat already has',()=>{
    const base=project({type:'setNote',target:guitar(0),string:6,fret:0});
    const duplicate=planned(base,guitar(0),[{key:69,velocity:90,channel:0},{key:69,velocity:60,channel:3}]);
    expect(steps(duplicate.command)).toHaveLength(1);
    // Key 64 is on the beat already, so only 69 is written, on a string that is free.
    const again=planned(base,guitar(0),played(64,69));
    expect(steps(again.command)).toEqual([{type:'setNote',target:guitar(0),string:5,fret:10}]);
    expect(writtenKeys(base,again.command,guitar(0))).toEqual([64,69]);
  });
  it('writes nothing for a chord that adds nothing, and says the pitches are already there',()=>{
    const base=project({type:'setNote',target:guitar(0),string:6,fret:0});
    expect(plan(base,guitar(0),played(64))).toMatchObject({refused:'present'});
  });
  it('refuses a chord with a pitch outside the instrument, writing none of it, and does not clamp',()=>{
    expect(plan(project(),guitar(0),played(40,30))).toEqual({refused:'unreachable',name:'F#1'});
    expect(plan(project(),guitar(0),played(100))).toEqual({refused:'unreachable',name:'E7'});
  });
  it('refuses more pitches than there are free strings',()=>{
    expect(plan(project(),guitar(0),played(40,41,42,43,44,45,46))).toMatchObject({refused:'no_string'});
  });
  it('honours the capo: a pitch below it cannot be played',()=>{
    const base=project({type:'setStaffSettings',track:0,staff:0,settings:{...standard,capo:2}});
    expect(plan(base,guitar(0),played(40))).toMatchObject({refused:'unreachable'});
    expect(planned(base,guitar(0),played(42)).command).toMatchObject({type:'setNote',string:1,fret:0});
    expect(planned(base,guitar(0),played(44)).command).toMatchObject({type:'setNote',string:1,fret:2});
  });
  it('honours a partial capo and a banjo drone string',()=>{
    const partial=project({type:'setStaffSettings',track:0,staff:0,settings:{...standard,partialCapo:{fret:5,strings:[1]}}});
    expect(plan(partial,guitar(0),played(40))).toMatchObject({refused:'unreachable'});
    expect(planned(partial,guitar(0),played(45)).command).toMatchObject({type:'setNote',string:1,fret:0});
    // On a banjo with its drone string, whatever is written sounds the pitch that was played.
    const banjo:Project={...blankProject(),edits:[{type:'setStringCount',track:0,tuning:[62,59,55,50,67],keep:'high'},{type:'setStaffSettings',track:0,staff:0,settings:{tuning:[62,59,55,50,67],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true,droneFret:5}}]};
    let written=0;
    for(let key=48;key<=90;key++){
      const result=plan(banjo,guitar(0),played(key));
      if('refused' in result)continue;
      written++;
      expect(writtenKeys(banjo,result.command,guitar(0))).toEqual([key]);
    }
    expect(written).toBeGreaterThan(30);
  });
  it('writes pitches on a staff without strings and spells nothing by hand',()=>{
    const result=planned(project(),piano(0),played(60,64,67));
    expect(types(result.command)).toEqual(['addPitchedNote','addPitchedNote','addPitchedNote']);
    expect(steps(result.command).map(step=>(step as {pitch:number}).pitch)).toEqual([60,64,67]);
    expect(result.next).toEqual(piano(1));
    expect(writtenKeys(project(),result.command,piano(0))).toEqual([60,64,67]);
  });
  it('refuses a percussion staff and says so',()=>{
    const base:Project={...blankProject(),edits:[{type:'addPercussionTrack',name:'Drums',program:0}]};
    expect(plan(base,{track:1,staff:0,bar:0,voice:0,beat:0},played(38))).toMatchObject({refused:'percussion'});
  });
  it('always advances, whatever the typed-entry preference says, and adds a beat at the end of a bar with room',()=>{
    const base=project();
    expect(planned(base,piano(0),played(60),{advance:false}).next).toEqual(piano(1));
    const last=planned(base,piano(3),played(60),{entry:{duration:8,dots:0}});
    expect(types(last.command)).toEqual(['setDuration','addPitchedNote','insertBeat']);
    expect(last.next).toEqual(piano(4));
    // A full bar moves on to the next bar.
    const full=planned(base,piano(3),played(60));
    expect(types(full.command)).toEqual(['addPitchedNote']);
    expect(full.next).toEqual(piano(0,1));
  });
  it('applies the entry duration first, as auto-duration does, and remembers it',()=>{
    const result=planned(project(),piano(0),played(60,64),{entry:{duration:8,dots:0}});
    expect(types(result.command)).toEqual(['setDuration','addPitchedNote','addPitchedNote']);
    expect(result.entry).toEqual({duration:8,dots:0});
  });
  it('never gives up a pitch to fit the edit: eight pitches are all written, and the duration or the added beat gives way',()=>{
    const eight=played(48,50,52,53,55,57,59,60),every=[48,50,52,53,55,57,59,60];
    const alone=planned(project(),piano(0),eight);
    expect(steps(alone.command)).toHaveLength(8);
    expect(alone.notice).toBeNull();
    // The duration step would be the ninth, so the chord keeps the beat's own rhythm and says so.
    const withDuration=planned(project(),piano(0),eight,{entry:{duration:8,dots:0}});
    expect(types(withDuration.command)).toEqual(Array(8).fill('addPitchedNote'));
    expect(steps(withDuration.command).map(step=>(step as {pitch:number}).pitch)).toEqual(every);
    expect(withDuration.notice).toMatch(/duration/i);
    // Seven pitches and a duration fill the edit. Without the duration the bar is full, so dropping it would not buy a beat.
    const seven=played(48,50,52,53,55,57,60);
    const advance=planned(project(),piano(3),seven,{entry:{duration:8,dots:0}});
    expect(types(advance.command)).toEqual(['setDuration',...Array(7).fill('addPitchedNote')]);
    expect(advance.next).toEqual(piano(0,1));
    expect(advance.notice).toMatch(/beat/i);
    // Eight pitches leave no step for a new beat: every pitch is still written, the cursor goes on, and the chord says so.
    const short=project({type:'setDuration',target:piano(3),duration:8,dots:0});
    const noRoom=planned(short,piano(3),eight);
    expect(steps(noRoom.command)).toHaveLength(8);
    expect(types(noRoom.command)).not.toContain('insertBeat');
    expect(noRoom.next).toEqual(piano(0,1));
    expect(noRoom.notice).toMatch(/beat/i);
    expect(writtenKeys(short,noRoom.command,piano(3))).toEqual(every);
    expect(()=>previewEdit(project(),advance.command)).not.toThrow();
  });
  it('says when the end of the score is reached, so the next chord is not merged into the same beat',()=>{
    const base=project(),last=buildDocument(base).score.masterBars.length-1;
    const result=planned(base,piano(3,last),played(60));
    expect(result.next).toEqual(piano(3,last));
    expect(result.end).toBe(true);
    expect(result.notice).toMatch(/end of the score/i);
    expect(planned(base,piano(2,last),played(60)).end).toBeUndefined();
  });
  it('keeps the player\'s entry duration when the duration step was left out for the budget, so later chords still use it',()=>{
    const eight=played(48,50,52,53,55,57,59,60);
    const result=planned(project(),piano(0),eight,{entry:{duration:8,dots:0}});
    expect(types(result.command)).toEqual(Array(8).fill('addPitchedNote'));
    expect(result.entry).toEqual({duration:8,dots:0});
    // A chord that was never going to change the rhythm still follows the beat, as typed entry does.
    expect(planned(project(),piano(0),played(60)).entry).toEqual({duration:4,dots:0});
  });
  it('gives each reason for a beat that could not be added: the edit is full, or the rhythm does not fit',()=>{
    const full=planned(project(),piano(3),played(48,50,52,53,55,57,60),{entry:{duration:8,dots:0}});
    expect(full.notice).toMatch(/every step/i);
    const dotted=project({type:'setDuration',target:piano(3),duration:8,dots:1});
    const fits=planned(dotted,piano(3),played(60));
    expect(types(fits.command)).toEqual(['addPitchedNote']);
    expect(fits.notice).toMatch(/does not fit/i);
    expect(fits.notice).not.toMatch(/every step/i);
  });
  it('breaks a tie between equally good placements towards the lower string',()=>{
    const staff=describeSelection(buildDocument(project()).score,guitar(0)).staff;
    // A4 at fret 14 on string 4 and at fret 10 on string 5 are both two frets from a hand at 12.
    expect(planChordFingering(staff,[{key:69,string:null}],new Set(),12)).toEqual([{string:4,fret:14}]);
  });
  it('refuses a chord the staff cannot hold at all, as refused, writing nothing',()=>{
    const base=project({type:'setStaffSettings',track:1,staff:0,settings:{tuning:[],capo:0,transposition:12,displayTransposition:0,clef:4,showTab:false,showNotation:true}});
    expect(plan(base,piano(0),played(120))).toEqual({refused:'refused',name:'C9'});
  });
  it('places eight pitches on twelve strings, with a result and in a bounded time',()=>{
    const tuning=[64,59,54,49,44,39,34,29,24,19,14,9];
    const base:Project={...blankProject(),edits:[{type:'setStringCount',track:0,tuning,keep:'high'}]};
    const staff=describeSelection(buildDocument(base).score,guitar(0)).staff;
    const chord=[30,40,50,55,60,64,69,72].map(key=>({key,string:null}));
    // The bound is the work done (the search visits at most NODE_LIMIT nodes, plus the one that stops it), not the time it takes,
    // which on a loaded runner says nothing about the search; the clock only guards against a hang.
    const began=performance.now();
    const result=planChordFingering(staff,chord,new Set(),null);
    expect(lastFingeringSearchNodes()).toBeLessThanOrEqual(NODE_LIMIT+1);
    expect(performance.now()-began).toBeLessThan(60_000);
    expect(result).not.toBeNull();
    expect(new Set(result!.map(place=>place.string)).size).toBe(8);
    // Every pitch that can be played somewhere is placed, however large the search: a feasible chord is never refused.
    const hard=[35,43,51,57,62,66,71,75].map(key=>({key,string:null}));
    const startedHard=performance.now();
    expect(planChordFingering(staff,hard,new Set(),null)).not.toBeNull();
    expect(lastFingeringSearchNodes()).toBeLessThanOrEqual(NODE_LIMIT+1);
    expect(performance.now()-startedHard).toBeLessThan(60_000);
    // Eight notes that only six strings can reach have no placement, and say so.
    expect(planChordFingering(staff,[40,41,42,43,44,45,46,47].map(key=>({key,string:null})),new Set(),null)).toBeNull();
  });
  it('refuses a chord the score will not take, keeping the selection as it was',()=>{
    const base=project();
    expect(plan(base,piano(9),played(60))).toEqual({refused:'cannot_enter',name:'C4'});
  });
  it('reports where the hand ended up so the next chord is placed near it',()=>{
    const result=planned(project(),guitar(0),played(69,71));
    const frets=steps(result.command).map(step=>(step as {fret:number}).fret).filter(fret=>fret>0);
    expect(result.hand).toBe(Math.round(frets.reduce((sum,fret)=>sum+fret,0)/frets.length));
    expect(planned(project(),guitar(0),played(40)).hand).toBeUndefined();
  });
});
