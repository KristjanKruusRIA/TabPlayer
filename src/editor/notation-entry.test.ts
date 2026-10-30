import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildScore } from '../engine';
import { blankProject,type EditCommand } from '../project';
import { bottomLine,enterPitch,enteredNoteIndex,entryBlock,entryClef,entryPitch,keyAlteration,keyLetter,pitchStep,soundingKey,spellingFor,stepPitch } from './notation-entry';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const build=(edits:EditCommand[])=>buildScore({...blankProject(),edits});
const context=(score:model.Score,track=0,keySignature=0)=>{const staff=score.tracks[track].staves[0];return {staff,beat:staff.bars[0].voices[0].beats[0],target:{...target,track},keySignature};};

it('places the clefs on the right staff steps',()=>{
  const names=(clef:model.Clef)=>[0,2,4,6,8,-2,10].map(step=>stepPitch(clef,step,'natural',0)!.name);
  expect(names(model.Clef.G2)).toEqual(['E4','G4','B4','D5','F5','C4','A5']);
  expect(names(model.Clef.F4)).toEqual(['G2','B2','D3','F3','A3','E2','C4']);
  expect(names(model.Clef.C3)).toEqual(['F3','A3','C4','E4','G4','D3','B4']);
  expect(names(model.Clef.C4)).toEqual(['D3','F3','A3','C4','E4','B2','G4']);
  expect(bottomLine(model.Clef.Neutral)).toBe(bottomLine(model.Clef.G2));
});
it('gives pitches the accidental that was chosen or the key signature gives',()=>{
  expect(entryPitch(3,4,'natural',0)!.pitch).toBe(65);expect(entryPitch(3,4,'sharp',0)).toMatchObject({pitch:66,name:'F#4'});
  expect(entryPitch(6,4,'flat',0)).toMatchObject({pitch:70,name:'Bb4'});
  // G major has F sharp; D flat major has B, E, A, D and G flat.
  expect(entryPitch(3,4,'key',1)).toMatchObject({pitch:66,name:'F#4'});expect(entryPitch(3,4,'natural',1)!.pitch).toBe(65);
  expect(entryPitch(6,4,'key',-5)).toMatchObject({pitch:70,name:'Bb4'});expect(entryPitch(3,4,'key',-5)!.pitch).toBe(65);
  expect(keyAlteration(7,6)).toBe(1);expect(keyAlteration(-7,3)).toBe(-1);expect(keyAlteration(2,3)).toBe(1);expect(keyAlteration(2,4)).toBe(0);
  expect(entryPitch(0,-1,'flat',0)).toBeNull();expect(entryPitch(6,9,'sharp',0)).toBeNull();expect(entryPitch(0,4,'key',0)!.pitch).toBe(60);
});
it('maps keys and steps',()=>{
  expect(['a','B','g','h','1','Enter'].map(keyLetter)).toEqual([5,6,4,-1,-1,-1]);
  expect(pitchStep(model.Clef.G2,2,4)).toBe(0);expect(pitchStep(model.Clef.G2,0,0)).toBeNull();
});
it('spells a note only when automatic spelling would read it differently',()=>{
  const spell=(letter:number,octave:number,accidental:'key'|'natural'|'sharp'|'flat',key=0)=>spellingFor(entryPitch(letter,octave,accidental,key)!,key);
  expect(spell(3,4,'sharp')).toBe(model.NoteAccidentalMode.Default);expect(spell(6,4,'flat')).toBe(model.NoteAccidentalMode.ForceFlat);
  expect(spell(6,4,'flat',-2)).toBe(model.NoteAccidentalMode.Default);expect(spell(3,4,'sharp',-2)).toBe(model.NoteAccidentalMode.ForceSharp);
  expect(spell(2,4,'sharp')).toBe(model.NoteAccidentalMode.ForceSharp);expect(spell(0,4,'natural')).toBe(model.NoteAccidentalMode.Default);
  expect(spell(3,4,'key',1)).toBe(model.NoteAccidentalMode.Default);
});
it('enters a pitched note at its written pitch and toggles it off again',()=>{
  const score=build([{type:'addPitchedTrack',name:'Piano',program:0}]),ctx=context(score,1);
  const c5=entryPitch(0,5,'natural',0)!,result=enterPitch(ctx,c5);
  expect(result).toMatchObject({name:'C5',removes:false,action:{command:{type:'addPitchedNote',target:{...target,track:1},pitch:72},follow:{note:{pitch:72}}}});
  const placed=build([{type:'addPitchedTrack',name:'Piano',program:0},{type:'addPitchedNote',target:{...target,track:1},pitch:72}]);
  expect(enterPitch(context(placed,1),c5)).toMatchObject({name:'Remove C5',removes:true,action:{command:{type:'removeNoteByIndex',noteIndex:0}}});
  expect(enteredNoteIndex(context(placed,1).beat,result.action!.command)).toBe(0);
});
it('applies the staff transposition: the written pitch is entered, the sounding key is looked up',()=>{
  const score=build([{type:'addPitchedTrack',name:'Clarinet',program:71}]);score.tracks[1].staves[0].transpositionPitch=-2;
  const ctx=context(score,1);expect(soundingKey(ctx.staff,72)).toBe(74);
  expect(enterPitch(ctx,entryPitch(0,5,'natural',0)!).action!.command).toMatchObject({type:'addPitchedNote',pitch:72});
});
it('enters a fretted note on the lowest free fret, an octave above where it sounds',()=>{
  const score=build([]),ctx=context(score),staff=ctx.staff;
  // Written E4 sounds E3; that is fret 2 of the third string (D3), string 1 being the lowest.
  const e4=entryPitch(2,4,'natural',0)!,result=enterPitch(ctx,e4);
  expect(soundingKey(staff,e4.pitch)).toBe(52);
  expect(result.action!.command).toMatchObject({type:'setNote',string:3,fret:2});expect(result.action!.follow).toEqual({string:3,fret:2});
  const high=enterPitch(ctx,entryPitch(2,8,'natural',0)!);
  expect(high.action).toBeNull();expect(high.name).toBe('No free string can play E8');
});
it('removes a present fretted note instead of writing it again',()=>{
  const score=build([{type:'setNote',target,string:3,fret:2}]),ctx=context(score);
  expect(enterPitch(ctx,entryPitch(2,4,'natural',0)!)).toMatchObject({name:'Remove E4',removes:true,action:{command:{type:'removeNote',string:3}}});
});
it('refuses percussion and a missing beat',()=>{
  const score=build([]),staff=score.tracks[0].staves[0];
  expect(entryBlock(staff,null)).toMatch(/Select a beat/);expect(entryBlock(staff,staff.bars[0].voices[0].beats[0])).toBeNull();
  const drums=build([{type:'addPercussionTrack',name:'Drums',program:0}]).tracks[1].staves[0];expect(entryBlock(drums,null)).toMatch(/drum kit/);
  expect(entryClef(score.tracks[0].staves[0].bars[0])).toBe(model.Clef.G2);
  expect(enterPitch({...context(score),beat:null},entryPitch(0,4,'natural',0)!).action).toBeNull();
});
