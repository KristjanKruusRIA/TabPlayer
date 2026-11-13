import { describe,expect,it } from 'vitest';
import { buildDocument,describeSelection,previewEdit } from '../engine';
import type { EditCommand,StaffSettings } from '../edit-types';
import { blankProject,type BeatTarget,type Project } from '../project';
import { entryNotes } from '../instruments/entry';
import { formatPitch } from '../tuning';
import { DEFAULT_INPUT_PREFERENCES } from './input-preferences';
import { channelString,planMidiCapture,type CapturedNote,type StringMapping } from './midi-capture';

const guitar=(beat:number,bar=0):BeatTarget=>({track:0,staff:0,bar,voice:0,beat});
const piano=(beat:number,bar=0):BeatTarget=>({track:1,staff:0,bar,voice:0,beat});
const standard:StaffSettings={tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
const withStaff=(settings:Partial<StaffSettings>=standard,...edits:EditCommand[]):Project=>({...blankProject(),edits:[{type:'addPitchedTrack',name:'Piano',program:0},{type:'setStaffSettings',track:0,staff:0,settings:{...standard,...settings}},...edits]});
const on=(channel:number,...keys:number[]):CapturedNote[]=>keys.map(key=>({key,velocity:90,channel}));
const steps=(command:EditCommand)=>command.type==='sequence'?command.commands:[command];
const plan=(base:Project,target:BeatTarget,notes:CapturedNote[],mapping?:StringMapping)=>planMidiCapture({
  project:base,score:buildDocument(base).score,target,notes,preferences:{...DEFAULT_INPUT_PREFERENCES,advance:true},entry:null,hand:null,...(mapping?{mapping}:{}),
});
const planned=(...args:Parameters<typeof plan>)=>{const result=plan(...args);if('refused' in result)throw new Error(`${result.refused}: ${result.name}`);return result;};
const refused=(...args:Parameters<typeof plan>)=>{const result=plan(...args);if(!('refused' in result))throw new Error('expected a refusal');return result;};
const track=(index:number):BeatTarget=>({track:index,staff:0,bar:0,voice:0,beat:0});
const addTrack=(base:Project,tuning:number[]):Project=>({...base,edits:[...base.edits,{type:'addTrack',name:'Strings',tuning,program:25}]});
const banjo=():Project=>({...blankProject(),edits:[{type:'addPitchedTrack',name:'Piano',program:0},{type:'setStringCount',track:0,tuning:[62,59,55,50,67],keep:'high'},{type:'setStaffSettings',track:0,staff:0,settings:{...standard,tuning:[62,59,55,50,67],droneFret:5}}]});
const placed=(command:EditCommand)=>steps(command).filter(step=>step.type==='setNote').map(step=>({string:(step as {string:number}).string,fret:(step as {fret:number}).fret}));

describe('channelString',()=>{
  const land=(count:number,mapping:StringMapping)=>[0,1,2,3,4,5].map(channel=>channelString(channel,count,mapping));
  it('maps nothing when the mapping is off',()=>{
    for(let channel=0;channel<16;channel++)expect(channelString(channel,6,'off')).toBeNull();
  });
  it('sends channel c to string c+1 from the lowest string, and to string count-c from the highest, on a 6-string track',()=>{
    expect(land(6,'lowestFirst')).toEqual([1,2,3,4,5,6]);
    expect(land(6,'highestFirst')).toEqual([6,5,4,3,2,1]);
  });
  it('documents where channels 1 to 6 of a 6-string guitar land on 4, 5, 7 and 8 string tracks',()=>{
    // Strings count from 1 for the bottom tab line. Lowest first is anchored so the guitar's low string stays the track's sixth string from the top.
    expect(land(4,'lowestFirst')).toEqual([1,2,3,4,null,null]);
    expect(land(4,'highestFirst')).toEqual([4,3,2,1,null,null]);
    expect(land(5,'lowestFirst')).toEqual([1,2,3,4,5,null]);
    expect(land(5,'highestFirst')).toEqual([5,4,3,2,1,null]);
    expect(land(7,'lowestFirst')).toEqual([2,3,4,5,6,7]);
    expect(land(7,'highestFirst')).toEqual([7,6,5,4,3,2]);
    expect(land(8,'lowestFirst')).toEqual([3,4,5,6,7,8]);
    expect(land(8,'highestFirst')).toEqual([8,7,6,5,4,3]);
  });
  it('leaves channel 10 (index 9), and channels past what a guitar has, unmapped',()=>{
    expect(channelString(9,12,'lowestFirst')).toBeNull();
    expect(channelString(9,12,'highestFirst')).toBeNull();
    expect(channelString(6,6,'lowestFirst')).toBeNull();
    expect(channelString(6,7,'lowestFirst')).toBeNull();
    expect(channelString(6,7,'highestFirst')).toBe(1);
  });
  it('never trusts a channel or string count it was not meant to get',()=>{
    for(const channel of [-1,16,1.5,Number.NaN,Infinity,'2' as unknown as number])expect(channelString(channel,6,'lowestFirst')).toBeNull();
    expect(channelString(0,0,'lowestFirst')).toBeNull();
    expect(channelString(0,-3,'highestFirst')).toBeNull();
    expect(channelString(0,Number.NaN,'lowestFirst')).toBeNull();
  });
});

describe('planMidiCapture with a MIDI guitar mapping',()=>{
  it('writes each note on the string of its channel at the fret that gives its pitch, which the cost rule would not choose',()=>{
    const base=withStaff();
    // Open strings 40 45 50 55 59 64: by cost 52 is string 3 fret 2.
    const guided=planned(base,guitar(0),on(0,52),'lowestFirst');
    expect(placed(guided.command)).toEqual([{string:1,fret:12}]);
    expect(placed(planned(base,guitar(0),on(0,52)).command)).toEqual([{string:3,fret:2}]);
    expect(placed(planned(base,guitar(0),on(0,64),'highestFirst').command)).toEqual([{string:6,fret:0}]);
    expect(guided.notice).toBeNull();expect(guided.moved).toBeUndefined();expect(guided.skipped).toBeUndefined();
  });
  it('writes a whole chord as one sequence with every note on its own string',()=>{
    const base=withStaff();
    const result=planned(base,guitar(0),[...on(0,43),...on(1,50),...on(2,57),...on(3,64)],'lowestFirst');
    expect(result.command.type).toBe('sequence');
    expect(placed(result.command)).toEqual([{string:1,fret:3},{string:2,fret:5},{string:3,fret:7},{string:4,fret:9}]);
    expect(result.next).toEqual(guitar(1));
    const score=previewEdit(base,result.command).score,{staff,beat}=describeSelection(score,guitar(0));
    expect(entryNotes(staff,beat!).map(note=>note.key).sort((a,b)=>a-b)).toEqual([43,50,57,64]);
  });
  it('takes the other order of channels when the first channel is the highest string',()=>{
    const base=withStaff();
    expect(placed(planned(base,guitar(0),[...on(0,64),...on(5,40)],'highestFirst').command)).toEqual([{string:6,fret:0},{string:1,fret:0}]);
    expect(placed(planned(base,guitar(0),on(5,52),'highestFirst').command)).toEqual([{string:1,fret:12}]);
  });
  it('honours the capo, a partial capo and the banjo drone string when it places a note on its string',()=>{
    // String 1 sounds 42 with the capo at 2, so 47 is fret 5.
    expect(placed(planned(withStaff({capo:2}),guitar(0),on(0,47),'lowestFirst').command)).toEqual([{string:1,fret:5}]);
    // A partial capo at fret 2 over string 1 only: string 1 counts from the capo, string 2 stays open.
    const partial=withStaff({partialCapo:{fret:2,strings:[1]}});
    expect(placed(planned(partial,guitar(0),[...on(0,47),...on(1,47)],'lowestFirst').command)).toEqual([{string:1,fret:5},{string:2,fret:2}]);
    // A banjo drone is string 1 (the first tab string): 69 is two semitones above its open 67, written at fret 7 beyond the drone fret 5.
    expect(placed(planned(banjo(),guitar(0),[...on(0,69),...on(1,52)],'lowestFirst').command)).toEqual([{string:1,fret:7},{string:2,fret:2}]);
    // Frets 1 to 5 do not exist on the drone string; the pitch one semitone up is fret 6.
    expect(placed(planned(banjo(),guitar(0),on(0,68),'lowestFirst').command)).toEqual([{string:1,fret:6}]);
  });
  it('writes the same pitch on two strings when it came on two channels',()=>{
    expect(placed(planned(withStaff(),guitar(0),[...on(0,45),...on(1,45)],'lowestFirst').command)).toEqual([{string:1,fret:5},{string:2,fret:0}]);
  });
  it('treats a note as (string, pitch): a pitch already on the beat on another string is still written on its own string',()=>{
    const base=withStaff(standard,{type:'setNote',target:guitar(0),string:1,fret:5});
    expect(placed(planned(base,guitar(0),on(1,45),'lowestFirst').command)).toEqual([{string:2,fret:0}]);
    // The very same string and pitch is already there: nothing to record.
    expect(refused(base,guitar(0),on(0,45),'lowestFirst').refused).toBe('present');
  });
  it('refuses the whole chord, naming the note and the string, when a mapped string cannot play the pitch even though another string could',()=>{
    const base=withStaff({capo:2});
    // String 1 would need fret 27 for 69; string 6 could play it at fret 3, but the chord is refused instead of re-fingered.
    const high=refused(base,guitar(0),on(0,69),'lowestFirst');
    expect(high.refused).toBe('unreachable');
    expect(high.name).toBe(`${formatPitch(69)} on string 1`);
    // Below the capo; the second note of the chord is not written either.
    const low=refused(base,guitar(0),[...on(0,41),...on(1,50)],'lowestFirst');
    expect(low.refused).toBe('unreachable');
    expect(low.name).toBe(`${formatPitch(41)} on string 1`);
    // Below the drone string's open pitch (67).
    expect(refused(banjo(),guitar(0),on(0,66),'lowestFirst').name).toBe(`${formatPitch(66)} on string 1`);
  });
  it('refuses a chord that puts two notes on one mapped channel, naming both notes and the string',()=>{
    const result=refused(withStaff(),guitar(0),on(2,50,57),'lowestFirst');
    expect(result.refused).toBe('channel_shared');
    expect(result.name).toBe(`${formatPitch(50)} ${formatPitch(57)} on string 3`);
  });
  it('refuses a note whose string already holds a different note on the beat',()=>{
    const base=withStaff(standard,{type:'setNote',target:guitar(0),string:3,fret:0});
    const result=refused(base,guitar(0),on(2,60),'lowestFirst');
    expect(result.refused).toBe('string_taken');
    expect(result.name).toBe(`${formatPitch(60)} on string 3`);
  });
  it('places a note on a channel with no string on this track by the fingering rule, says so, and counts it',()=>{
    const bass=addTrack(withStaff(),[43,38,33,28]);
    const result=planned(bass,track(2),[...on(0,28),...on(5,43)],'lowestFirst');
    expect(placed(result.command)).toHaveLength(2);
    expect(result.notice).toContain(formatPitch(43));
    expect(result.notice).toContain('channel 6');
    expect(result.moved).toBe(1);
  });
  it('places a note on channel 10 by the fingering rule, never on a string another note of the chord pinned',()=>{
    const result=planned(withStaff(),guitar(0),[...on(2,57),...on(9,50)],'lowestFirst');
    // 50 is string 3 open by cost, but the pinned 57 (channel 3) holds string 3 at fret 7: 50 goes to string 2 fret 5.
    expect(placed(result.command)).toEqual([{string:3,fret:7},{string:2,fret:5}]);
    expect(result.notice).toContain('channel 10');
    expect(result.moved).toBe(1);
  });
  it('reports a copy of a pitch that came on an unmapped channel, instead of skipping it quietly',()=>{
    const twice=planned(withStaff(),guitar(0),[...on(0,45),...on(9,45)],'lowestFirst');
    expect(placed(twice.command)).toEqual([{string:1,fret:5}]);
    expect(twice.skipped).toBe(1);expect(twice.moved).toBeUndefined();
    expect(twice.notice).toContain(formatPitch(45));expect(twice.notice).toContain('channel 10');
    // A pitch the beat already holds, played again on an unmapped channel, is reported as well, and the chord's other note is written.
    const held=withStaff(standard,{type:'setNote',target:guitar(0),string:1,fret:5});
    const mixed=planned(held,guitar(0),[...on(9,45),...on(2,57)],'lowestFirst');
    expect(placed(mixed.command)).toEqual([{string:3,fret:7}]);
    expect(mixed.skipped).toBe(1);
    // With nothing new at all the chord records nothing.
    expect(refused(held,guitar(0),on(9,45),'lowestFirst').refused).toBe('present');
  });
  it('writes the same notes whatever channel they come on when the mapping is off, as before MIDI guitars',()=>{
    const base=withStaff();
    expect(placed(planned(base,guitar(0),[...on(0,40),...on(0,47),...on(0,52)],'off').command)).toEqual([{string:1,fret:0},{string:2,fret:2},{string:3,fret:2}]);
    expect(planned(base,guitar(0),[...on(3,40),...on(4,47),...on(5,52)],'off')).toEqual(planned(base,guitar(0),[...on(0,40),...on(0,47),...on(0,52)],'off'));
    expect(plan(base,piano(0),on(3,60,64),'lowestFirst')).toEqual(plan(base,piano(0),on(3,60,64)));
  });
  it('anchors a 6-string guitar on tracks with other string counts, as documented',()=>{
    const seven=addTrack(withStaff(),[64,59,55,50,45,40,35]);
    // Low E (40) on channel 1 is the track's string 2, not its low B; the high string stays the top string.
    expect(placed(planned(seven,track(2),on(0,40),'lowestFirst').command)).toEqual([{string:2,fret:0}]);
    expect(placed(planned(seven,track(2),on(0,64),'highestFirst').command)).toEqual([{string:7,fret:0}]);
    const bass=addTrack(withStaff(),[43,38,33,28]);
    expect(placed(planned(bass,track(2),on(0,28),'lowestFirst').command)).toEqual([{string:1,fret:0}]);
    expect(placed(planned(bass,track(2),on(0,43),'highestFirst').command)).toEqual([{string:4,fret:0}]);
  });
  it('writes all six strings of a chord whose notes are all mapped',()=>{
    const chord=[...on(0,40),...on(1,45),...on(2,50),...on(3,55),...on(4,59),...on(5,64)];
    expect(placed(planned(withStaff(),guitar(0),chord,'lowestFirst').command)).toEqual([0,1,2,3,4,5].map(index=>({string:index+1,fret:0})));
  });
});
