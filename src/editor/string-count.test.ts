import { describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { applyStructureEdit } from './structure';
import { getHarmonyChord,setHarmonyChordSource } from '../harmony/chord-source';
import { validateParityCommand } from '../parity-commands';
import { buildDocument,exportGp,previewEdit,validateProject } from '../engine';
import { blankProject } from '../project';
import type { EditCommand } from '../edit-types';
import { loadInterchangeScore } from '../interchange/gp';
import { applyNoteLink,applyNoteTechniques } from './techniques';

const standard=[64,59,55,50,45,40],seven=[64,59,55,50,45,40,35];
const command=(tuning:number[],keep:'high'|'low'='high',crossVoice?:boolean)=>({type:'setStringCount',track:0,tuning,keep,...(crossVoice!==undefined?{crossVoice}:{})} as EditCommand);
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const allNotes=(score:model.Score)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)));
const place=(score:model.Score)=>allNotes(score).map(note=>`${note.string}:${note.fret}`);
const pitches=(score:model.Score)=>allNotes(score).map(note=>note.realValue);
/** Bar 1 holds a chord on every string of standard tuning: low E open up to high E fret 1. */
function chords() {
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0];beat.removeNote(beat.notes[0]);
  for(let string=1;string<=6;string++){const note=new model.Note();note.string=string;note.fret=string===6?1:0;beat.addNote(note);}
  score.finish(new Settings());return score;
}

it('adds a low seventh string, keeping every note on its string from the top at the same pitch',()=>{
  const score=chords(),before=pitches(score);
  expect(applyStructureEdit(score,command(seven),0)).toBe(true);
  expect(score.tracks[0].staves[0].tuning).toEqual(seven);
  expect(pitches(score)).toEqual(before);
  expect(place(score).slice(0,6)).toEqual(['2:0','3:0','4:0','5:0','6:0','7:1']);
});

it('adds a high string with the bottom strings kept, refretting nothing',()=>{
  const score=chords(),before=pitches(score),frets=place(score);
  applyStructureEdit(score,command([69,...standard],'low'),0);
  expect(pitches(score)).toEqual(before);expect(place(score)).toEqual(frets);
});

it('moves notes off a removed string to a free playable string at the same pitch',()=>{
  const score=music(),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  applyStructureEdit(score,command(seven),0);
  const note=new model.Note();note.string=1;note.fret=7;beats[1].addNote(note);score.finish(new Settings());
  const before=pitches(score);
  applyStructureEdit(score,command(standard),0);
  expect(pitches(score)).toEqual(before);
  expect(beats[1].notes.map(value=>`${value.string}:${value.fret}`)).toEqual(['6:3','1:2']);
});

it('refuses atomically when a note has no playable string or a linked note would move',()=>{
  const low=music();applyStructureEdit(low,command(seven),0);
  const beat=low.tracks[0].staves[0].bars[1].voices[0].beats[0],deep=new model.Note();deep.string=1;deep.fret=2;beat.addNote(deep);low.finish(new Settings());
  const before=json(low);
  expect(()=>applyStructureEdit(low,command(standard),0)).toThrow('no playable string');
  expect(json(low)).toEqual(before);
  const linked=music();applyStructureEdit(linked,command(seven),0);
  const [a,b]=linked.tracks[0].staves[0].bars[0].voices[0].beats;
  for(const value of [a,b]){const note=new model.Note();note.string=1;note.fret=9;value.addNote(note);}
  linked.finish(new Settings());a.notes[1].tieDestination=b.notes[1];b.notes[1].tieOrigin=a.notes[1];b.notes[1].isTieDestination=true;
  const clean=json(linked);
  expect(()=>applyStructureEdit(linked,command(standard),0)).toThrow('linked');
  expect(json(linked)).toEqual(clean);
});

