// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from '../audio/plan';
import { focusNotes, type FocusInput, type ScheduledNotes } from './focus';
import { LiveInstrumentView } from './LiveInstrumentView';
import { trackIdentity } from '../engine';

afterEach(cleanup);
type BarSpec = { frets?: number[]; simile?: boolean; repeat?: boolean; grace?: number };
/** Quarter notes on the low E string, one bar per spec: frets 0-3, then 5-8 by default. */
function music(specs: BarSpec[] = [{frets:[0,1,2,3]},{frets:[5,6,7,8]}]) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name='Guitar';track.playbackInfo.program=25;
  staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(const spec of specs){
    const master=new model.MasterBar();if(spec.repeat){master.isRepeatStart=true;master.repeatCount=2;}score.addMasterBar(master);
    const value=new model.Bar(),voice=new model.Voice();
    if(spec.simile){value.simileMark=model.SimileMark.Simple;const beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);}
    else spec.frets!.forEach((fret,index)=>{
      if(index===1&&spec.grace!==undefined){const grace=new model.Beat();grace.graceType=model.GraceType.BeforeBeat;grace.duration=model.Duration.ThirtySecond;const note=new model.Note();note.string=1;note.fret=spec.grace;grace.addNote(note);voice.addBeat(grace);}
      const item=new model.Beat();item.duration=model.Duration.Quarter;const note=new model.Note();note.string=1;note.fret=fret;item.addNote(note);voice.addBeat(item);
    });
    value.addVoice(voice);staff.addBar(value);
  }
  score.finish(new Settings());const plan=buildPlaybackPlan(score,1);return {score,plan};
}
const at=(bar:number,beat:number)=>({track:0,staff:0,bar,voice:0,beat});
const frets=(notes:readonly {key:number}[])=>notes.map(note=>note.key-40);
const input=(plan:ReturnType<typeof buildPlaybackPlan>,patch:Partial<FocusInput>={}):FocusInput=>({active:[],notes:plan.notes,beats:plan.performedBeats??[],tick:null,counting:false,loop:null,range:null,target:at(0,0),...patch});

it('picks the notes of the selected beat, the selected bar or the next beat',()=>{
  const {plan}=music();
  expect(frets(focusNotes('beat',input(plan,{target:at(0,1)})))).toEqual([1]);
  expect(frets(focusNotes('bar',input(plan,{target:at(1,0)})))).toEqual([5,6,7,8]);
  // Stopped, the next beat follows the selected one; playing or paused, it follows the playback position.
  expect(frets(focusNotes('next',input(plan,{target:at(0,1)})))).toEqual([2]);
  expect(frets(focusNotes('next',input(plan,{target:at(0,1),tick:3000})))).toEqual([5]);
  expect(frets(focusNotes('next',input(plan,{target:at(0,1),tick:3840})))).toEqual([6]);
  expect(focusNotes('next',input(plan,{target:at(1,3)}))).toEqual([]);
  expect(focusNotes('playing',input(plan,{active:plan.notes.slice(0,1),target:at(1,0)}))).toEqual(plan.notes.slice(0,1));
});

it('follows the count-in, the loop and the playback range',()=>{
  const {plan}=music();
  // The count-in leads to the notes at the playback position.
  expect(frets(focusNotes('next',input(plan,{tick:3840,counting:true})))).toEqual([5]);
  // Near the end of a loop the next beat is the loop's first one.
  expect(frets(focusNotes('next',input(plan,{tick:3000,loop:{startTick:960,endTick:3840}})))).toEqual([1]);
  expect(frets(focusNotes('next',input(plan,{tick:1000,loop:{startTick:960,endTick:3840}})))).toEqual([2]);
  // A range ends where it ends.
  expect(focusNotes('next',input(plan,{tick:3000,range:{startTick:0,endTick:3840}}))).toEqual([]);
});

