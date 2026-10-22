import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { describeScoreError,findScoreErrors,readScoreErrorDisplay,writeScoreErrorDisplay } from './score-errors';

const voice=(score:model.Score,bar:number,index=0)=>score.tracks[0].staves[0].bars[bar].voices[index];
const finish=(score:model.Score)=>{score.finish(new Settings());return score;};
const summary=(score:model.Score)=>findScoreErrors(score).map(error=>[error.bar,error.voice,error.kind,error.ticks]);

it('finds no errors in full bars and in unused voices',()=>{
  const score=music();
  for(const bar of score.tracks[0].staves[0].bars){const empty=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;empty.addBeat(beat);bar.addVoice(empty);}
  finish(score);
  expect(findScoreErrors(score)).toEqual([]);
});

it('reports incomplete and overfull voices with the missing or extra duration, in score order',()=>{
  const score=music();
  voice(score,2).beats[3].duration=model.Duration.Eighth;
  const extra=new model.Beat();extra.duration=model.Duration.Half;const note=new model.Note();note.string=1;note.fret=0;extra.addNote(note);voice(score,1).addBeat(extra);
  voice(score,0).beats.splice(3,1);
  finish(score);
  expect(summary(score)).toEqual([[0,0,'incomplete',960],[1,0,'overfull',1920],[2,0,'incomplete',480]]);
  expect(findScoreErrors(score).map(describeScoreError)).toEqual([
    'Measure 1 · Guitar · Voice 1: 1 quarter note missing',
    'Measure 2 · Guitar · Voice 1: 2 quarter notes too long',
    'Measure 3 · Guitar · Voice 1: 1/2 quarter note missing',
  ]);
});

it('ignores grace notes and a pickup bar, and checks every staff, track and voice',()=>{
  const score=music(),grace=new model.Beat();grace.graceType=model.GraceType.BeforeBeat;grace.duration=model.Duration.Eighth;
  const note=new model.Note();note.string=1;note.fret=2;grace.addNote(note);voice(score,1).addBeat(grace);voice(score,1).beats.unshift(voice(score,1).beats.pop()!);
  score.masterBars[0].isAnacrusis=true;voice(score,0).beats.splice(3,1);
  const second=new model.Voice();for(const duration of [model.Duration.Half,model.Duration.Quarter]){const beat=new model.Beat();beat.duration=duration;second.addBeat(beat);}
  for(const bar of score.tracks[0].staves[0].bars.slice(0,3)){const empty=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;empty.addBeat(beat);bar.addVoice(empty);}
  score.tracks[0].staves[0].bars[3].addVoice(second);
  finish(score);
  expect(summary(score)).toEqual([[3,1,'incomplete',960]]);
  expect(findScoreErrors(score)[0]).toMatchObject({track:0,staff:0,bar:3,voice:1});
});

it('reads and writes the display preference, defaulting to marking errors when storage is unavailable',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  expect(readScoreErrorDisplay(storage)).toBe(true);
  writeScoreErrorDisplay(false,storage);expect(readScoreErrorDisplay(storage)).toBe(false);
  writeScoreErrorDisplay(true,storage);expect(readScoreErrorDisplay(storage)).toBe(true);
  values.set('tabplayer.scoreErrors.mark','garbage');expect(readScoreErrorDisplay(storage)).toBe(true);
  const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
  expect(readScoreErrorDisplay(broken)).toBe(true);expect(()=>writeScoreErrorDisplay(false,broken)).not.toThrow();
  expect(readScoreErrorDisplay(undefined)).toBe(true);
});

const quarterBeat=(fret=0,duration=model.Duration.Quarter)=>{const beat=new model.Beat();beat.duration=duration;const note=new model.Note();note.string=1;note.fret=fret;beat.addNote(note);return beat;};
const graceBeat=(type=model.GraceType.BeforeBeat)=>{const beat=quarterBeat(5,model.Duration.ThirtySecond);beat.graceType=type;return beat;};
const fillVoices=(score:model.Score,count:number)=>{for(const staff of score.tracks.flatMap(track=>track.staves))for(const bar of staff.bars)while(bar.voices.length<count){const empty=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;empty.addBeat(beat);bar.addVoice(empty);}};

it('measures written lengths, so grace notes inside or across full bars never borrow time from them',()=>{
  const score=music();
  const middle=voice(score,0);middle.addBeat(graceBeat(model.GraceType.OnBeat));middle.beats.splice(2,0,middle.beats.pop()!);
  const start=voice(score,1);start.addBeat(graceBeat());start.beats.unshift(start.beats.pop()!);
  finish(score);
  expect(findScoreErrors(score)).toEqual([]);
  start.beats.pop();score.finish(new Settings());
  expect(findScoreErrors(score)).toMatchObject([{bar:1,beat:1,kind:'incomplete',ticks:960}]);
});

it('adds tuplet lengths exactly, skips free-time measures and counts empty filler beats before a late voice',()=>{
  const score=music(),septuplet=voice(score,0);septuplet.beats.splice(0,1);
  for(let index=0;index<7;index++){const beat=quarterBeat(index,model.Duration.Sixteenth);beat.tupletNumerator=7;beat.tupletDenominator=4;septuplet.addBeat(beat);}
  const nine=voice(score,1);nine.beats.splice(0,1);
  for(let index=0;index<9;index++){const beat=quarterBeat(index,model.Duration.ThirtySecond);beat.tupletNumerator=9;beat.tupletDenominator=8;nine.addBeat(beat);}
  voice(score,2).addBeat(quarterBeat());score.masterBars[2].isFreeTime=true;
  fillVoices(score,2);
  const late=voice(score,3,1);late.beats[0].duration=model.Duration.Half;late.addBeat(quarterBeat(2,model.Duration.Half));
  finish(score);
  expect(summary(score)).toEqual([]);
  late.beats[1].duration=model.Duration.Quarter;score.finish(new Settings());
  expect(summary(score)).toEqual([[3,1,'incomplete',960]]);
  expect(findScoreErrors(score)[0].beat).toBe(1);
});

it('names the track and staff of errors in later tracks and staves',()=>{
  const score=music(),piano=new model.Track();piano.name='Piano';
  for(let index=0;index<2;index++){const staff=new model.Staff();staff.isPercussion=false;piano.addStaff(staff);
    for(let bar=0;bar<4;bar++){const value=new model.Bar(),line=new model.Voice();value.clef=index?model.Clef.F4:model.Clef.G2;for(let beat=0;beat<4;beat++)line.addBeat(quarterBeat());value.addVoice(line);staff.addBar(value);}}
  score.addTrack(piano);piano.staves[1].bars[2].voices[0].beats.pop();
  finish(score);
  expect(findScoreErrors(score)).toMatchObject([{track:1,staff:1,bar:2,voice:0,place:'Piano · Staff 2'}]);
  expect(describeScoreError(findScoreErrors(score)[0])).toBe('Measure 3 · Piano · Staff 2 · Voice 1: 1 quarter note missing');
});