it('remaps chord diagrams and their fingerings with the kept strings',()=>{
  const score=music(),staff=score.tracks[0].staves[0],chord=new model.Chord();
  chord.name='Em';chord.strings=[0,0,0,2,2,0];chord.showDiagram=true;staff.addChord('em',chord);staff.bars[0].voices[0].beats[0].chordId='em';
  setHarmonyChordSource(chord,{...getHarmonyChord(chord),fingers:[-2,-2,-2,3,2,-2]});
  applyStructureEdit(score,command(seven),0);
  expect(chord.strings).toEqual([0,0,0,2,2,0,-1]);expect(getHarmonyChord(chord).fingers).toEqual([-2,-2,-2,3,2,-2,-2]);
  applyStructureEdit(score,command([69,...seven],'low'),0);
  expect(chord.strings).toEqual([-1,0,0,0,2,2,0,-1]);
  applyStructureEdit(score,command(standard),0);
  expect(chord.strings).toEqual([-1,0,0,0,2,2]);
});

it('refuses drums, an unchanged count, invalid tunings and keep values',()=>{
  const score=music(),clean=json(score);
  expect(()=>applyStructureEdit(score,command([64,59,55,50,45,38]),0)).toThrow('Apply tuning');
  for(const tuning of [[],Array(13).fill(40),[64,59,55,50,45,40,128],[64,59,55,50,45,40,-1]])expect(()=>applyStructureEdit(score,command(tuning),0)).toThrow();
  expect(()=>applyStructureEdit(score,command(seven,'middle' as 'high'),0)).toThrow();
  expect(json(score)).toEqual(clean);
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;drums.tracks[0].staves[0].stringTuning.tunings=[];
  expect(()=>applyStructureEdit(drums,command(seven),0)).toThrow('stringed');
});

