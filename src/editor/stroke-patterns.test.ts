import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { applyRangeEdit } from './range-edits';
import type { MusicSelection,RangeCommand } from './range-types';
import { validateParityCommand } from '../parity-commands';
import { validateProject } from '../engine';
import { blankProject } from '../project';

const bars=(firstBar=0,lastBar=1):MusicSelection=>({kind:'bars',tracks:[0],firstBar,lastBar});
const beats=(score:model.Score,voice=0)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[voice]?.beats??[]);
const strokes=(score:model.Score,voice=0)=>beats(score,voice).map(beat=>beat.pickStroke===model.PickStroke.Down?'D':beat.pickStroke===model.PickStroke.Up?'U':'-').join('');
const command=(selection:MusicSelection,technique:'pick'|'brush'|'arpeggio',pattern:string[])=>({type:'setSelectionStrokes',selection,technique,pattern}) as RangeCommand;
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);

it('alternates pick strokes over the selected beats in time order, continuing across measures',()=>{
  const score=music();
  expect(applyRangeEdit(score,command(bars(0,1),'pick',['down','up']))).toBe(true);
  expect(strokes(score)).toBe('DUDUDUDU--------');
});

it('skips rests without restarting the pattern and repeats longer ordered patterns',()=>{
  const score=music(),rest=beats(score)[1];rest.removeNote(rest.notes[0]);
  applyRangeEdit(score,command(bars(0,0),'pick',['down','down','up']));
  expect(strokes(score)).toBe('D-DU------------');
  applyRangeEdit(score,command(bars(0,3),'pick',['none']));
  expect(strokes(score)).toBe('----------------');
});

it('applies only to beats of selected notes, and leaves pitches, rhythm and other beats untouched',()=>{
  const score=music(),before=json(score);
  applyRangeEdit(score,command({kind:'notes',notes:[{target:{...target,beat:3},noteIndex:0},{target:{...target,bar:1,beat:1},noteIndex:0}]},'pick',['up']));
  expect(strokes(score)).toBe('---U-U----------');
  for(const beat of beats(score))beat.pickStroke=model.PickStroke.None;
  expect(json(score)).toEqual(before);
});

it('patterns audible brushes and arpeggios, keeping a set spread when only the direction flips',()=>{
  const score=music(),first=beats(score)[0];first.brushType=model.BrushType.BrushUp;first.brushDuration=120;
  applyRangeEdit(score,command(bars(0,0),'brush',['down','up','none']));
  // Quarter notes last 960 ticks: brushes default to a quarter of the beat, arpeggios to the whole beat.
  expect(beats(score).slice(0,4).map(beat=>[beat.brushType,beat.brushDuration])).toEqual([[model.BrushType.BrushDown,120],[model.BrushType.BrushUp,240],[model.BrushType.None,0],[model.BrushType.BrushDown,240]]);
  applyRangeEdit(score,command(bars(0,1),'arpeggio',['up']));
  expect(beats(score).slice(0,8).map(beat=>[beat.brushType,beat.brushDuration])).toEqual(Array(8).fill([model.BrushType.ArpeggioUp,960]));
  expect(beats(score).slice(4,8).every(beat=>beat.pickStroke===model.PickStroke.None)).toBe(true);
  const chord=beats(score)[8],second=new model.Note();second.string=5;second.fret=2;chord.addNote(second);
  applyRangeEdit(score,command(bars(2,2),'brush',['down']));
  expect(chord.brushDuration).toBe(120);
});

it('gives tied-only and grace beats no step and clears the technique on them and on rests',()=>{
  const score=music(),all=beats(score);
  all[1].graceType=model.GraceType.BeforeBeat;all[2].notes[0].isTieDestination=true;all[5].removeNote(all[5].notes[0]);
  for(const beat of all)beat.pickStroke=model.PickStroke.Up;
  applyRangeEdit(score,command(bars(0,1),'pick',['down','none']));
  expect(strokes(score)).toBe('D---D--DUUUUUUUU');
  for(const beat of all){beat.brushType=model.BrushType.ArpeggioDown;beat.brushDuration=50;}
  applyRangeEdit(score,command(bars(0,1),'brush',['up']));
  expect(all.slice(0,8).map(beat=>beat.brushType)).toEqual([2,0,0,2,2,0,2,2].map(up=>up?model.BrushType.BrushUp:model.BrushType.None));
  expect(all.slice(0,8).map(beat=>beat.brushDuration)).toEqual([240,0,0,240,240,0,240,240]);
});

