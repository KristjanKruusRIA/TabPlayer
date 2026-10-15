import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { rangeFromBeats,resolveSelectionBeats,resolveSelectionNotes,selectionForBars,selectionForTrack,validateMusicSelection } from './range-selection';
import type { MusicSelection } from './range-types';

const lane={track:0,staff:0,voice:0};
const range:MusicSelection={kind:'range',range:{start:{bar:0,tick:960},end:{bar:1,tick:960},lanes:[lane]}};
it('half_open_onsets_reverse_drag_and_partial_chord',()=>{
  const score=music(),staff=score.tracks[0].staves[0],first=staff.bars[0].voices[0].beats[1],extra=new model.Note();extra.string=5;extra.fret=0;first.addNote(extra);
  expect(resolveSelectionBeats(score,range).map(b=>[b.voice.bar.index,b.index])).toEqual([[0,1],[0,2],[0,3],[1,0]]);
  expect(resolveSelectionNotes(score,range)).toHaveLength(5);
  expect(rangeFromBeats(score,{...target,bar:1,beat:0},{...target,beat:1},[lane])).toEqual(range.range);
  const notes:MusicSelection={kind:'notes',notes:[{target:{...target,beat:1},noteIndex:1}]};
  expect(resolveSelectionNotes(score,notes)).toEqual([extra]);expect(resolveSelectionBeats(score,notes)).toEqual([first]);
  notes.notes.push({target:{...target,beat:1},noteIndex:0});expect(resolveSelectionBeats(score,notes)).toEqual([first]);
});
it('resolves overlapping lanes and tracks once in score order',()=>{
  const score=music(),other=music().tracks[0];score.addTrack(other);
  const staff=score.tracks[0].staves[0];for(const bar of staff.bars){const voice=new model.Voice(),beat=new model.Beat();beat.duration=1;beat.isEmpty=false;voice.addBeat(beat);bar.addVoice(voice);}
  score.finish(new Settings());
  const selection:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:1920},lanes:[{track:1,staff:0,voice:0},{...lane,voice:1},lane]}};
  expect(resolveSelectionBeats(score,selection).map(b=>[b.voice.bar.staff.track.index,b.voice.index,b.index])).toEqual([[0,0,0],[0,0,1],[0,1,0],[1,0,0],[1,0,1]]);
});
it('grace_groups_follow_attack_and_validate_all_lanes',()=>{
  const score=music(),voice=score.tracks[0].staves[0].bars[0].voices[0];
  const grace=(kind:model.GraceType)=>{const beat=new model.Beat();beat.graceType=kind;beat.duration=16;beat.isEmpty=false;const note=new model.Note();note.string=1;note.fret=0;beat.addNote(note);return beat;};
  const before=grace(model.GraceType.BeforeBeat),on=grace(model.GraceType.OnBeat);before.voice=voice;on.voice=voice;voice.beats.splice(1,0,before,on);score.finish(new Settings());
  const selected:MusicSelection={kind:'range',range:{start:{bar:0,tick:960},end:{bar:0,tick:1920},lanes:[lane]}};
  expect(resolveSelectionBeats(score,selected)).toEqual([before,on,voice.beats[3]]);
  expect(resolveSelectionNotes(score,{kind:'notes',notes:[{target:{...target,beat:1},noteIndex:0}]})).toEqual(before.notes);
  const fingerprint=JSON.stringify(model.JsonConverter.scoreToJson(score));
  const invalid:MusicSelection={kind:'range',range:{...selected.range,lanes:[lane,{...lane,voice:3}]}};
  expect(()=>resolveSelectionNotes(score,invalid)).toThrow(/voice|lane/i);
  expect(()=>resolveSelectionNotes(score,{kind:'notes',notes:[{target,noteIndex:0},{target:{...target,bar:99},noteIndex:0}]})).toThrow();
  expect(()=>resolveSelectionNotes(score,{kind:'notes',notes:[{target,noteIndex:0},{target,noteIndex:0}]})).toThrow(/duplicate/i);
  expect(()=>validateMusicSelection(score,{kind:'range',range:{...selected.range,lanes:[lane,lane]}})).toThrow(/duplicate/i);
  expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(fingerprint);
});
it('bar and track selections support empty free-time bars without fake ticks',()=>{
  const score=music();for(const master of score.masterBars)master.isFreeTime=true;for(const bar of score.tracks[0].staves[0].bars)for(const beat of bar.voices[0].beats){beat.notes=[];beat.isEmpty=true;}
  expect(selectionForBars(score,[0],1,2)).toEqual({kind:'bars',tracks:[0],firstBar:1,lastBar:2});
  expect(selectionForTrack(score,0)).toEqual({kind:'bars',tracks:[0],firstBar:0,lastBar:3});
  expect(resolveSelectionBeats(score,selectionForTrack(score,0))).toHaveLength(16);expect(resolveSelectionNotes(score,selectionForTrack(score,0))).toEqual([]);
  expect(()=>rangeFromBeats(score,target,target,[lane])).toThrow(/empty/i);
});
it('uses written free-time duration and canonicalizes internal end-of-bar endpoints',()=>{
  const score=music();expect(rangeFromBeats(score,{...target,beat:2},{...target,beat:3},[lane]).end).toEqual({bar:1,tick:0});
  score.masterBars[0].isFreeTime=true;score.tracks[0].staves[0].bars[0].voices[0].beats.splice(2);
  expect(()=>validateMusicSelection(score,{kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:1921},lanes:[lane]}})).toThrow(/tick|duration/i);
  for(const invalid of [
    {kind:'bars',tracks:[0,0],firstBar:0,lastBar:1},
    {kind:'bars',tracks:[0],firstBar:2,lastBar:1},
    {kind:'notes',notes:[]},
    {kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:0},lanes:[lane]}},
    {kind:'bars',tracks:[0],firstBar:0,lastBar:0,extra:true},
  ])expect(()=>validateMusicSelection(score,invalid as MusicSelection)).toThrow();
});
it('does not treat empty carriers as attacks or a bar-end seam as a nonempty range',()=>{
  const score=music(),voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats[0].notes=[];voice.beats[0].isEmpty=true;
  const value:MusicSelection={kind:'range',range:{start:{bar:0,tick:0},end:{bar:0,tick:960},lanes:[lane]}};
  expect(resolveSelectionBeats(score,value).map(beat=>beat.index)).toEqual([1]);
  expect(()=>validateMusicSelection(score,{kind:'range',range:{start:{bar:0,tick:3840},end:{bar:1,tick:0},lanes:[lane]}})).toThrow(/nonempty/i);
});
