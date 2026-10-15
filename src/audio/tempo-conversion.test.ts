import {expect,it} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import fixtures from '../../tests/reference-sync-timing.json';
import type {BackingSettings} from '../edit-types';
import {applyTempoAutomations} from '../editor/tempo-automations';
import {buildPlaybackPlan} from './plan';
import type {ReferenceLocation,ReferenceSyncTiming} from './reference-sync-types';
import type {PlaybackPlan} from './types';
import {scoreTemposFromSync,syncPointsFromScore} from './tempo-conversion';

const mix={gain:.75,pan:-.25,mute:false,solo:true};
function backing(overrides:Partial<BackingSettings>={}):BackingSettings {
  return {assetId:'committed-source',offsetMs:120,anchors:[],mix:{...mix},referenceSync:{entryAudioMs:1120,exitAudioMs:7120},...overrides};
}
function authored(bars=2,repeat=false) {
  const score=new model.Score();
  const track=new model.Track(),staff=new model.Staff();track.addStaff(staff);score.addTrack(track);staff.stringTuning.tunings=[64,59,55,50,45,40];
  for(let index=0;index<bars;index++) {
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();staff.addBar(bar);bar.addVoice(voice);
    for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);}
  }
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,150,2)];
  if(repeat){score.masterBars[0].isRepeatStart=true;score.masterBars[bars-1].repeatCount=2;}
  score.finish(new Settings());return score;
}
const locations:ReferenceLocation[]=[{bar:0,occurrence:0,startTick:0,endTick:3840},{bar:1,occurrence:0,startTick:3840,endTick:7680}];
function literalPlan():PlaybackPlan {
  return {generation:7,ppq:960,durationTick:7680,durationMs:6000,tracks:[{id:'base/0',program:0,percussion:false}],
    tempos:[{tick:0,bpm:120},{tick:1280,bpm:60},{tick:5760,bpm:180}],
    occurrences:[{...locations[0],meterNumerator:4,meterDenominator:4,startMs:0,endMs:3333.3333333333335},{...locations[1],meterNumerator:4,meterDenominator:4,startMs:3333.3333333333335,endMs:6000}],notes:[],midi:[]};
}
const timing:ReferenceSyncTiming={entryTick:0,exitTick:7680,entrySourceMs:1000,exitSourceMs:7000,segments:[
  {startTick:0,endTick:3840,startSourceMs:1000,endSourceMs:3000,bpm:120},
  {startTick:3840,endTick:7680,startSourceMs:3000,endSourceMs:7000,bpm:60},
]};

it('replaces interiors from the complete authored piecewise clock and applies offset once',()=>{
  const oracle=fixtures.conversionCases.find(value=>value.name==='score-to-sync-authored-fractional-breakpoints')!;
  const plan=literalPlan(),input=backing({referenceSync:{entryAudioMs:1120,exitAudioMs:9120},anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:3000}]}),before=structuredClone({plan,input});
  const next=syncPointsFromScore(plan,input,'replace',16000);
  expect(next.referenceSync!.entryAudioMs).toBe(oracle.expected.storedBounds!.entryAudioMs);
  expect(Math.abs(next.referenceSync!.exitAudioMs-oracle.expected.storedBounds!.exitAudioMs)).toBeLessThanOrEqual(1e-7);
  expect(next.anchors).toHaveLength(2);
  next.anchors.forEach((anchor,index)=>{
    expect(anchor).toMatchObject(index?{bar:1,occurrence:0,ratio:.5}:{bar:0,occurrence:0,ratio:1/3});
    expect(anchor.audioMs).toBeCloseTo(index?6453.333333333333:1786.6666666666667,10);
  });
  expect(next).toMatchObject({assetId:'committed-source',offsetMs:120,mix});expect(next.mix).not.toBe(input.mix);
  expect({plan,input}).toEqual(before);
});

it('add retains exact existing coordinates and identities when generated pins agree within 1e-7 ms',()=>{
  const input=backing({anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:1786.6666667166667},{bar:0,occurrence:0,ratio:.75,audioMs:3500}]}),before=structuredClone(input);
  const next=syncPointsFromScore(literalPlan(),input,'add',16000);
  expect(next.anchors).toEqual([before.anchors[0],before.anchors[1],{bar:1,occurrence:0,ratio:.5,audioMs:expect.closeTo(6453.333333333333,10)}]);
  expect(next.referenceSync).toEqual(before.referenceSync);expect(input).toEqual(before);
  expect(syncPointsFromScore(literalPlan(),next,'add',16000)).toEqual(next);
});