it('validates the command envelope for saved projects',()=>{
  const edit={type:'setStringCount',track:0,tuning:seven,keep:'high'};
  expect(()=>validateParityCommand(edit)).not.toThrow();
  expect(validateProject({...blankProject(),edits:[edit]}).edits).toEqual([edit]);
  for(const bad of [{...edit,keep:'top'},{...edit,tuning:[]},{...edit,tuning:Array(13).fill(40)},{...edit,tuning:[128]},{...edit,track:-1},{...edit,extra:0}])expect(()=>validateParityCommand(bad)).toThrow();
});

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const beatAt=(score:model.Score,index:number)=>score.tracks[0].staves[0].bars[0].voices[0].beats[index];
const noteTarget=(beat:number,string=3)=>({target:{...target,beat},string});
function sparse(tuning=standard) {
  const score=music();score.tracks[0].staves[0].stringTuning.tunings=[...tuning];
  for(const note of allNotes(score))note.beat.removeNote(note);
  return score;
}
function add(score:model.Score,beat:number,string:number,fret:number) {
  const note=new model.Note();note.string=string;note.fret=fret;beatAt(score,beat).addNote(note);return note;
}
function imported(score:model.Score) {
  const bytes=exportGp(score);
  return {...blankProject(),base:{kind:'file' as const,filename:'strings.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
const round=(score:model.Score)=>loadInterchangeScore(exportGp(score),new Settings());
type LaneLink='tie'|'slide'|'hammerPull';
function linked(kind:LaneLink,intervening=true) {
  const score=sparse(seven);add(score,0,3,3);add(score,1,1,intervening?14:30);add(score,2,3,3);score.finish(new Settings());
  if(kind==='slide')applyNoteTechniques(score,noteTarget(0),{slideOut:model.SlideOutType.Shift});
  else applyNoteLink(score,noteTarget(0),noteTarget(2),kind);
  return score;
}
function expectLink(score:model.Score,kind:LaneLink) {
  const from=beatAt(score,0).notes[0],to=beatAt(score,2).notes[0];
  if(kind==='tie'){expect(from.tieDestination).toBe(to);expect(to.tieOrigin).toBe(from);expect(to.isTieDestination).toBe(true);}
  if(kind==='slide'){expect(from.slideTarget).toBe(to);expect(to.slideOrigin).toBe(from);expect(from.slideOutType).toBe(model.SlideOutType.Shift);}
  if(kind==='hammerPull'){expect(from.hammerPullDestination).toBe(to);expect(to.hammerPullOrigin).toBe(from);expect(from.isHammerPullOrigin).toBe(true);}
}

it.each([false,true])('finds a complete displaced-note assignment independent of source order (reversed=%s)',reversed=>{
  const score=sparse(),members=[[6,0],[5,20]];if(reversed)members.reverse();
  for(const [string,fret] of members)add(score,0,string,fret);score.finish(new Settings());
  const project=imported(score),original=JSON.stringify(project),edited=previewEdit(project,command([55,50,45,40],'low'));
  for(const result of [edited.score,buildDocument(JSON.parse(JSON.stringify(edited.project))).score,round(edited.score)]){
    expect(allNotes(result).map(note=>[note.realValue,note.string,note.fret]).sort((a,b)=>a[0]-b[0])).toEqual([[64,3,14],[79,4,24]]);
  }
  expect(JSON.stringify(project)).toBe(original);expect(edited.project.base).toEqual(project.base);
});

it.each(['tie','slide','hammerPull'] as const)('refuses atomically when a proposed relocation intercepts a kept %s',kind=>{
  const score=linked(kind),before=json(score),project=imported(score),original=JSON.stringify(project),current=buildDocument(project),currentJson=json(current.score);
  expect(pitches(current.score)).toEqual([48,49,48]);expectLink(current.score,kind);
  expect(()=>applyStructureEdit(score,command(standard),0)).toThrow('relationship');expect(json(score)).toBe(before);
  expect(()=>previewEdit(project,command(standard),current)).toThrow('relationship');
  expect(()=>buildDocument({...project,edits:[command(standard)]})).toThrow('relationship');
  expect(JSON.stringify(project)).toBe(original);expect(json(current.score)).toBe(currentJson);
  const reopened=round(current.score);expect(pitches(reopened)).toEqual([48,49,48]);expectLink(reopened,kind);
});

it.each(['tie','slide','hammerPull'] as const)('checks a %s authored earlier in replay history before relocating an intervening note',kind=>{
  const score=sparse(seven);add(score,0,3,3);add(score,1,1,14);add(score,2,3,3);score.finish(new Settings());
  const link:EditCommand=kind==='slide'?{type:'setNoteTechniques',...noteTarget(0),patch:{slideOut:model.SlideOutType.Shift}}:{type:'setNoteLink',from:noteTarget(0),to:noteTarget(2),kind};
  const project={...imported(score),edits:[link]},original=JSON.stringify(project);
  expectLink(buildDocument(project).score,kind);
  expect(()=>previewEdit(project,command(standard))).toThrow('relationship');
  expect(()=>buildDocument({...project,edits:[link,command(standard)]})).toThrow('relationship');
  expect(JSON.stringify(project)).toBe(original);
});

it.each(['tie','slide','hammerPull'] as const)('preserves kept %s endpoints, effects and other tracks through replay and GP reopen',kind=>{
  const score=linked(kind,false),note=beatAt(score,0).notes[0];note.isGhost=true;note.isPalmMute=true;note.vibrato=model.VibratoType.Slight;
  const other=music().tracks[0];other.name='Untouched';score.addTrack(other);score.finish(new Settings());
  const project=imported(score),original=JSON.stringify(project),edited=previewEdit(project,command(standard));
  for(const result of [edited.score,buildDocument(JSON.parse(JSON.stringify(edited.project))).score,round(edited.score)]){
    expect(pitches(result)).toEqual([48,65,48]);expectLink(result,kind);
    expect(beatAt(result,0).notes[0]).toMatchObject({string:2,fret:3,isGhost:true,isPalmMute:true,vibrato:model.VibratoType.Slight});
    expect(result.tracks[1].staves[0].tuning).toEqual(standard);
    expect(result.tracks[1].staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes.map(note=>[note.string,note.fret,note.realValue])))).toEqual(Array.from({length:16},()=>[6,3,67]));
  }
  expect(JSON.stringify(project)).toBe(original);expect(edited.project.base).toEqual(project.base);
});

it('keeps explicit slurs across intervening notes instead of imposing next-note semantics',()=>{
  const score=sparse(seven);add(score,0,3,3);add(score,1,1,14);add(score,2,3,3);score.finish(new Settings());
  const project={...imported(score),edits:[{type:'setNoteLink' as const,from:noteTarget(0),to:noteTarget(2),kind:'slur' as const}]};
  const edited=previewEdit(project,command(standard));
  for(const result of [edited.score,buildDocument(JSON.parse(JSON.stringify(edited.project))).score]){
    expect(pitches(result)).toEqual([48,49,48]);expect(beatAt(result,0).notes[0].slurDestination).toBe(beatAt(result,2).notes[0]);
  }
});

it('plans every staff before committing and preserves the source project when a later staff cannot fit',()=>{
  const score=music(),second=music().tracks[0].staves[0];score.tracks[0].addStaff(second);
  for(const bar of second.bars)for(const beat of bar.voices[0].beats){beat.notes[0].string=1;beat.notes[0].fret=0;}
  const other=music().tracks[0];score.addTrack(other);score.finish(new Settings());
  const before=json(score),project=imported(score),original=JSON.stringify(project),current=buildDocument(project),currentJson=json(current.score),edit=command([64,59,55,50]);
  expect(()=>applyStructureEdit(score,edit,0)).toThrow('no playable string');expect(json(score)).toBe(before);
  expect(()=>previewEdit(project,edit,current)).toThrow('no playable string');expect(()=>buildDocument({...project,edits:[edit]})).toThrow('no playable string');
  expect(JSON.stringify(project)).toBe(original);expect(json(current.score)).toBe(currentJson);
});

/** Bar 1, beat 1 of a standard-tuned score holding only the given string:fret notes. */
function beatWith(values:[number,number][]) {
  const score=music(),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0];for(const note of [...beat.notes])beat.removeNote(note);
  for(const [string,fret] of values){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
  score.finish(new Settings());return {score,beat};
}
const placed=(beat:model.Beat)=>beat.notes.map(note=>`${note.string}:${note.fret}`);

it('moves a note off its kept string when that lets every note of the beat fit',()=>{
  // Removing the low E: the A2 on it needs the A string, which its kept D3 neighbour can leave for the open D string.
  const {score,beat}=beatWith([[1,5],[2,5]]),before=beat.notes.map(note=>note.realValue);
  applyStructureEdit(score,command(standard.slice(0,5)),0);
  expect(beat.notes.map(note=>note.realValue)).toEqual(before);
  expect(placed(beat)).toEqual(['1:0','2:0']);
});

it('leaves a link the file already held off the next-note pattern when nothing it joins changes string',()=>{
  // A hammer-on onto a tapped note on the next string up, as alphaTab reads from GP files.
  const {score,beat}=beatWith([[3,5]]),next=score.tracks[0].staves[0].bars[0].voices[0].beats[1],tapped=new model.Note();
  tapped.string=4;tapped.fret=7;next.addNote(tapped);score.finish(new Settings());
  beat.notes[0].hammerPullDestination=tapped;beat.notes[0].isHammerPullOrigin=true;tapped.hammerPullOrigin=beat.notes[0];
  applyStructureEdit(score,command(seven),0);
  expect(placed(beat)).toEqual(['4:5']);expect(tapped.string).toBe(5);expect(beat.notes[0].hammerPullDestination).toBe(tapped);
});

it('holds kept notes to the playable frets that moved notes get',()=>{
  // Retuned this low, the high E would sit at fret 34 on its kept string: there is no playable place, so it is refused.
  const {score}=beatWith([[6,0]]),before=json(score);
  expect(()=>applyStructureEdit(score,command([30,29,28,27,26,25,24]),0)).toThrow('no playable string');
  expect(json(score)).toBe(before);
  // A note already above fret 24 keeps its fret when its string keeps its pitch.
  const high=beatWith([[6,30]]);applyStructureEdit(high.score,command(seven),0);
  expect(placed(high.beat)).toEqual(['7:30']);
});

it('moves a dead note off a removed string by its fret, since it has no pitch',()=>{
  const {score,beat}=beatWith([]);applyStructureEdit(score,command(seven),0);
  const dead=new model.Note();dead.string=1;dead.fret=3;dead.isDead=true;beat.addNote(dead);score.finish(new Settings());
  applyStructureEdit(score,command(standard),0);
  expect(placed(beat)).toEqual(['6:3']);expect(dead.isDead).toBe(true);
});


describe('S19: cross-voice collision checks in setStringCount', () => {
  it('never puts notes of two voices that sound together on one string after a string count change with crossVoice: true', () => {
    // 7-string tuning [64,59,55,50,45,40,35] (strings 7 down to 1)
    // String 1 is low B1 (35), String 2 is E2 (40), String 3 is A2 (45)
    const base = sparse(seven);
    applyStructureEdit(base, { type: 'addVoice', track: 0, staff: 0 }, 0);
    const staff = base.tracks[0].staves[0];
    const bar = staff.bars[0];

    // Voice 0, beat 0 has A2 (pitch 45) on string 3 (open string 3)
    add(base, 0, 3, 0);

    // Voice 1, beat 0 has A2 (pitch 45) on string 1 (fret 10)
    const n2 = new model.Note();
    n2.string = 1;
    n2.fret = 10;
    bar.voices[1].beats[0].addNote(n2);
    bar.voices[1].beats[0].isEmpty = false;
    base.finish(new Settings());

    // Reduce from 7 strings to 6 (standard: [64,59,55,50,45,40]) keeping high strings (keep: 'high').
    // With crossVoice: true, Voice 1 must NOT land on Voice 0's string!
    applyStructureEdit(base, command(standard, 'high', true), 1);

    const first = bar.voices[0].beats[0].notes[0];
    const second = bar.voices[1].beats[0].notes[0];
    expect(first.string).not.toBe(second.string);
    expect(first.realValue).toBe(45);
    expect(second.realValue).toBe(45);
  });

  it('replays old logs without crossVoice exactly as before, allowing notes in different voices to land on one string without error', () => {
    const base = sparse(seven);
    applyStructureEdit(base, { type: 'addVoice', track: 0, staff: 0 }, 0);
    const staff = base.tracks[0].staves[0];
    const bar = staff.bars[0];

    // Voice 0, beat 0 has A2 (pitch 45) on string 3 (open string 3)
    add(base, 0, 3, 0);

    // Voice 1, beat 0 has A2 (pitch 45) on string 1 (fret 10)
    const n2 = new model.Note();
    n2.string = 1;
    n2.fret = 10;
    bar.voices[1].beats[0].addNote(n2);
    bar.voices[1].beats[0].isEmpty = false;
    base.finish(new Settings());

    // Replaying an old log: command without crossVoice
    applyStructureEdit(base, command(standard, 'high'), 1);

    const first = bar.voices[0].beats[0].notes[0];
    const second = bar.voices[1].beats[0].notes[0];
    // In the old algorithm without cross-voice checks, both voices choose string 2 (fret 0)
    expect(first.string).toBe(2);
    expect(second.string).toBe(2);
  });

  it('refuses and lists conflicting notes when overlapping voices have no free strings and crossVoice is true', () => {
    // 2-string tuning [45, 40] reducing to 1-string [40]
    const twoStrings = [45, 40];
    const oneString = [40];
    const s2 = sparse(twoStrings);
    applyStructureEdit(s2, { type: 'addVoice', track: 0, staff: 0 }, 0);
    const b2 = s2.tracks[0].staves[0].bars[0];

    // Voice 0 has note on string 1 (fret 0, pitch 40)
    const noteV0 = new model.Note();
    noteV0.string = 1;
    noteV0.fret = 0;
    b2.voices[0].beats[0].addNote(noteV0);
    b2.voices[0].beats[0].isEmpty = false;

    // Voice 1 has note on string 2 (pitch 45)
    const noteV1 = new model.Note();
    noteV1.string = 2;
    noteV1.fret = 0;
    b2.voices[1].beats[0].addNote(noteV1);
    b2.voices[1].beats[0].isEmpty = false;
    s2.finish(new Settings());

    // Without crossVoice, old behavior replays without throwing:
    const oldScore = sparse(twoStrings);
    applyStructureEdit(oldScore, { type: 'addVoice', track: 0, staff: 0 }, 0);
    const oldB2 = oldScore.tracks[0].staves[0].bars[0];
    const oV0 = new model.Note(); oV0.string = 1; oV0.fret = 0; oldB2.voices[0].beats[0].addNote(oV0); oldB2.voices[0].beats[0].isEmpty = false;
    const oV1 = new model.Note(); oV1.string = 2; oV1.fret = 0; oldB2.voices[1].beats[0].addNote(oV1); oldB2.voices[1].beats[0].isEmpty = false;
    oldScore.finish(new Settings());
    expect(() => applyStructureEdit(oldScore, { type: 'setStringCount', track: 0, tuning: oneString, keep: 'low' }, 1)).not.toThrow();

    // With crossVoice: true, new behavior throws and lists the conflicting notes:
    expect(() => applyStructureEdit(s2, { type: 'setStringCount', track: 0, tuning: oneString, keep: 'low', crossVoice: true }, 1))
      .toThrow(/the notes of this beat have no free strings for all of them/);
  });

  it('uses current rhythm including an edit made just before to detect cross-voice overlap', () => {
    // Voice 0 beat 0 is lengthened from quarter note (4) to half note (2).
    // Voice 1 beat 1 (which starts at tick 960) now overlaps Voice 0 (0 to 1920 ticks).
    const base = sparse(seven);
    applyStructureEdit(base, { type: 'addVoice', track: 0, staff: 0 }, 0);
    const staff = base.tracks[0].staves[0];
    const bar = staff.bars[0];

    // Voice 0, beat 0: duration = 2 (half note), note on string 3 (pitch 45)
    bar.voices[0].beats[0].duration = 2;
    add(base, 0, 3, 0);

    // Voice 1, beat 0 is a quarter rest (duration = 4), beat 1 is a quarter note on string 1 (fret 10, pitch 45)
    bar.voices[1].beats[0].duration = 4;
    bar.voices[1].beats[0].isEmpty = false;

    const b1 = new model.Beat();
    b1.duration = 4;
    b1.isEmpty = false;
    const n2 = new model.Note();
    n2.string = 1;
    n2.fret = 10;
    b1.addNote(n2);
    bar.voices[1].addBeat(b1);
    base.finish(new Settings());

    // With crossVoice: true, setStringCount uses beatSpans(bar) to calculate current rhythm and avoids collision
    applyStructureEdit(base, command(standard, 'high', true), 1);

    const first = bar.voices[0].beats[0].notes[0];
    const second = bar.voices[1].beats[1].notes[0];
    expect(first.string).not.toBe(second.string);
    expect(first.realValue).toBe(45);
    expect(second.realValue).toBe(45);
  });

  it('replays a saved project log without crossVoice via buildDocument without regression', () => {
    const p = blankProject();
    const doc = buildDocument(p);
    // Apply edits to build a 2-voice score then reduce string count without crossVoice
    const ed1: EditCommand = { type: 'addVoice', track: 0, staff: 0 };
    const ed2: EditCommand = { type: 'setStringCount', track: 0, tuning: [64, 59, 55, 50, 45, 40, 35], keep: 'high' };
    const ed3: EditCommand = { type: 'setStringCount', track: 0, tuning: standard, keep: 'high' };
    const projectWithLog = {
      ...p,
      edits: [ed1, ed2, ed3],
    };
    const rebuilt = buildDocument(projectWithLog);
    expect(rebuilt.score.tracks[0].staves[0].tuning).toEqual(standard);
  });
});