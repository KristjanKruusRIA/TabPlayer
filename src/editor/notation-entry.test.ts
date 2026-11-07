import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { buildScore } from '../engine';
import { blankProject,type EditCommand } from '../project';
import { automaticSpelling,bottomLine,canSpell,displayOffset,drawnSpelling,enterPitch,enteredNoteIndex,entryBlock,entryClef,entryPitch,keyAlteration,keyLetter,pitchStep,soundingKey,spellingFor,stepPitch,writtenPitch } from './notation-entry';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const build=(edits:EditCommand[])=>buildScore({...blankProject(),edits});
const context=(score:model.Score,track=0,keySignature=0)=>{const staff=score.tracks[track].staves[0];return {staff,bar:staff.bars[0],beat:staff.bars[0].voices[0].beats[0],target:{...target,track},keySignature};};

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
  const {Default,ForceFlat,ForceSharp}=model.NoteAccidentalMode;
  expect(spell(3,4,'sharp')).toBe(Default);expect(spell(6,4,'flat')).toBe(ForceFlat);
  expect(spell(6,4,'flat',-2)).toBe(Default);expect(spell(3,4,'sharp',-2)).toBe(ForceSharp);
  expect(spell(2,4,'sharp')).toBe(ForceSharp);expect(spell(0,4,'natural')).toBe(Default);
  expect(spell(3,4,'key',1)).toBe(Default);
});
it('forces a natural that the key signature would respell, as alphaTab does',()=>{
  const {Default,ForceNatural}=model.NoteAccidentalMode,natural=(letter:number,key:number)=>spellingFor(entryPitch(letter,4,'natural',key)!,key);
  // F# major draws F as E#, C# major draws C as B#, Gb major draws B as Cb, Cb major draws E as Fb.
  expect(automaticSpelling(6,5)).toEqual({letter:2,alteration:1});
  expect(natural(3,6)).toBe(ForceNatural);expect(natural(0,7)).toBe(ForceNatural);expect(natural(6,-6)).toBe(ForceNatural);expect(natural(2,-7)).toBe(ForceNatural);
  // A natural the key signature leaves alone stays automatic.
  expect(natural(3,0)).toBe(Default);expect(natural(0,2)).toBe(Default);expect(natural(1,1)).toBe(Default);expect(natural(2,6)).toBe(Default);
});
it('reads the letter alphaTab draws for a note value, spelling mode and key',()=>{
  const {Default,ForceFlat,ForceSharp}=model.NoteAccidentalMode;
  expect(drawnSpelling(0,70,Default)).toEqual({letter:5,octave:4});expect(drawnSpelling(0,70,ForceFlat)).toEqual({letter:6,octave:4});
  expect(drawnSpelling(0,60,ForceSharp)).toEqual({letter:6,octave:3});expect(drawnSpelling(0,59,ForceFlat)).toEqual({letter:0,octave:4});
  expect(drawnSpelling(-2,70,Default)).toEqual({letter:6,octave:4});
});
it('enters a pitched note at its written pitch and toggles it off again',()=>{
  const score=build([{type:'addPitchedTrack',name:'Piano',program:0}]),ctx=context(score,1);
  const c5=entryPitch(0,5,'natural',0)!,result=enterPitch(ctx,c5);
  expect(result).toMatchObject({name:'C5',removes:false,action:{command:{type:'addPitchedNote',target:{...target,track:1},pitch:72},follow:{note:{pitch:72}}}});
  const placed=build([{type:'addPitchedTrack',name:'Piano',program:0},{type:'addPitchedNote',target:{...target,track:1},pitch:72}]);
  expect(enterPitch(context(placed,1),c5)).toMatchObject({name:'Remove C5',removes:true,action:{command:{type:'removeNoteByIndex',noteIndex:0}}});
  expect(enteredNoteIndex(context(placed,1).beat,result.action!.command)).toBe(0);
});
/** Enters a written pitch with the staff settings `setup` applies, replays the command, and returns what alphaTab draws. */
function drawnAfter(edits:EditCommand[],track:number,setup:(score:model.Score)=>void,written:number){
  const score=build(edits);setup(score);
  const letter=[0,2,4,5,7,9,11].indexOf(written%12),entered={...entryPitch(letter<0?0:letter,Math.floor(written/12)-1,'natural',0)!,pitch:written};
  const command=enterPitch(context(score,track),entered).action!.command,after=build([...edits,command]);setup(after);
  return {command,notes:after.tracks[track].staves[0].bars[0].voices[0].beats[0].notes};
}
const clarinet:EditCommand[]=[{type:'addPitchedTrack',name:'Clarinet',program:71}];
it('stores the pitch alphaTab draws at the clicked position, whatever the transposition, display transposition or ottava',()=>{
  // alphaTab draws real - display transposition + ottava, where real is the stored pitch minus the transposition.
  const transposed=drawnAfter(clarinet,1,score=>{score.tracks[1].staves[0].transpositionPitch=-2;},72);
  expect(transposed.command).toMatchObject({type:'addPitchedNote',pitch:70});expect(transposed.notes[0].displayValue).toBe(72);
  const display=drawnAfter(clarinet,1,score=>{score.tracks[1].staves[0].displayTranspositionPitch=-12;},72);
  expect(display.command).toMatchObject({pitch:60});expect(display.notes[0].displayValue).toBe(72);
  const clef=drawnAfter(clarinet,1,score=>{score.tracks[1].staves[0].bars[0].clefOttava=model.Ottavia._8vb;},72);
  expect(clef.command).toMatchObject({pitch:60});expect(clef.notes[0].displayValue).toBe(72);
  const all=drawnAfter(clarinet,1,score=>{const staff=score.tracks[1].staves[0];staff.transpositionPitch=-2;staff.displayTranspositionPitch=3;staff.bars[0].clefOttava=model.Ottavia._8va;},72);
  expect(all.command).toMatchObject({pitch:85});expect(all.notes[0].displayValue).toBe(72);
});
it('stores a fretted pitch at what the staff displays: blank guitars draw sounding pitch, imported ones an octave up',()=>{
  const blank=drawnAfter([],0,()=>{},64);
  expect(blank.notes[0].displayValue).toBe(64);expect(blank.command).toMatchObject({type:'setNote',string:6,fret:0});
  const imported=drawnAfter([],0,score=>{score.tracks[0].staves[0].displayTranspositionPitch=-12;},64);
  expect(imported.notes[0].displayValue).toBe(64);expect(imported.command).toMatchObject({type:'setNote',string:3,fret:2});
  const bass=drawnAfter([],0,score=>{score.tracks[0].staves[0].bars[0].clef=model.Clef.F4;score.tracks[0].staves[0].bars[0].clefOttava=model.Ottavia._8vb;},52);
  expect(bass.notes[0].displayValue).toBe(52);expect(bass.command).toMatchObject({string:1,fret:0});
  const score=build([]),staff=score.tracks[0].staves[0];staff.displayTranspositionPitch=-12;
  expect(displayOffset(staff,staff.bars[0],null)).toBe(12);expect(soundingKey(staff,staff.bars[0],null,76)).toBe(64);
  expect(writtenPitch(staff,staff.bars[0],staff.bars[0].voices[0].beats[0],64)).toBe(76);
});
it('enters a fretted note on the lowest free fret and refuses an unplayable pitch',()=>{
  const score=build([]),ctx=context(score);ctx.staff.displayTranspositionPitch=-12;
  // Written E4 sounds E3, fret 2 of the third string (D3), string 1 being the lowest.
  const result=enterPitch(ctx,entryPitch(2,4,'natural',0)!);
  expect(result.action!.command).toMatchObject({type:'setNote',string:3,fret:2});expect(result.action!.follow).toEqual({string:3,fret:2});
  const high=enterPitch(ctx,entryPitch(2,9,'natural',0)!);
  expect(high.action).toBeNull();expect(high.name).toBe('No free string can play E9');
});
it('removes a present fretted note instead of writing it again',()=>{
  const score=build([{type:'setNote',target,string:3,fret:2}]),ctx=context(score);ctx.staff.displayTranspositionPitch=-12;
  expect(enterPitch(ctx,entryPitch(2,4,'natural',0)!)).toMatchObject({name:'Remove E4',removes:true,action:{command:{type:'removeNote',string:3}}});
});
it('refuses percussion and a missing beat',()=>{
  const score=build([]),staff=score.tracks[0].staves[0];
  expect(entryBlock(staff,null)).toMatch(/Select a beat/);expect(entryBlock(staff,staff.bars[0].voices[0].beats[0])).toBeNull();
  const drums=build([{type:'addPercussionTrack',name:'Drums',program:0}]).tracks[1].staves[0];expect(entryBlock(drums,null)).toMatch(/drum kit/);
  expect(entryClef(score.tracks[0].staves[0].bars[0])).toBe(model.Clef.G2);
  expect(enterPitch({...context(score),beat:null},entryPitch(0,4,'natural',0)!).action).toBeNull();
});
it('gives every letter every accidental, double ones included, and stays inside the MIDI range',()=>{
  const cases:[Parameters<typeof entryPitch>[2],number,string][]=[['natural',0,''],['sharp',1,'#'],['flat',-1,'b'],['doubleSharp',2,'##'],['doubleFlat',-2,'bb']];
  const semitone=[0,2,4,5,7,9,11],letters='CDEFGAB';
  for(const [accidental,alteration,mark] of cases)for(let letter=0;letter<7;letter++){
    const entered=entryPitch(letter,4,accidental,0)!;
    expect(entered).toMatchObject({alteration,pitch:60+semitone[letter]+alteration,name:`${letters[letter]}${mark}4`});
    const mode=spellingFor(entered,0),{Default,ForceNatural,ForceSharp,ForceFlat,ForceDoubleSharp,ForceDoubleFlat}=model.NoteAccidentalMode;
    // A double is never what automatic spelling gives, and every one lands on a pitch class alphaTab can draw.
    if(alteration===2)expect(mode).toBe(ForceDoubleSharp);
    if(alteration===-2)expect(mode).toBe(ForceDoubleFlat);
    if(alteration===1)expect([Default,ForceSharp]).toContain(mode);
    if(alteration===-1)expect([Default,ForceFlat]).toContain(mode);
    if(alteration===0)expect([Default,ForceNatural]).toContain(mode);
    expect(canSpell(entered.pitch,alteration)).toBe(true);
    expect(drawnSpelling(0,entered.pitch,mode)).toEqual({letter,octave:4});
  }
  // A double is never automatic, even in a key that already alters the letter.
  expect(spellingFor(entryPitch(3,4,'doubleSharp',1)!,1)).toBe(model.NoteAccidentalMode.ForceDoubleSharp);
  expect(spellingFor(entryPitch(6,4,'doubleFlat',-5)!,-5)).toBe(model.NoteAccidentalMode.ForceDoubleFlat);
  // The MIDI bound counts the alteration: C## in octave -1 is 2, Cbb there is -2; G9 is 127, so only F## and G reach it.
  expect(entryPitch(0,-1,'doubleSharp',0)).toMatchObject({pitch:2});expect(entryPitch(0,-1,'doubleFlat',0)).toBeNull();
  expect(entryPitch(3,9,'doubleSharp',0)).toMatchObject({pitch:127,name:'F##9'});expect(entryPitch(4,9,'natural',0)!.pitch).toBe(127);
  expect(entryPitch(4,9,'doubleSharp',0)).toBeNull();expect(entryPitch(5,9,'doubleFlat',0)!.pitch).toBe(127);expect(entryPitch(5,9,'doubleSharp',0)).toBeNull();
});
it('refuses a double spelling alphaTab cannot draw instead of letting it fall back silently',()=>{
  // A double is spelled from a letter two semitones away, so only the pitch classes such a letter reaches have one.
  const semis=[0,2,4,5,7,9,11],reach=(pitchClass:number,alteration:number)=>semis.some(semitone=>((semitone+alteration)%12+12)%12===pitchClass);
  for(let pitchClass=0;pitchClass<12;pitchClass++)for(const alteration of [2,-2])expect(canSpell(pitchClass,alteration)).toBe(reach(pitchClass,alteration));
  expect(canSpell(8,2)).toBe(false);expect(canSpell(8,-2)).toBe(false);expect(canSpell(68,2)).toBe(false);expect(canSpell(8,1)).toBe(true);
  const score=build([]),synthetic={letter:3,octave:4,alteration:2,pitch:68,name:'F##4'};
  expect(enterPitch(context(score),synthetic)).toMatchObject({action:null,unspellable:true,removes:false});
  expect(enterPitch(context(score),entryPitch(3,4,'doubleSharp',0)!).action).not.toBeNull();
});