it('rejects add collisions, crossing retained points, endpoint disagreement and actual EOF atomically',()=>{
  const inputs=[
    backing({anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:1787.6666666666667}]}),
    backing({anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:1720}]}),
    backing({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}),
  ];
  for(const input of inputs){const before=structuredClone(input);expect(()=>syncPointsFromScore(literalPlan(),input,'add',16000)).toThrow();expect(input).toEqual(before);}
  const plan=literalPlan(),input=backing(),before=structuredClone({plan,input});
  expect(()=>syncPointsFromScore(plan,input,'replace',6999)).toThrow();expect({plan,input}).toEqual(before);
});

it('assigns generated seams to the receiving occurrence and omits terminal tempo events',()=>{
  const plan:PlaybackPlan={...literalPlan(),durationMs:6000,tempos:[{tick:0,bpm:120},{tick:3840,bpm:60},{tick:7680,bpm:240}],occurrences:[{...literalPlan().occurrences[0],endMs:2000},{...literalPlan().occurrences[1],startMs:2000}]};
  expect(syncPointsFromScore(plan,backing(),'replace',16000).anchors).toEqual([{bar:1,occurrence:0,ratio:0,audioMs:3120}]);
});

it('add resolves previous-exit and receiving-start aliases by performed tick while retaining the old point',()=>{
  const plan:PlaybackPlan={...literalPlan(),durationMs:6000,tempos:[{tick:0,bpm:120},{tick:3840,bpm:60}],occurrences:[{...literalPlan().occurrences[0],endMs:2000},{...literalPlan().occurrences[1],startMs:2000}]};
  const input=backing({anchors:[{bar:0,occurrence:0,ratio:1,audioMs:3120}]});
  expect(syncPointsFromScore(plan,input,'add',16000)).toEqual(input);
});

it('preserves signed stored reference coordinates at physical source zero',()=>{
  const plan:PlaybackPlan={...literalPlan(),durationMs:4000,tempos:[{tick:0,bpm:120}],occurrences:[{...literalPlan().occurrences[0],endMs:2000},{...literalPlan().occurrences[1],startMs:2000,endMs:4000}]};
  const input=backing({offsetMs:-120,referenceSync:{entryAudioMs:-120,exitAudioMs:3880}});
  expect(syncPointsFromScore(plan,input,'replace',6000)).toEqual(input);
});

it('initializes legacy settings through the accepted source-bracket policy before conversion',()=>{
  const plan:PlaybackPlan={...literalPlan(),durationMs:4000,tempos:[{tick:0,bpm:120}],occurrences:[{...literalPlan().occurrences[0],endMs:2000},{...literalPlan().occurrences[1],startMs:2000,endMs:4000}]};
  const input=backing({referenceSync:undefined,offsetMs:0});
  expect(syncPointsFromScore(plan,input,'replace',6000)).toEqual({...input,referenceSync:{entryAudioMs:0,exitAudioMs:4000}});
  expect(input.referenceSync).toBeUndefined();
});