it('shows the first pass of repeats, repeat-bar notes in their own bar, and skips grace notes of the selected beat',()=>{
  const repeated=music([{frets:[0,1,2,3],repeat:true},{frets:[5,6,7,8]}]).plan;
  expect(frets(focusNotes('bar',input(repeated,{target:at(0,0)})))).toEqual([0,1,2,3]);
  expect(focusNotes('bar',input(repeated,{target:at(0,0)})).every(note=>note.occurrence===0)).toBe(true);
  const simile=music([{frets:[0,1,2,3]},{simile:true}]).plan;
  expect(frets(focusNotes('bar',input(simile,{target:at(0,0)})))).toEqual([0,1,2,3]);
  expect(new Set(focusNotes('bar',input(simile,{target:at(0,0)})).map(note=>note.startTick)).size).toBe(4);
  expect(frets(focusNotes('bar',input(simile,{target:at(1,0)})))).toEqual([0,1,2,3]);
  expect(focusNotes('bar',input(simile,{target:at(1,0)})).every(note=>note.startTick>=3840)).toBe(true);
  // A grace note before beat 2 sounds before it: the next beat after beat 2 is beat 3, not beat 2 itself.
  const grace=music([{frets:[0,1,2,3],grace:9}]).plan;
  expect(frets(focusNotes('next',input(grace,{target:at(0,2)})))).toEqual([2]);
  expect(frets(focusNotes('next',input(grace,{target:at(0,0)})))).toEqual([9]);
});

const state={ready:true,error:null},idle:Pick<ScheduledNotes,'tick'|'counting'|'loop'|'range'>={tick:null,counting:false,loop:null,range:null};
it('lets the live view show the selected beat, bar or next beat while stopped',()=>{
  const {score,plan}=music(),id=trackIdentity(score.tracks[0]),scheduled={...idle,notes:plan.notes,beats:plan.performedBeats??[]};
  const player={subscribe:()=>()=>{},getState:()=>state,activeNotes:()=>[],scheduledNotes:(track:string)=>track===id?scheduled:{...idle,notes:[],beats:[]}};
  render(<LiveInstrumentView score={score} track={0} staff={0} target={at(0,1)} player={player as never}/>);
  const show=screen.getByRole('combobox',{name:'Show'});
  expect(screen.getByRole('group',{name:'Sounding notes'})).toHaveTextContent('No notes sounding');
  fireEvent.change(show,{target:{value:'beat'}});
  expect(screen.getByRole('group',{name:'Notes in the selected beat'})).toHaveTextContent('F2');
  fireEvent.change(show,{target:{value:'bar'}});
  expect(screen.getByRole('group',{name:'Notes in the selected bar'})).toHaveTextContent('E2F2F#2G2');
  fireEvent.change(show,{target:{value:'next'}});
  expect(screen.getByRole('group',{name:'Notes in the next beat'})).toHaveTextContent('F#2');
  expect(document.querySelectorAll('g[data-note-id]')).toHaveLength(1);
});

it('says when playback is not ready or has failed, and keeps older players working',()=>{
  const {score}=music(),notReady={ready:false,error:null},failed={ready:true,error:'Device lost'};
  for(const [current,text] of [[notReady,'Playback is not ready yet'],[failed,'Playback is unavailable']] as const){
    const player={subscribe:()=>()=>{},getState:()=>current,activeNotes:()=>[],scheduledNotes:()=>({...idle,notes:[],beats:[]})};
    render(<LiveInstrumentView score={score} track={0} staff={0} target={at(0,0)} player={player as never}/>);
    fireEvent.change(screen.getByRole('combobox',{name:'Show'}),{target:{value:'bar'}});
    expect(screen.getByRole('group',{name:'Notes in the selected bar'})).toHaveTextContent(text);
    cleanup();
  }
  render(<LiveInstrumentView score={score} track={0} staff={0} player={{subscribe:()=>()=>{},getState:()=>state,activeNotes:()=>[]} as never}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Show'}),{target:{value:'next'}});
  expect(screen.getByRole('group',{name:'Notes in the next beat'})).toHaveTextContent('Playback is not ready yet');
});
