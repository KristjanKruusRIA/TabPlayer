import { expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import type { HarmonyChord } from '../editor/harmony-types';
import { music,noteAt,target } from '../editor/fixtures';
import { getHarmonyChord } from './chord-source';
import { applyHarmonyEdit } from './edits';

const definition=():HarmonyChord=>({name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false});
const assign=(score:model.Score,value=definition(),fillEmptyBeat=false,index=7)=>applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:value,fillEmptyBeat},index);

it('text_edit_keeps_rich_chord_and_shared_reference_and_removal_only_clears_the_reference',()=>{
  const score=music(),beat=noteAt(score).beat,next=noteAt(score,0,1).beat;noteAt(score).dynamics=3;beat.text='existing';assign(score);const original=beat.chord!;next.chordId=beat.chordId;
  const notes=beat.notes,notesJson=model.JsonConverter.scoreToJson(score);applyHarmonyEdit(score,{type:'setBeatText',target,text:'changed'},8);
  expect(beat.chord).toBe(original);expect(next.chord).toBe(original);expect(getHarmonyChord(original)).toEqual(definition());expect(beat.notes).toBe(notes);expect(noteAt(score).dynamics).toBe(3);
  assign(score,{...definition(),showName:true},false,9);expect(beat.chordId).toBe('harmony/9/0/0/0/0/0');expect(beat.chord).not.toBe(original);expect(next.chord).toBe(original);expect(getHarmonyChord(next.chord!)).toEqual(definition());
  applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord:null,fillEmptyBeat:true},10);expect(beat.chordId).toBeNull();expect(beat.notes).toBe(notes);expect(beat.text).toBe('changed');expect(next.chord).toBe(original);expect(notesJson).toContain('existing');
});

it.each([false,true])('fill_empty_beat_uses_literal_string_mapping_and_existing_dynamics (empty %s)',empty=>{
  const score=music(),beat=noteAt(score).beat;beat.notes=[];beat.isEmpty=empty;beat.dynamics=3;beat.text='keep';const before=[beat.duration,beat.dots,beat.tupletNumerator,beat.tupletDenominator];
  assign(score,definition(),true);expect(beat.notes.map(note=>[note.string,note.fret,note.realValue,note.dynamics])).toEqual([[6,0,64,3],[5,1,60,3],[4,0,55,3],[3,2,52,3],[2,3,48,3]]);expect(beat.isEmpty).toBe(false);expect(beat.text).toBe('keep');expect([beat.duration,beat.dots,beat.tupletNumerator,beat.tupletDenominator]).toEqual(before);
});

it('annotation_only_does_not_overwrite_notes_or_fill_a_hidden_diagram',()=>{
  const score=music(),beat=noteAt(score).beat,notes=beat.notes;assign(score,definition(),true);expect(beat.notes).toBe(notes);
  beat.notes=[];beat.isEmpty=true;assign(score,{...definition(),showDiagram:false},true);expect(beat.notes).toEqual([]);expect(beat.isEmpty).toBe(true);
  assign(score,definition(),false);expect(beat.notes).toEqual([]);expect(beat.isEmpty).toBe(true);
});

it('fill_empty_beat_uses_capo_and_sounding_offset_without_changing_the_manual_definition',()=>{
  const score=music(),staff=score.tracks[0].staves[0],beat=noteAt(score).beat;staff.capo=2;staff.transpositionPitch=12;beat.notes=[];
  const value={...definition(),name:'manual shape',nameMode:'manual' as const,recipe:null};assign(score,value,true);expect(beat.notes.map(note=>note.realValue)).toEqual([54,50,45,42,38]);expect(getHarmonyChord(beat.chord!)).toEqual(value);
});

it('invalid_shape_pitch_duration_or_capacity_fails_before_any_chord_or_note_mutation',()=>{
  for(const kind of ['shape','pitch','duration','capacity','theory'] as const){
    const score=music(),staff=score.tracks[0].staves[0],beat=noteAt(score).beat;beat.notes=[];beat.isEmpty=true;beat.text='unchanged';let value=definition();
    if(kind==='shape')value={...value,frets:[0],fingers:[-2]};if(kind==='pitch'){staff.stringTuning.tunings=[127,59,55,50,45,40];value={...value,nameMode:'manual',recipe:null,frets:[1,1,0,2,3,-1]};}
    if(kind==='duration')beat.duration=0 as model.Duration;if(kind==='capacity')beat.duration=1;if(kind==='theory')value={...value,frets:[1,1,0,2,3,-1]};
    const before=model.JsonConverter.scoreToJson(score);expect(()=>assign(score,value,true)).toThrow();expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(beat.chordId).toBeNull();expect(staff.chords?.size??0).toBe(0);
  }
});

it('unchanged_apply_preserves_legacy_first_fret_zero_wide_hidden_and_untuned_name_only_diagrams',()=>{
  for(const frets of [[0,30,2,-1,19,0],[]]){
    const score=music();if(!frets.length)score.tracks[0].staves[0].stringTuning.tunings=[];
    const value:HarmonyChord={...definition(),name:' legacy ',nameMode:'manual',recipe:null,firstFret:0,frets,fingers:frets.map(()=>-1),barreFrets:[0,19,19],showName:false,showDiagram:false,showFingering:false};assign(score,value);
    const beat=noteAt(score).beat;expect(getHarmonyChord(beat.chord!)).toEqual(value);applyHarmonyEdit(score,{type:'setBeatText',target,text:'text'},8);assign(score,getHarmonyChord(beat.chord!),false,9);expect(getHarmonyChord(beat.chord!)).toEqual(value);
  }
});
