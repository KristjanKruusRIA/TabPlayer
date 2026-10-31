import { expect,it } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { applyRangeEdit } from './range-edits';
import type { MusicSelection,RangeCommand } from './range-types';
import { validateParityCommand } from '../parity-commands';
import { validateProject } from '../engine';
import { blankProject } from '../project';

const notes=(...picks:[bar:number,beat:number][]):MusicSelection=>({kind:'notes',notes:picks.map(([bar,beat])=>({target:{...target,bar,beat},noteIndex:0}))});
const match=(selection:MusicSelection)=>({type:'tieSelectionToEarlierPitch',selection}) as unknown as RangeCommand;
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const lane=(score:model.Score)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats);
const refusal=/to tie from/;

it('ties a note of a different fret to the earlier note on its string and takes that fret',()=>{
  const score=music(),beats=lane(score);beats[1].notes[0].fret=9;score.finish(new Settings());
  expect(applyRangeEdit(score,match(notes([0,1])))).toBe(true);
  const [origin,note]=[beats[0].notes[0],beats[1].notes[0]];
  expect([note.fret,note.string,note.isTieDestination,note.tieOrigin,origin.tieDestination]).toEqual([3,6,true,origin,note]);
  expect(note.realValue).toBe(origin.realValue);
});

it('retunes a selected run from the note before it and carries a harmonic across',()=>{
  const score=music(),beats=lane(score);beats[0].notes[0].fret=7;beats[0].notes[0].harmonicType=model.HarmonicType.Natural;beats[0].notes[0].harmonicValue=7;
  beats[1].notes[0].fret=2;beats[2].notes[0].fret=10;score.finish(new Settings());
  applyRangeEdit(score,match(notes([0,1],[0,2])));
  for(const index of [1,2]){const note=beats[index].notes[0];expect([note.fret,note.harmonicType,note.harmonicValue,note.realValue]).toEqual([7,model.HarmonicType.Natural,7,beats[0].notes[0].realValue]);expect(note.tieOrigin).toBe(beats[index-1].notes[0]);}
});

it('behaves like a plain tie when the pitch already matches, and refuses a second identical click',()=>{
  const score=music(),beats=lane(score),plain=music();
  applyRangeEdit(score,match(notes([0,1])));applyRangeEdit(plain,{type:'setSelectionTies',selection:notes([0,1]),tied:true});
  const state=(value:model.Score)=>lane(value).map(beat=>beat.notes.map(note=>[note.fret,note.isTieDestination,note.tieOrigin?.beat.index??-1]));expect(state(score)).toEqual(state(plain));
  const before=json(score);expect(()=>applyRangeEdit(score,match(notes([0,1])))).toThrow('already tied');expect(json(score)).toEqual(before);
  expect(beats[1].notes[0].isTieDestination).toBe(true);
});

it('keeps the refusals of a plain tie and changes nothing when any note is refused',()=>{
  const rest=music();lane(rest)[1].removeNote(lane(rest)[1].notes[0]);lane(rest)[2].notes[0].fret=8;
  const dead=music();lane(dead)[1].notes[0].isDead=true;lane(dead)[2].notes[0].fret=8;
  for(const score of [rest,dead]){const before=json(score);expect(()=>applyRangeEdit(score,match(notes([0,2])))).toThrow(refusal);expect(json(score)).toEqual(before);}
  const mixed=music(),beats=lane(mixed);beats[1].notes[0].fret=9;beats[2].notes[0].string=2;beats[2].notes[0].fret=4;mixed.finish(new Settings());
  const clean=json(mixed);expect(()=>applyRangeEdit(mixed,match(notes([0,1],[0,2])))).toThrow(refusal);expect(json(mixed)).toEqual(clean);
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;expect(()=>applyRangeEdit(drums,match(notes([0,1])))).toThrow('Drum hits cannot be tied.');
});

it('will not retune a note whose own tie into a later note would then disagree',()=>{
  const score=music(),beats=lane(score),later=beats[2].notes[0],note=beats[1].notes[0];
  note.fret=9;later.fret=9;note.tieDestination=later;later.tieOrigin=note;later.isTieDestination=true;score.finish(new Settings());
  const before=json(score);expect(()=>applyRangeEdit(score,match(notes([0,1])))).toThrow('break the tie');expect(json(score)).toEqual(before);
  applyRangeEdit(score,match(notes([0,1],[0,2])));expect([note.fret,later.fret]).toEqual([3,3]);expect(later.tieOrigin).toBe(note);
});

it('survives a GP export and reopen with the retuned fret',()=>{
  const score=music(),beats=lane(score);beats[1].notes[0].fret=9;score.finish(new Settings());applyRangeEdit(score,match(notes([0,1])));
  const reopened=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,new Settings()),new Settings());
  const second=reopened.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0];
  expect([second.isTieDestination,second.fret]).toEqual([true,3]);
});

it('validates the new command envelope for saved projects and live edits',()=>{
  const edit={type:'tieSelectionToEarlierPitch',selection:notes([0,1])};
  expect(()=>validateParityCommand(edit)).not.toThrow();
  expect(validateProject({...blankProject(),edits:[edit]}).edits).toEqual([edit]);
  for(const bad of [{...edit,tied:true},{type:edit.type},{...edit,extra:0}])expect(()=>validateParityCommand(bad)).toThrow();
  expect(()=>applyRangeEdit(music(),{...edit,extra:1} as unknown as RangeCommand)).toThrow();
});