it('runs one pattern per lane across tracks and refuses a mixed guitar and drums selection atomically',()=>{
  const score=music(),track=new model.Track(),staff=new model.Staff();staff.stringTuning.tunings=[43,38,33,28];track.addStaff(staff);score.addTrack(track);
  for(let bar=0;bar<4;bar++){const b=new model.Bar(),voice=new model.Voice();for(let index=0;index<2;index++){const beat=new model.Beat();beat.duration=2;const note=new model.Note();note.string=4;note.fret=index;beat.addNote(note);voice.addBeat(beat);}b.addVoice(voice);staff.addBar(b);}
  score.finish(new Settings());
  const bass=()=>score.tracks[1].staves[0].bars.flatMap(bar=>bar.voices[0].beats).map(beat=>beat.pickStroke===model.PickStroke.Down?'D':beat.pickStroke===model.PickStroke.Up?'U':'-').join('');
  applyRangeEdit(score,{...command(bars(0,0),'pick',['down','up','up']),selection:{kind:'bars',tracks:[0,1],firstBar:0,lastBar:0}});
  expect(strokes(score).slice(0,4)).toBe('DUUD');expect(bass()).toBe('DU------');
  score.tracks[1].staves[0].isPercussion=true;const before=json(score);
  expect(()=>applyRangeEdit(score,{...command(bars(0,3),'brush',['down']),selection:{kind:'bars',tracks:[0,1],firstBar:0,lastBar:3}})).toThrow('stringed guitar or bass');
  expect(json(score)).toEqual(before);
});

it('starts each voice lane at the beginning of the pattern',()=>{
  const score=music(),bar=score.tracks[0].staves[0].bars[0],voice=new model.Voice();
  for(let index=0;index<2;index++){const beat=new model.Beat();beat.duration=2;const note=new model.Note();note.string=1;note.fret=5;beat.addNote(note);voice.addBeat(beat);}
  bar.addVoice(voice);
  for(const other of score.tracks[0].staves[0].bars.slice(1)){const empty=new model.Voice(),beat=new model.Beat();beat.duration=1;empty.addBeat(beat);other.addVoice(empty);}
  score.finish(new Settings());
  applyRangeEdit(score,command(bars(0,0),'pick',['down','up','up']));
  expect(strokes(score).slice(0,4)).toBe('DUUD');expect(strokes(score,1)).toBe('DU---');
});

it('refuses percussion or unstrung lanes and invalid patterns without changing the score',()=>{
  const drums=music(),staff=drums.tracks[0].staves[0];staff.isPercussion=true;
  const before=json(drums);
  expect(()=>applyRangeEdit(drums,command(bars(),'pick',['down']))).toThrow('Pick and brush patterns need a stringed guitar or bass staff.');
  expect(json(drums)).toEqual(before);
  const score=music(),clean=json(score);
  for(const pattern of [[],Array(17).fill('down'),['sideways'],[1]])expect(()=>applyRangeEdit(score,command(bars(),'pick',pattern as string[]))).toThrow(/pattern/i);
  expect(()=>applyRangeEdit(score,command(bars(),'strum' as 'pick',['down']))).toThrow(/technique/i);
  expect(()=>applyRangeEdit(score,{...command(bars(),'pick',['down']),extra:1} as unknown as RangeCommand)).toThrow();
  expect(json(score)).toEqual(clean);
});

it('validates the command envelope for saved projects',()=>{
  const edit={type:'setSelectionStrokes',selection:bars(),technique:'pick',pattern:['down','up']};
  expect(()=>validateParityCommand(edit)).not.toThrow();
  expect(validateProject({...blankProject(),edits:[edit]}).edits).toEqual([edit]);
  for(const bad of [{...edit,pattern:[]},{...edit,pattern:Array(17).fill('up')},{...edit,pattern:['left']},{...edit,technique:'slap'},{...edit,extra:0}])expect(()=>validateParityCommand(bad)).toThrow();
  const {pattern:_pattern,...missing}=edit;expect(()=>validateParityCommand(missing)).toThrow();
});
