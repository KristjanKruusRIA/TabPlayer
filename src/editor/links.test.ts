import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { allNotes,captureNoteLinks,detachNote,restoreNoteLinks } from './links';
import { applyRangeEdit } from './range-edits';

const settings=new Settings();
function duplicateTies() {
  const score=new model.Score();score.addMasterBar(new model.MasterBar());
  const track=new model.Track(),staff=new model.Staff(),bar=new model.Bar(),voice=new model.Voice();
  staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);staff.addBar(bar);bar.addVoice(voice);
  for(let i=0;i<4;i++){const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);}
  const add=(beat:number,tied:boolean)=>{const note=new model.Note();note.string=1;note.fret=3;note.isTieDestination=tied;voice.beats[beat].addNote(note);return note;};
  const origin=add(0,false),first=add(1,true),last=add(1,true);score.finish(settings);
  return {score,origin,first,last};
}
function clone(score:model.Score){return scoreFromJson(model.JsonConverter.scoreToJson(score),settings);}

it('captures_duplicate_incoming_ties_before_the_canonical_forward_link_without_mutation',()=>{
  const {score,origin,first,last}=duplicateTies(),before=model.JsonConverter.scoreToJson(score);
  expect(first.tieOrigin).toBe(origin);expect(last.tieOrigin).toBe(origin);expect(origin.tieDestination).toBe(last);
  const links=captureNoteLinks(score);
  expect(links).toEqual([{from:origin.id,to:first.id,kind:'tie'},{from:origin.id,to:last.id,kind:'tie'}]);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  expect(first.tieOrigin).toBe(origin);expect(last.tieOrigin).toBe(origin);expect(origin.tieDestination).toBe(last);
  const copy=clone(score);restoreNoteLinks(copy,links);
  const notes=new Map(allNotes(copy).map(note=>[note.id,note]));
  expect(notes.get(first.id)!.tieOrigin).toBe(notes.get(origin.id));expect(notes.get(last.id)!.tieOrigin).toBe(notes.get(origin.id));
  expect(notes.get(origin.id)!.tieDestination).toBe(notes.get(last.id));expect(captureNoteLinks(copy)).toEqual(links);
});

it('does_not_duplicate_reciprocal_ties_or_change_the_other_link_families',()=>{
  const {score,origin,first,last}=duplicateTies();first.tieOrigin=null;first.isTieDestination=false;
  origin.slurDestination=first;first.slurOrigin=origin;first.isSlurDestination=true;
  first.slideTarget=last;first.slideOutType=model.SlideOutType.Legato;last.slideOrigin=first;
  origin.hammerPullDestination=last;origin.isHammerPullOrigin=true;last.hammerPullOrigin=origin;
  const links=captureNoteLinks(score);
  expect(links).toEqual([
    {from:origin.id,to:last.id,kind:'tie'},
    {from:origin.id,to:first.id,kind:'slur'},
    {from:origin.id,to:last.id,kind:'hammerPull'},
    {from:first.id,to:last.id,kind:'slide',slideOutType:model.SlideOutType.Legato},
  ]);
  const copy=clone(score);restoreNoteLinks(copy,links);expect(captureNoteLinks(copy)).toEqual(links);
});

it('restores_by_note_id_after_chord_order_changes_and_skips_missing_endpoints',()=>{
  const {score,origin,first,last}=duplicateTies(),links=captureNoteLinks(score),copy=clone(score),beats=copy.tracks[0].staves[0].bars[0].voices[0].beats;
  beats[1].notes.reverse();restoreNoteLinks(copy,links);
  expect(beats[0].notes[0].tieDestination).toBe(beats[1].notes[0]);
  expect(beats[1].notes.every(note=>note.tieOrigin===beats[0].notes[0])).toBe(true);
  beats[1].notes=beats[1].notes.filter(note=>note.id!==last.id);restoreNoteLinks(copy,links);
  expect(beats[0].notes[0].tieDestination?.id).toBe(first.id);expect(beats[1].notes[0].tieOrigin?.id).toBe(origin.id);
  beats[0].notes=[];restoreNoteLinks(copy,links);
  expect(beats[1].notes[0].tieOrigin).toBeNull();expect(beats[1].notes[0].isTieDestination).toBe(false);
});

it('detaching_a_duplicate_tie_destination_keeps_the_surviving_canonical_edge',()=>{
  const {origin,first,last}=duplicateTies();detachNote(first);
  expect(first.tieOrigin).toBeNull();expect(first.isTieDestination).toBe(false);
  expect(origin.tieDestination).toBe(last);expect(last.tieOrigin).toBe(origin);expect(last.isTieDestination).toBe(true);
});

it('detaching_an_origin_clears_every_duplicate_tie_and_continued_bend',()=>{
  const {score,origin,first,last}=duplicateTies();for(const note of [first,last]){note.bendOrigin=origin;note.isContinuedBend=true;}
  expect(applyRangeEdit(score,{type:'eraseSelection',selection:{kind:'notes',notes:[{target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0}]}})).toBe(true);
  for(const note of [first,last]){expect(note.tieOrigin).toBeNull();expect(note.isTieDestination).toBe(false);expect(note.bendOrigin).toBeNull();expect(note.isContinuedBend).toBe(false);}
  expect(captureNoteLinks(score)).toEqual([]);expect(allNotes(clone(score)).every(note=>note.tieOrigin===null&&!note.isTieDestination)).toBe(true);
});

it('detaching_the_canonical_destination_leaves_the_other_tie_available_for_origin_removal',()=>{
  const {origin,first,last}=duplicateTies();detachNote(last);
  expect(origin.tieDestination).toBe(first);expect(first.tieOrigin).toBe(origin);
  detachNote(origin);expect(first.tieOrigin).toBeNull();expect(first.isTieDestination).toBe(false);
});
