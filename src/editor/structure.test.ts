import { expect, it } from 'vitest';
import { applyStructureEdit } from './structure';
import { midiPrograms } from '../midi-programs';
import { music, noteAt } from './fixtures';
import { applyNoteLink } from './techniques';
const settings={tuning:[64,59,55,50,45,40],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
it('rename_and_program_existing_imported_track and all_128_programs_are_selectable',()=>{
  const score=music(),track=score.tracks[0],note=noteAt(score);expect(midiPrograms).toHaveLength(128);
  for(let program=0;program<128;program++)applyStructureEdit(score,{type:'setTrackInfo',track:0,name:'Lead',shortName:'Ld',program},0);
  expect(score.tracks[0]).toBe(track);expect(noteAt(score)).toBe(note);expect(track.playbackInfo.program).toBe(127);
});
it('one_to_four_voices_aligned and protected last voice',()=>{
  const score=music();for(let i=0;i<3;i++)applyStructureEdit(score,{type:'addVoice',track:0,staff:0},i);
  expect(score.tracks[0].staves[0].bars.map(b=>b.voices.length)).toEqual([4,4,4,4]);expect(score.tracks[0].staves[0].bars[0].voices[1].beats[0].isEmpty).toBe(true);
  expect(()=>applyStructureEdit(score,{type:'addVoice',track:0,staff:0},4)).toThrow();
  for(let i=0;i<3;i++)applyStructureEdit(score,{type:'removeVoice',track:0,staff:0,voice:1},5);
  expect(()=>applyStructureEdit(score,{type:'removeVoice',track:0,staff:0,voice:0},6)).toThrow();
});
it('voice_copy_rebuilds_internal_links and replaces only chosen range',()=>{
  const score=music();applyNoteLink(score,{target:{track:0,staff:0,bar:0,voice:0,beat:3},string:6},{target:{track:0,staff:0,bar:1,voice:0,beat:0},string:6},'tie');
  applyStructureEdit(score,{type:'addVoice',track:0,staff:0},0);
  applyStructureEdit(score,{type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:0,endBar:1},1);
  const first=noteAt(score,0,3,1),second=noteAt(score,1,0,1);expect(first.tieDestination).toBe(second);expect(second.tieOrigin).toBe(first);expect(first).not.toBe(noteAt(score,0,3));expect(score.tracks[0].staves[0].bars[2].voices[1].beats[0].isEmpty).toBe(true);
});
it('staff settings add remove and layout',()=>{
  const score=music();applyStructureEdit(score,{type:'addStaff',track:0,settings},0);expect(score.tracks[0].staves[1].bars).toHaveLength(4);
  applyStructureEdit(score,{type:'setStaffSettings',track:0,staff:0,settings:{...settings,capo:2,transposition:1}},1);expect(noteAt(score).realValue).toBe(68);
  applyStructureEdit(score,{type:'setTrackLayout',track:0,barsPerSystem:2,lineBreaks:[1,3]},2);expect(score.tracks[0].defaultSystemsLayout).toBe(2);expect([...score.tracks[0].lineBreaks!]).toEqual([1,3]);
  applyStructureEdit(score,{type:'removeStaff',track:0,staff:1},3);expect(()=>applyStructureEdit(score,{type:'removeStaff',track:0,staff:0},4)).toThrow();
});
it('voice copy retains independent slide modes and reconstructed linked slide modes',()=>{
  const score=music(),first=noteAt(score),second=noteAt(score,0,1);first.slideOutType=1;first.slideTarget=second;second.slideOrigin=first;noteAt(score,0,2).slideOutType=3;
  applyStructureEdit(score,{type:'addVoice',track:0,staff:0},0);applyStructureEdit(score,{type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:0,endBar:0},1);
  expect(noteAt(score,0,0,1).slideOutType).toBe(1);expect(noteAt(score,0,0,1).slideTarget?.id).toBe(noteAt(score,0,1,1).id);expect(noteAt(score,0,2,1).slideOutType).toBe(3);
});
