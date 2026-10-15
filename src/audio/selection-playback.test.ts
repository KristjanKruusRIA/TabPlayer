import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { MusicSelection,VoiceAddress } from '../editor/range-types';
import { validateMusicSelection } from '../editor/range-selection';
import type { PlaybackPlan } from './types';
import { cursorPlaybackChoices,selectionPlaybackChoices,requireCursorChoice,requirePassageChoice } from './selection-playback';

const target:BeatTarget={track:0,staff:0,bar:0,voice:0,beat:0},lane:VoiceAddress={track:0,staff:0,voice:0};
// Literal performed timelines deliberately do not call the mapping builder or MIDI generator.
function fixture(route=[0,1,0,2],voices=1) {
  const score=new model.Score();for(let i=0;i<=Math.max(...route);i++)score.addMasterBar(new model.MasterBar());
  const track=new model.Track(),staff=new model.Staff();track.addStaff(staff);score.addTrack(track);
  for(const _ of score.masterBars){const bar=new model.Bar();staff.addBar(bar);for(let v=0;v<voices;v++){const voice=new model.Voice();bar.addVoice(voice);for(let i=0;i<4;i++){const beat=new model.Beat(),note=new model.Note();beat.duration=model.Duration.Quarter;beat.isEmpty=false;note.octave=4;note.tone=0;beat.addNote(note);voice.addBeat(beat);}}}
  score.finish(new Settings());
  const counts=new Map<number,number>();
  const occurrences=route.map((bar,index)=>{const occurrence=counts.get(bar)??0;counts.set(bar,occurrence+1);return {bar,occurrence,meterNumerator:4,meterDenominator:4,startTick:index*3840,endTick:(index+1)*3840,startMs:index*2000,endMs:(index+1)*2000};});
  const plan:PlaybackPlan={generation:7,ppq:960,durationTick:route.length*3840,durationMs:route.length*2000,tracks:[{id:'track',program:0,percussion:false}],tempos:[{tick:0,bpm:120}],occurrences,notes:[],midi:[],performedBeats:occurrences.flatMap(o=>Array.from({length:4},(_,beat)=>({target:{...target,bar:o.bar,beat},occurrence:o.occurrence,startTick:o.startTick+beat*960,endTick:o.startTick+(beat+1)*960,leadInTick:o.startTick+beat*960})))};
  return {score,plan};
}
const range=(startBar:number,startTick:number,endBar:number,endTick:number,lanes=[lane]):MusicSelection=>({kind:'range',range:{start:{bar:startBar,tick:startTick},end:{bar:endBar,tick:endTick},lanes}});
const notes=(...targets:BeatTarget[]):MusicSelection=>({kind:'notes',notes:targets.map(target=>({target,noteIndex:0}))});

