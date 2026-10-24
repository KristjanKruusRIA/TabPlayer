import { expect,it } from 'vitest';
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
const command=(tuning:number[],keep:'high'|'low'='high')=>({type:'setStringCount',track:0,tuning,keep}) as EditCommand;
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
