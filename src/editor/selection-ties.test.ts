import { expect,it } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { applyRangeEdit } from './range-edits';
import type { MusicSelection,RangeCommand } from './range-types';
import { validateParityCommand } from '../parity-commands';
import { validateProject } from '../engine';
import { blankProject } from '../project';

const bars=(firstBar:number,lastBar=firstBar):MusicSelection=>({kind:'bars',tracks:[0],firstBar,lastBar});
const notes=(...picks:[bar:number,beat:number][]):MusicSelection=>({kind:'notes',notes:picks.map(([bar,beat])=>({target:{...target,bar,beat},noteIndex:0}))});
const command=(selection:MusicSelection,tied:boolean)=>({type:'setSelectionTies',selection,tied}) as RangeCommand;
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const lane=(score:model.Score,voice=0)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[voice]?.beats??[]);
const ties=(score:model.Score,voice=0)=>lane(score,voice).map(beat=>beat.notes.map(note=>note.isTieDestination?'T':'-').join('')).join(' ');
const refusal=/to tie from/;
/** Two voices: voice 2 holds half-note chords of two strings in every bar. */
function twoVoices() {
  const score=music();
  for(const bar of score.tracks[0].staves[0].bars){
    const voice=new model.Voice();
    for(let index=0;index<2;index++){const beat=new model.Beat();beat.duration=2;for(const [string,fret] of [[1,5],[2,5]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}voice.addBeat(beat);}
    bar.addVoice(voice);
  }
  score.finish(new Settings());return score;
}
function fiveBars() {
  const score=music(),bar=new model.Bar(),voice=new model.Voice();score.addMasterBar(new model.MasterBar());bar.clef=model.Clef.G2;
  for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);}
  bar.addVoice(voice);score.tracks[0].staves[0].addBar(bar);score.finish(new Settings());return score;
}
function reopen(score:model.Score) {
  return importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,new Settings()),new Settings());
}

it('ties every note of the selected beats across voices from the previous matching note in one edit',()=>{
  const score=twoVoices(),[first,second]=[lane(score),lane(score,1)];
  expect(applyRangeEdit(score,command(bars(1),true))).toBe(true);
  for(const beats of [first,second])for(const [index,beat] of beats.entries())for(const note of beat.notes){
    const inBar1=beat.voice.bar.index===1;
    expect(note.isTieDestination).toBe(inBar1);
    if(inBar1)expect(note.tieOrigin).toBe(beats[index-1].notes.find(origin=>origin.string===note.string));
  }
  expect(second[2].notes.map(note=>note.tieOrigin?.beat)).toEqual([second[1],second[1]]);
  // The ties survive a GP export and reopen.
  const reopened=reopen(score);expect([ties(reopened),ties(reopened,1)]).toEqual([ties(score),ties(score,1)]);
  expect(ties(score)).toBe('- - - - T T T T - - - - - - - -');
});

it('ties only the selected notes and untie restores the score',()=>{
  const score=music(),before=json(score),beats=lane(score);
  applyRangeEdit(score,command(notes([0,2]),true));
  expect(beats.map(beat=>beat.notes[0].isTieDestination)).toEqual(beats.map((_,index)=>index===2));
  expect(beats[1].notes[0].tieDestination).toBe(beats[2].notes[0]);
  applyRangeEdit(score,command(notes([0,2]),false));
  expect(json(score)).toEqual(before);
});

it('refuses atomically even when valid ties come before the failing note',()=>{
  const score=twoVoices(),before=json(score);
  expect(()=>applyRangeEdit(score,command(bars(0,1),true))).toThrow(refusal);
  expect(()=>applyRangeEdit(score,command(notes([1,0],[1,1],[0,0]),true))).toThrow(refusal);
  const changed=twoVoices();lane(changed)[6].notes[0].fret=4;changed.finish(new Settings());const clean=json(changed);
  expect(()=>applyRangeEdit(changed,command(notes([1,0],[1,1],[1,2]),true))).toThrow(refusal);
  expect(json(score)).toEqual(before);expect(json(changed)).toEqual(clean);
});