it('cursor_and_passages_use_performed_occurrences',()=>{
  const {score,plan}=fixture(undefined,2);plan.performedBeats![4].leadInTick=3720;
  expect(cursorPlaybackChoices(score,plan,{...target,bar:1})).toEqual([{generation:7,occurrenceIndex:1,startTick:3720}]);
  const choices=cursorPlaybackChoices(score,plan,target);expect(choices).toEqual([{generation:7,occurrenceIndex:0,startTick:0},{generation:7,occurrenceIndex:2,startTick:7680}]);
  expect(()=>cursorPlaybackChoices(score,plan,{...target,voice:1})).toThrow('This score position has no performed playback location.');
  expect(requireCursorChoice(choices,{...choices[1]})).toEqual(choices[1]);expect(requireCursorChoice(choices,choices[0])).not.toBe(choices[0]);
  for(const invalid of [{...choices[0],generation:6},{...choices[0],startTick:1},{...choices[0],occurrenceIndex:1},{...choices[0],extra:0},{...choices[0],startTick:NaN}])expect(()=>requireCursorChoice(choices,invalid)).toThrow();
  const passages=selectionPlaybackChoices(score,plan,notes(target));expect(passages).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:960},{generation:7,startOccurrence:2,endOccurrence:2,startTick:7680,endTick:8640}]);
  expect(requirePassageChoice(passages,passages[0])).not.toBe(passages[0]);
  for(const key of ['generation','startOccurrence','endOccurrence','startTick','endTick'] as const)expect(()=>requirePassageChoice(passages,{...passages[0],[key]:passages[0][key]+1})).toThrow();
  const snapshot=JSON.stringify(plan);choices[0].startTick=99;passages[0].endTick=99;expect(JSON.stringify(plan)).toBe(snapshot);
});
it('missing_map_is_unavailable_empty_map_is_unperformed_and_canonical_addresses_are_validated',()=>{
  const {score,plan}=fixture([0]);const old={...plan};delete old.performedBeats;
  expect(()=>cursorPlaybackChoices(score,old,target)).toThrow('Selected playback is unavailable for this prepared score.');
  expect(()=>selectionPlaybackChoices(score,old,notes(target))).toThrow('Selected playback is unavailable for this prepared score.');
  expect(()=>cursorPlaybackChoices(score,{...plan,performedBeats:[]},target)).toThrow('This score position has no performed playback location.');
  for(const invalid of [{...target,beat:99},{...target,extra:0},{...target,bar:-1},{...target,voice:.5}])expect(()=>cursorPlaybackChoices(score,plan,invalid)).toThrow();
  for(const invalid of [null,[{...plan.performedBeats![0],target:{...target,beat:99}}]])expect(()=>cursorPlaybackChoices(score,{...plan,performedBeats:invalid} as unknown as PlaybackPlan,target)).toThrow();
  const zero={...plan,performedBeats:[{...plan.performedBeats![0],startTick:0,endTick:0}]};expect(cursorPlaybackChoices(score,zero,target)).toEqual([{generation:7,occurrenceIndex:0,startTick:0}]);expect(()=>selectionPlaybackChoices(score,zero,notes(target))).toThrow();
});
it('complete_route_coverage_is_required',()=>{
  const {score,plan}=fixture();
  const expected=[{generation:7,startOccurrence:0,endOccurrence:3,startTick:0,endTick:15360}];
  expect(selectionPlaybackChoices(score,plan,{kind:'bars',tracks:[0],firstBar:0,lastBar:2})).toEqual(expected);
  expect(selectionPlaybackChoices(score,plan,range(0,0,2,3840))).toEqual(expected);
  expect(selectionPlaybackChoices(score,plan,notes(target,{...target,bar:2}))).toEqual([{generation:7,startOccurrence:0,endOccurrence:3,startTick:0,endTick:12480},{generation:7,startOccurrence:2,endOccurrence:3,startTick:7680,endTick:12480}]);
  const dc=fixture([0,1,2,3,0,1]);expect(selectionPlaybackChoices(dc.score,dc.plan,{kind:'bars',tracks:[0],firstBar:0,lastBar:1})).toEqual([{generation:7,startOccurrence:0,endOccurrence:1,startTick:0,endTick:7680},{generation:7,startOccurrence:4,endOccurrence:5,startTick:15360,endTick:23040}]);
  // An explicit selected beat absent on the second pass cannot be replaced by another beat in its bar.
  plan.performedBeats=plan.performedBeats!.filter(row=>!(row.target.bar===0&&row.occurrence===1&&row.target.beat===1));
  expect(selectionPlaybackChoices(score,plan,notes({...target,beat:1},{...target,bar:2}))).toEqual([{generation:7,startOccurrence:0,endOccurrence:3,startTick:960,endTick:12480}]);
});
it('exclusive_next_bar_zero_endpoint_works_when_next_ending_is_skipped',()=>{
  const {score,plan}=fixture();expect(selectionPlaybackChoices(score,plan,range(0,0,1,0))).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:3840},{generation:7,startOccurrence:2,endOccurrence:2,startTick:7680,endTick:11520}]);
  expect(selectionPlaybackChoices(score,plan,range(0,0,2,0))).toEqual([{generation:7,startOccurrence:0,endOccurrence:1,startTick:0,endTick:7680}]);
});
it('beat_body_interiors_grace_and_silent_tail_have_explicit_policy',()=>{
  const {score,plan}=fixture([0]);const first=plan.performedBeats![0];first.startTick=120;first.leadInTick=0;
  expect(selectionPlaybackChoices(score,plan,range(0,480,0,960))).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:540,endTick:960}]);
  expect(selectionPlaybackChoices(score,plan,range(0,0,0,480))[0]).toEqual({generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:540});
  // BeforeBeat on a later measure: body starts at3840, mapped grace at3720.
  const before=fixture([0,1]);before.plan.performedBeats![4].leadInTick=3720;
  expect(selectionPlaybackChoices(before.score,before.plan,range(1,0,1,480))[0]).toEqual({generation:7,startOccurrence:1,endOccurrence:1,startTick:3720,endTick:4320});
  expect(selectionPlaybackChoices(before.score,before.plan,range(1,480,1,960))[0].startTick).toBe(4320);
  score.masterBars[0].isFreeTime=true;score.tracks[0].staves[0].bars[0].voices[0].beats.splice(2);plan.performedBeats!.splice(2);
  const tail=range(0,1920,0,3360);expect(()=>validateMusicSelection(score,tail)).toThrow(/duration/);
  expect(selectionPlaybackChoices(score,plan,tail)).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:1920,endTick:3360}]);
});
it('ranges_reject_invalid_shapes_lanes_and_nonpositive_written_intervals_without_mutation',()=>{
  const {score,plan}=fixture([0,1]),valid=range(0,0,0,960) as Extract<MusicSelection,{kind:'range'}>;
  const invalid:unknown[]=[{...valid,extra:1},{...valid,range:{...valid.range,extra:1}},range(0,0,0,0),range(0,960,0,0),range(0,3840,1,0),range(0,0,0,3841),range(0,.5,0,960),range(0,0,0,960,[lane,lane]),range(0,0,0,960,[{...lane,voice:3}]),range(0,0,0,960,[{...lane,voice:0x100000000}]),range(0,0,0,960,[{...lane,extra:1} as VoiceAddress]),{...valid,range:{...valid.range,start:{bar:0,tick:0,extra:0}}}];
  const before=JSON.stringify(plan);for(const selection of invalid)expect(()=>selectionPlaybackChoices(score,plan,selection as MusicSelection)).toThrow();expect(JSON.stringify(plan)).toBe(before);
});
it('explicit_grace_selects_its_raw_interval_and_principal_includes_attached_lead_in',()=>{
  const {score,plan}=fixture([0]),voice=score.tracks[0].staves[0].bars[0].voices[0];
  const grace=new model.Beat(),note=new model.Note();grace.graceType=model.GraceType.OnBeat;grace.duration=model.Duration.Sixteenth;grace.isEmpty=false;note.octave=4;note.tone=2;grace.addNote(note);grace.voice=voice;voice.beats.unshift(grace);score.finish(new Settings());
  for(const row of plan.performedBeats!)row.target.beat++;
  Object.assign(plan.performedBeats![0],{startTick:120,leadInTick:0});
  plan.performedBeats!.unshift({target:{...target},occurrence:0,startTick:0,endTick:120,leadInTick:0});
  expect(selectionPlaybackChoices(score,plan,notes(target))).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:120}]);
  expect(selectionPlaybackChoices(score,plan,notes({...target,beat:1}))).toEqual([{generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:960}]);
  expect(selectionPlaybackChoices(score,plan,range(0,480,0,960))[0].startTick).toBe(540);
});
it('zero_duration_rows_do_not_create_a_passage_by_spanning_repeated_silence',()=>{
  const {score,plan}=fixture([0,0]);plan.performedBeats=plan.performedBeats!.filter(row=>row.target.beat===0).map(row=>({...row,endTick:row.startTick}));
  expect(cursorPlaybackChoices(score,plan,target)).toHaveLength(2);
  expect(()=>selectionPlaybackChoices(score,plan,notes(target))).toThrow(/no performed playback passage/);
});
it('multiple_lanes_envelope_rests_ties_and_sparse_note_selections_use_complete_time',()=>{
  const {score,plan}=fixture([0],2),voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats[1].notes=[];voice.beats[2].notes[0].isTieDestination=true;
  plan.performedBeats!.push({...plan.performedBeats![0],target:{...target,voice:1},startTick:60,endTick:1200,leadInTick:0});
  expect(selectionPlaybackChoices(score,plan,range(0,0,0,960,[lane,{...lane,voice:1}]))[0]).toEqual({generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:1200});
  expect(selectionPlaybackChoices(score,plan,range(0,960,0,2880))[0]).toEqual({generation:7,startOccurrence:0,endOccurrence:0,startTick:960,endTick:2880});
  expect(selectionPlaybackChoices(score,plan,notes(target,{...target,beat:2}))[0]).toEqual({generation:7,startOccurrence:0,endOccurrence:0,startTick:0,endTick:2880});
});
it('collapsed_simile_has_no_hidden_subdivision_and_keeps_empty_bar_clocks',()=>{
  const {score,plan}=fixture([0,1]);const bar=score.tracks[0].staves[0].bars[1];bar.simileMark=model.SimileMark.Simple;bar.voices[0].beats.splice(1);
  plan.performedBeats=plan.performedBeats!.filter(row=>row.target.bar!==1||row.target.beat===0);Object.assign(plan.performedBeats![4],{startTick:3960,endTick:7680,leadInTick:3960});
  expect(cursorPlaybackChoices(score,plan,{...target,bar:1})).toEqual([{generation:7,occurrenceIndex:1,startTick:3960}]);
  expect(selectionPlaybackChoices(score,plan,range(1,0,1,3840))[0]).toEqual({generation:7,startOccurrence:1,endOccurrence:1,startTick:3960,endTick:7680});
  expect(selectionPlaybackChoices(score,plan,{kind:'bars',tracks:[0],firstBar:1,lastBar:1})[0].startTick).toBe(3840);
  for(const selection of [range(1,0,1,960),range(1,960,1,3840)])expect(()=>selectionPlaybackChoices(score,plan,selection)).toThrow('Select the complete simile measure for playback.');
  const empty=fixture([0],2),b=empty.score.tracks[0].staves[0].bars[0];b.voices[0].beats.splice(1);b.voices[0].beats[0].isEmpty=true;b.voices[0].beats[0].notes=[];empty.plan.performedBeats=[{target,occurrence:0,startTick:0,endTick:3840,leadInTick:0}];
  expect(selectionPlaybackChoices(empty.score,empty.plan,range(0,0,0,1920))[0].endTick).toBe(1920);
  expect(selectionPlaybackChoices(empty.score,empty.plan,range(0,0,0,3840,[{...lane,voice:1}]))[0].endTick).toBe(3840);
});