it('uses the shipped generator piecewise values for isLinear flags without expanding a ramp',()=>{
  const score=authored();applyTempoAutomations(score,[{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:1/3,bpm:60,linear:true},{bar:1,ratio:.5,bpm:180,linear:false}]);
  const before=model.JsonConverter.scoreToJson(score),plan=buildPlaybackPlan(score,0);
  expect(plan.tempos).toEqual([{tick:0,bpm:120},{tick:1280,bpm:60},{tick:5760,bpm:180}]);
  const next=syncPointsFromScore(plan,backing(),'replace',16000);
  expect(next.referenceSync!.entryAudioMs).toBe(1120);expect(Math.abs(next.referenceSync!.exitAudioMs-7120)).toBeLessThanOrEqual(1e-7);expect(next.anchors[0].audioMs).toBeCloseTo(1786.6666666666667,10);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('captures authored internal changes on every repeat visit including the receiving backjump seam',()=>{
  const score=authored(1,true);applyTempoAutomations(score,[{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:1/3,bpm:60,linear:false}]);
  const plan=buildPlaybackPlan(score,0),before=model.JsonConverter.scoreToJson(score);
  const next=syncPointsFromScore(plan,backing({referenceSync:{entryAudioMs:1120,exitAudioMs:9120}}),'replace',16000);
  expect(next.anchors.map(anchor=>[anchor.bar,anchor.occurrence,anchor.ratio])).toEqual([[0,0,1/3],[0,1,0],[0,1,1/3]]);
  expect(next.anchors.map(anchor=>anchor.audioMs)).toEqual([expect.closeTo(1786.6666666666667,10),expect.closeTo(4453.333333333333,10),expect.closeTo(5120,10)]);
  expect(next.referenceSync!.exitAudioMs).toBeCloseTo(7786.666666666666,10);expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('writes complete played-bar functions with receiving ratio-zero seams and no exit event',()=>{
  const score=authored(),before=model.JsonConverter.scoreToJson(score),input=structuredClone(timing);
  expect(scoreTemposFromSync(score,timing,locations)).toEqual([{bar:0,ratio:0,bpm:120,linear:false},{bar:1,ratio:0,bpm:60,linear:false}]);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(timing).toEqual(input);
});

it('rejects stale performed locations when regenerated candidate route cannot reproduce them',()=>{
  const score=authored(),before=model.JsonConverter.scoreToJson(score);
  expect(()=>scoreTemposFromSync(score,timing,[{...locations[0],endTick:3841},{...locations[1],startTick:3841}])).toThrow();
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});

it('compares inherited and internal BPM requirements on every repeated pass',()=>{
  const score=authored(1,true),route:ReferenceLocation[]=[{bar:0,occurrence:0,startTick:0,endTick:3840},{bar:0,occurrence:1,startTick:3840,endTick:7680}];
  const cases:ReferenceSyncTiming[]=[
    {...timing,segments:[{...timing.segments[0]},{...timing.segments[1]}]},
    {...timing,exitSourceMs:6333.333333333333,segments:[{startTick:0,endTick:5120,startSourceMs:1000,endSourceMs:3666.6666666666665,bpm:120},{startTick:5120,endTick:7680,startSourceMs:3666.6666666666665,endSourceMs:6333.333333333333,bpm:60}]},
    {...timing,exitSourceMs:4999.999983333333,segments:[{...timing.segments[0]},{startTick:3840,endTick:7680,startSourceMs:3000,endSourceMs:4999.999983333333,bpm:120.000001}]},
  ];
  for(const required of cases){const before=model.JsonConverter.scoreToJson(score);expect(()=>scoreTemposFromSync(score,required,route)).toThrow(/bar 1.*pass|repeated/i);expect(model.JsonConverter.scoreToJson(score)).toBe(before);}
});

it('compatible repeat copies emit one exact written ratio map and verify the actual candidate clock',()=>{
  const score=authored(1,true),route:ReferenceLocation[]=[{bar:0,occurrence:0,startTick:0,endTick:3840},{bar:0,occurrence:1,startTick:3840,endTick:7680}];
  const required:ReferenceSyncTiming={entryTick:0,exitTick:7680,entrySourceMs:1000,exitSourceMs:7666.666666666666,segments:[
    {startTick:0,endTick:1280,startSourceMs:1000,endSourceMs:1666.6666666666667,bpm:120},
    {startTick:1280,endTick:3840,startSourceMs:1666.6666666666667,endSourceMs:4333.333333333333,bpm:60},
    {startTick:3840,endTick:5120,startSourceMs:4333.333333333333,endSourceMs:5000,bpm:120},
    {startTick:5120,endTick:7680,startSourceMs:5000,endSourceMs:7666.666666666666,bpm:60},
  ]};
  expect(scoreTemposFromSync(score,required,route)).toEqual([{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:1/3,bpm:60,linear:false}]);
});

it('compares suppressed arithmetic noise against the last emitted BPM so gradual drift stays representable',()=>{
  const score=authored(1),required:ReferenceSyncTiming={entryTick:0,exitTick:3840,entrySourceMs:1000,exitSourceMs:4999.9999999375,segments:[
    {startTick:0,endTick:960,startSourceMs:1000,endSourceMs:2000,bpm:60},
    {startTick:960,endTick:1920,startSourceMs:2000,endSourceMs:2999.9999999875,bpm:60.00000000075},
    {startTick:1920,endTick:3840,startSourceMs:2999.9999999875,endSourceMs:4999.9999999375,bpm:60.0000000015},
  ]};
  expect(scoreTemposFromSync(score,required,[{bar:0,occurrence:0,startTick:0,endTick:3840}])).toEqual([{bar:0,ratio:0,bpm:60,linear:false},{bar:0,ratio:.5,bpm:60.0000000015,linear:false}]);
});

it('keeps grace outside ratio positions while verifying its inherited timing',()=>{
  const score=authored(1),voice=score.tracks[0].staves[0].bars[0].voices[0],grace=new model.Beat();grace.duration=model.Duration.Eighth;grace.graceType=model.GraceType.BeforeBeat;grace.isEmpty=false;
  const note=new model.Note();note.string=1;note.fret=2;grace.addNote(note);grace.voice=voice;voice.beats.unshift(grace);score.finish(new Settings());
  const before=model.JsonConverter.scoreToJson(score),required:ReferenceSyncTiming={entryTick:120,exitTick:3960,entrySourceMs:1000,exitSourceMs:3000,segments:[{startTick:120,endTick:3960,startSourceMs:1000,endSourceMs:3000,bpm:120}]};
  expect(scoreTemposFromSync(score,required,[{bar:0,occurrence:0,startTick:120,endTick:3960}])).toEqual([{bar:0,ratio:0,bpm:120,linear:false}]);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