it('ties on the same string and fret only, never across a rest, a dead note or a harmonic change',()=>{
  const moved=music(),beats=lane(moved);beats[1].notes[0].string=5;beats[1].notes[0].fret=8;
  expect(()=>applyRangeEdit(moved,command(notes([0,1]),true))).toThrow(refusal);
  applyRangeEdit(moved,command(notes([0,2]),true));expect(beats[2].notes[0].tieOrigin).toBe(beats[0].notes[0]);
  const rest=music();lane(rest)[1].removeNote(lane(rest)[1].notes[0]);
  expect(()=>applyRangeEdit(rest,command(notes([0,2]),true))).toThrow(refusal);
  const dead=music();lane(dead)[1].notes[0].isDead=true;
  expect(()=>applyRangeEdit(dead,command(notes([0,2]),true))).toThrow(refusal);
  const harmonic=music(),[a,b]=lane(harmonic);a.notes[0].fret=7;a.notes[0].harmonicType=model.HarmonicType.Natural;a.notes[0].harmonicValue=7;b.notes[0].fret=19;
  harmonic.finish(new Settings());expect(a.notes[0].realValue).toBe(b.notes[0].realValue);expect(()=>applyRangeEdit(harmonic,command(notes([0,1]),true))).toThrow(refusal);
  const both=music(),[c,d]=lane(both);for(const [note,fret] of [[c.notes[0],7],[d.notes[0],19]] as const){note.fret=fret;note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=7;}
  both.finish(new Settings());expect(c.notes[0].realValue).toBe(d.notes[0].realValue);expect(()=>applyRangeEdit(both,command(notes([0,1]),true))).toThrow(refusal);
});

it('reaches back at most three bars so GP files reopen the tie',()=>{
  const far=fiveBars(),farBeats=lane(far);for(const beat of farBeats.slice(1,16))beat.notes[0].string=4;
  expect(()=>applyRangeEdit(far,command(notes([4,0]),true))).toThrow(refusal);
  const near=fiveBars(),nearBeats=lane(near);for(const beat of nearBeats.slice(5,16))beat.notes[0].string=4;
  applyRangeEdit(near,command(notes([4,0]),true));expect(nearBeats[16].notes[0].tieOrigin).toBe(nearBeats[4].notes[0]);
  expect(ties(reopen(near))).toBe(ties(near));
});

it('refuses drum hits and leaves dead notes in a selection untouched',()=>{
  const drums=music();drums.tracks[0].staves[0].isPercussion=true;const before=json(drums);
  expect(()=>applyRangeEdit(drums,command(bars(1),true))).toThrow('Drum hits cannot be tied.');expect(json(drums)).toEqual(before);
  const score=music(),beats=lane(score);beats[5].notes[0].isDead=true;
  expect(()=>applyRangeEdit(score,command(notes([1,0]),true))).not.toThrow();
  expect(()=>applyRangeEdit(score,command(notes([1,1]),true))).toThrow('Select notes to tie.');
  expect(beats[5].notes[0].isTieDestination).toBe(false);
});

it('re-ties a note whose tie spans a newer note, and never cuts a tie it was not asked to make',()=>{
  const score=music(),beats=lane(score),[from,to]=[beats[0].notes[0],beats[2].notes[0]];
  from.tieDestination=to;to.tieOrigin=from;to.isTieDestination=true;
  applyRangeEdit(score,command(notes([0,1],[0,2]),true));
  expect([beats[1].notes[0].tieOrigin,beats[2].notes[0].tieOrigin,from.tieDestination]).toEqual([from,beats[1].notes[0],beats[1].notes[0]]);
  const other=music(),otherBeats=lane(other),[start,end]=[otherBeats[0].notes[0],otherBeats[2].notes[0]];
  start.tieDestination=end;end.tieOrigin=start;end.isTieDestination=true;const clean=json(other);
  expect(()=>applyRangeEdit(other,command(notes([0,1]),true))).toThrow('cut an existing tie');
  expect(json(other)).toEqual(clean);
});

it('untie removes only ties into selected notes and refuses edits that change nothing',()=>{
  const score=twoVoices();
  applyRangeEdit(score,command(bars(1,2),true));
  expect(()=>applyRangeEdit(score,command(bars(1,2),true))).toThrow('already tied');
  applyRangeEdit(score,command(bars(2),false));
  expect(ties(score)).toBe('- - - - T T T T - - - - - - - -');
  expect(lane(score,1).slice(4,6).flatMap(beat=>beat.notes).every(note=>!note.isTieDestination&&!note.tieOrigin)).toBe(true);
  expect(lane(score)[7].notes[0].tieDestination).toBe(null);
  expect(()=>applyRangeEdit(score,command(bars(2),false))).toThrow('None of the selected notes are tied.');
});

it('validates the command envelope for saved projects',()=>{
  const edit={type:'setSelectionTies',selection:bars(1),tied:true};
  expect(()=>validateParityCommand(edit)).not.toThrow();
  expect(validateProject({...blankProject(),edits:[edit]}).edits).toEqual([edit]);
  for(const bad of [{...edit,tied:1},{...edit,tied:null},{...edit,extra:0}])expect(()=>validateParityCommand(bad)).toThrow();
  const {tied:_tied,...missing}=edit;expect(()=>validateParityCommand(missing)).toThrow();
  expect(()=>applyRangeEdit(music(),{...edit,tied:'yes'} as unknown as RangeCommand)).toThrow();
});
