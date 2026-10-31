import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import type { PlaybackPlan } from './types';
import { cursorPlaybackChoices,selectionPlaybackChoices } from './selection-playback';

// Original authored whole-note timeline; it does not call the MIDI/mapping builder.
function fixture(){
  const score=new model.Score(),bars=64,tracks=4;
  for(let bar=0;bar<bars;bar++)score.addMasterBar(new model.MasterBar());
  for(let index=0;index<tracks;index++){
    const track=new model.Track(),staff=new model.Staff();track.addStaff(staff);score.addTrack(track);
    for(let bar=0;bar<bars;bar++){
      const measure=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();
      staff.addBar(measure);measure.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Whole;beat.isEmpty=false;note.octave=4;note.tone=0;beat.addNote(note);
    }
  }
  score.finish(new Settings());
  const occurrences=Array.from({length:128},(_,index)=>({bar:index%64,occurrence:Math.floor(index/64),meterNumerator:4,meterDenominator:4,startTick:index*3840,endTick:(index+1)*3840,startMs:index*2000,endMs:(index+1)*2000}));
  const plan:PlaybackPlan={generation:7,ppq:960,durationTick:491520,durationMs:256000,tracks:Array.from({length:tracks},(_,index)=>({id:`original-${index}`,program:0,percussion:false})),tempos:[{tick:0,bpm:120}],occurrences,notes:[],midi:[],performedBeats:occurrences.flatMap(occurrence=>Array.from({length:tracks},(_,track)=>({target:{track,staff:0,bar:occurrence.bar,voice:0,beat:0},occurrence:occurrence.occurrence,startTick:occurrence.startTick,endTick:occurrence.endTick,leadInTick:occurrence.startTick})))};
  let reads=0;for(const row of plan.performedBeats!){const target=row.target;Object.defineProperty(row,'target',{enumerable:true,configurable:true,get:()=>{reads++;return target;}});}
  return {score,plan,reads:()=>reads};
}
it('cursor lookup visits authored rows a bounded number of times rather than once per occurrence',()=>{
  const {score,plan,reads}=fixture();
  expect(cursorPlaybackChoices(score,plan,{track:0,staff:0,bar:0,voice:0,beat:0})).toEqual([{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:64,startTick:245760}]);
  expect(reads()).toBeLessThan(plan.performedBeats!.length*12);
});
it('passage lookup groups authored rows once per query rather than rescanning every occurrence',()=>{
  const {score,plan,reads}=fixture();
  expect(selectionPlaybackChoices(score,plan,{kind:'bars',tracks:[0],firstBar:0,lastBar:63})).toEqual([{generation:7,startOccurrence:0,endOccurrence:63,startTick:0,endTick:245760},{generation:7,startOccurrence:64,endOccurrence:127,startTick:245760,endTick:491520}]);
  expect(reads()).toBeLessThan(plan.performedBeats!.length*12);
});
it('queries still validate mutable authored plan and score inputs on every invocation',()=>{
  const {score,plan}=fixture(),target={track:0,staff:0,bar:0,voice:0,beat:0},selection={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:63};
  cursorPlaybackChoices(score,plan,target);selectionPlaybackChoices(score,plan,selection);
  plan.performedBeats![0].leadInTick=-1;
  expect(()=>cursorPlaybackChoices(score,plan,target)).toThrow('Invalid native playback plan');expect(()=>selectionPlaybackChoices(score,plan,selection)).toThrow('Invalid native playback plan');
  plan.performedBeats![0].leadInTick=0;score.tracks[0].staves[0].bars[0].voices[0].beats=[];
  expect(()=>cursorPlaybackChoices(score,plan,target)).toThrow('Select an existing beat.');expect(()=>selectionPlaybackChoices(score,plan,selection)).toThrow('Select an existing beat.');
});
