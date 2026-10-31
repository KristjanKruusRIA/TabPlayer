import {expect,it} from 'vitest';
import fixtures from '../../tests/reference-sync-timing.json';
import type {BackingSettings} from '../edit-types';
import type {BackingTimeline} from './backing-waveform-types';
import type {ReferenceLocation,ReferenceTempoSegment} from './reference-sync-types';
import type {PlaybackPlan} from './types';
import {adjustReferenceSyncBounds,applyReferenceSyncPlan,disableReferenceSync,initializeReferenceSync,moveReferenceEndpoint,referenceSourceMs,referenceSyncTiming,referenceTimingKey} from './reference-sync';

type Pins=Pick<BackingSettings,'offsetMs'|'anchors'|'referenceSync'>;
const locations:ReferenceLocation[]=[{bar:0,occurrence:0,startTick:0,endTick:3840},{bar:1,occurrence:0,startTick:3840,endTick:7680}];
function backing(pins:Pins={offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3000}],referenceSync:{entryAudioMs:1000,exitAudioMs:7000}}):BackingSettings {
  return {...structuredClone(pins),assetId:'a'.repeat(64),mix:{gain:.7,pan:-.25,mute:false,solo:true}};
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}
  return value;
}
function expectSegments(actual:readonly ReferenceTempoSegment[],expected:readonly ReferenceTempoSegment[]) {
  expect(actual).toEqual(expected.map(segment=>({...segment,startSourceMs:expect.closeTo(segment.startSourceMs,7),endSourceMs:expect.closeTo(segment.endSourceMs,7),bpm:expect.closeTo(segment.bpm,7)})));
}
function timeline(route:readonly ReferenceLocation[]=locations,durationTick=route.at(-1)!.endTick):BackingTimeline {
  return {generation:7,durationTick,tempos:[{tick:0,bpm:120}],occurrences:route.map(o=>({...o,meterNumerator:4,meterDenominator:4,startMs:o.startTick*25/48,endMs:o.endTick*25/48}))};
}
function plan(route:readonly ReferenceLocation[]=locations,durationTick=route.at(-1)!.endTick):PlaybackPlan {
  const time=timeline(route,durationTick);
  return {...time,tempos:[...time.tempos],occurrences:time.occurrences.map(o=>({...o,clickTicks:[o.startTick,o.startTick+960]})),ppq:960,durationMs:durationTick*25/48,tracks:[{id:'track',program:24,percussion:false}],
    notes:[{id:'note',trackId:'track',source:{target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1},occurrence:0,startTick:0,endTick:durationTick,key:60,velocity:90,articulation:'picked',legatoFrom:null,pitch:[{tick:0,semitones:0}]}],
    midi:[{type:'controller',trackId:'track',tick:960,channel:0,controller:7,value:100}],performedBeats:[{target:{track:0,staff:0,bar:0,voice:0,beat:0},occurrence:0,startTick:120,endTick:960,leadInTick:0}]};
}

for(const fixture of fixtures.timingCases)it(`literal timing and full-plan projection: ${fixture.name}`,()=>{
  const input=freeze(backing(fixture.backing)),route=freeze(structuredClone(fixture.locations));
  const before=structuredClone({input,route});
  const authored=freeze(plan(route,'durationTick' in fixture?fixture.durationTick:route.at(-1)!.endTick));
  const settings=fixture.operation==='initialize'?initializeReferenceSync(input,timeline(route),fixture.sourceDurationMs!):input;
  const timing=referenceSyncTiming(settings,route,fixture.sourceDurationMs)!;
  expect({...timing,segments:undefined}).toEqual({entryTick:fixture.expected.entryTick,exitTick:fixture.expected.exitTick,entrySourceMs:fixture.expected.entrySourceMs,exitSourceMs:fixture.expected.exitSourceMs,segments:undefined});
  expectSegments(timing.segments,fixture.expected.segments);
  for(const sample of fixture.expected.sourceSamples??[])expect(referenceSourceMs(timing,sample.tick)).toBeCloseTo(sample.sourceMs,7);
  const effective=applyReferenceSyncPlan(authored,settings);
  expect(effective.playbackEndTick).toBe(fixture.expected.exitTick);
  if(fixture.expected.durationMs!==undefined)expect(effective.durationMs).toBeCloseTo(fixture.expected.durationMs,7);
  expect(effective.durationTick).toBe(authored.durationTick);
  expect(effective.occurrences.at(-1)!.endMs).toBeCloseTo(fixture.expected.activeDurationMs,7);
  expect({notes:effective.notes,midi:effective.midi,tracks:effective.tracks,beats:effective.performedBeats}).toEqual({notes:authored.notes,midi:authored.midi,tracks:authored.tracks,beats:authored.performedBeats});
  expect(effective.occurrences.map(o=>o.clickTicks)).toEqual(authored.occurrences.map(o=>o.clickTicks));
  expect({input,route}).toEqual(before);
});

for(const fixture of fixtures.invalidCases.filter(f=>f.operation!=='validateLegacySettings'))it(`rejects literal invalid timing: ${fixture.name}`,()=>{
  const input=freeze(backing(fixture.backing)),route=freeze(structuredClone(fixture.locations)),before=structuredClone({input,route});
  expect(()=>referenceSyncTiming(input,route,fixture.sourceDurationMs)).toThrow();
  expect({input,route}).toEqual(before);
});

for(const fixture of fixtures.structuralCases)it(`structural body extent: ${fixture.name}`,()=>{
  const previousInput=freeze(backing(fixture.previousBacking)),input=freeze(backing(fixture.backing)),route=freeze(structuredClone(fixture.locations));
  const before=structuredClone({previousInput,input,route});
  const previous=referenceSyncTiming(previousInput,fixture.previousLocations)!;
  const candidate=adjustReferenceSyncBounds(input,previous,route);
  if('rejectReason' in fixture.expected){expect(candidate.referenceSync!.exitAudioMs).toBe(fixture.expected.candidateExitAudioMs);expect(()=>referenceSyncTiming(candidate,route,fixture.sourceDurationMs)).toThrow();}
  else {
    expect(candidate.referenceSync!.exitAudioMs).toBeCloseTo(fixture.expected.exitAudioMs,7);
    expectSegments(referenceSyncTiming(candidate,route,fixture.sourceDurationMs)!.segments,fixture.expected.segments!);
    for(const sample of fixture.expected.sourceSamples??[])expect(referenceSourceMs(referenceSyncTiming(candidate,route)!,sample.tick)).toBeCloseTo(sample.sourceMs,7);
  }
  expect({previousInput,input,route}).toEqual(before);
});

it('legacy omitted and null bounds retain plan identity and have no reference key',()=>{
  const authored=freeze(plan());
  for(const settings of [null,backing({offsetMs:0,anchors:[]}),backing({offsetMs:0,anchors:[],referenceSync:null})]){
    expect(applyReferenceSyncPlan(authored,settings)).toBe(authored);expect(referenceTimingKey(settings)).toBeNull();
    if(settings)expect(referenceSyncTiming(settings,[])).toBeNull();
  }
});

it('reference plan replaces authored intrasegment tempos and detaches every mutable child',()=>{
  const authored=plan();authored.tempos=[{tick:0,bpm:120},{tick:960,bpm:240},{tick:3840,bpm:30}];
  const before=structuredClone(authored),effective=applyReferenceSyncPlan(freeze(authored),freeze(backing()));
  expect(effective.tempos).toEqual([{tick:0,bpm:120},{tick:3840,bpm:60}]);
  expect(effective.occurrences.map(o=>[o.startMs,o.endMs])).toEqual([[0,2000],[2000,6000]]);
  effective.notes[0].pitch[0].semitones=5;effective.notes[0].source.target.bar=9;effective.midi[0].tick=12;effective.performedBeats![0].target.bar=9;effective.occurrences[0].clickTicks![0]=1;
  expect(authored).toEqual(before);
});

it('activation preserves valid legacy bounds and interiors, absorbing matching endpoint pins',()=>{
  const input=freeze(backing({offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1120},{bar:1,occurrence:0,ratio:0,audioMs:3120},{bar:1,occurrence:0,ratio:1,audioMs:7120}]}));
  const before=structuredClone(input),candidate=initializeReferenceSync(input,freeze(timeline()),8000);
  expect(candidate.referenceSync).toEqual({entryAudioMs:1120,exitAudioMs:7120});
  expect(candidate.anchors).toEqual([{bar:1,occurrence:0,ratio:0,audioMs:3120}]);
  candidate.mix.gain=0;candidate.anchors[0].audioMs=4000;expect(input).toEqual(before);
  const conflict=backing({offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:1,audioMs:9000}]});
  expect(()=>initializeReferenceSync(conflict,timeline(),6000)).toThrow();
});

it('activation and endpoint no-ops preserve precise stored coordinates',()=>{
  const input=freeze(backing({offsetMs:-120,anchors:[],referenceSync:{entryAudioMs:.1,exitAudioMs:1000.1}})),route=[{bar:0,occurrence:0,startTick:0,endTick:1920}];
  expect(initializeReferenceSync(input,timeline(route),2000)).toEqual(input);
  expect(moveReferenceEndpoint(input,'entry',120.1,route,2000)).toEqual(input);
  expect(moveReferenceEndpoint(input,'exit',1120.1,route,2000)).toEqual(input);
  expect(adjustReferenceSyncBounds(input,referenceSyncTiming(input,route)!,route)).toEqual(input);
});

it('disable rebases negative stored anchors and offset together while preserving exact source positions',()=>{
  const input=freeze(backing({offsetMs:-120,anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:-70}],referenceSync:{entryAudioMs:-120,exitAudioMs:880}}));
  const disabled=disableReferenceSync(input);
  expect(disabled).toEqual(backing({offsetMs:-50,anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:0}]}));
  expect(disabled.anchors[0].audioMs-disabled.offsetMs).toBe(50);expect(input.anchors[0].audioMs).toBe(-70);
  expect(disableReferenceSync(backing({offsetMs:-120,anchors:[],referenceSync:{entryAudioMs:-120,exitAudioMs:880}}))).toEqual(backing({offsetMs:-120,anchors:[]}));
});

it('endpoint edits enforce physical EOF and strict interior ordering without mutating settings',()=>{
  const input=freeze(backing()),before=structuredClone(input);
  expect(moveReferenceEndpoint(input,'entry',0,locations,8000).referenceSync).toEqual({entryAudioMs:0,exitAudioMs:7000});
  expect(moveReferenceEndpoint(input,'exit',8000,locations,8000).referenceSync).toEqual({entryAudioMs:1000,exitAudioMs:8000});
  for(const source of [NaN,Infinity,-1,3000,8001])expect(()=>moveReferenceEndpoint(input,'entry',source,locations,8000)).toThrow();
  for(const source of [0,3000,8001])expect(()=>moveReferenceEndpoint(input,'exit',source,locations,8000)).toThrow();
  const signed=backing({offsetMs:-120,anchors:[],referenceSync:{entryAudioMs:-120,exitAudioMs:1880}});
  expect(moveReferenceEndpoint(signed,'entry',50,locations,2000).referenceSync!.entryAudioMs).toBe(-70);
  expect(input).toEqual(before);
});

it('timing identity normalizes field order and anchor order while excluding mix',()=>{
  const input=backing(),key=referenceTimingKey(input);
  expect(key).toBe(referenceTimingKey({...input,mix:{gain:1,pan:1,mute:true,solo:false}}));
  for(const changed of [{...input,assetId:'b'.repeat(64)},{...input,offsetMs:1},{...input,anchors:[]},{...input,referenceSync:{entryAudioMs:1000,exitAudioMs:8000}}])expect(referenceTimingKey(changed)).not.toBe(key);
  const anchors=[{bar:0,occurrence:0,ratio:.25,audioMs:1500},{bar:1,occurrence:0,ratio:.25,audioMs:4000}];
  expect(referenceTimingKey({...input,anchors})).toBe(referenceTimingKey({...input,anchors:[...anchors].reverse()}));
});

it('physical subtraction governs distinctness and BPM at very large offsets',()=>{
  for(const pins of [backing({offsetMs:-1e308,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs:1}}),backing({offsetMs:-1e16,anchors:[{bar:0,occurrence:0,ratio:.25,audioMs:3},{bar:0,occurrence:0,ratio:.5,audioMs:4}],referenceSync:{entryAudioMs:0,exitAudioMs:100}})])expect(()=>referenceSyncTiming(pins,locations)).toThrow();
  const timing=referenceSyncTiming(backing({offsetMs:-1e16,anchors:[],referenceSync:{entryAudioMs:1,exitAudioMs:3}}),[{bar:0,occurrence:0,startTick:0,endTick:3840}])!;
  expect(timing.exitSourceMs-timing.entrySourceMs).toBe(4);expect(timing.segments[0].bpm).toBe(60000);
});

it('rejects nonfinite values, malformed routes, unusable rates and full-plan overflow',()=>{
  const input=backing();
  for(const value of [NaN,Infinity,-Infinity]){
    expect(()=>referenceSyncTiming({...input,offsetMs:value},locations)).toThrow();expect(()=>referenceSyncTiming(input,locations,value)).toThrow();
    expect(()=>referenceSourceMs(referenceSyncTiming(input,locations)!,value)).toThrow();
  }
  for(const route of [[{bar:0,occurrence:1,startTick:0,endTick:3840}],[{bar:0,occurrence:0,startTick:0,endTick:3840},{bar:1,occurrence:0,startTick:3000,endTick:7680}],[{bar:0,occurrence:0,startTick:-1,endTick:3840}],[{bar:0,occurrence:0,startTick:0,endTick:Infinity}]])expect(()=>referenceSyncTiming(input,route)).toThrow();
  expect(()=>referenceSyncTiming(backing({offsetMs:0,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs:Number.MAX_VALUE}}),[{bar:0,occurrence:0,startTick:0,endTick:Number.MIN_VALUE}])).toThrow();
  const overflow=plan([{bar:0,occurrence:0,startTick:0,endTick:1}],Number.MAX_VALUE);
  expect(()=>applyReferenceSyncPlan(overflow,backing({offsetMs:0,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs:1000}}))).toThrow();
  expect(()=>applyReferenceSyncPlan({...plan(),durationTick:1000},input)).toThrow();
});

it('rejects a finite derived BPM whose canonical playback rate or reciprocal is unusable',()=>{
  const route=[{bar:0,occurrence:0,startTick:0,endTick:1}];
  for(const exitAudioMs of [1e-304,1e-310])expect(()=>referenceSyncTiming(backing({offsetMs:0,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs}}),route)).toThrow();
});

it('rejects a later positive span that collapses in accumulated preroll milliseconds',()=>{
  const route=[{bar:0,occurrence:0,startTick:1e10,endTick:1e10+20}];
  const input=freeze(backing({offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:.5,audioMs:1e10}],referenceSync:{entryAudioMs:0,exitAudioMs:1e10+1}}));
  expect(()=>referenceSyncTiming(input,route)).toThrow();
});

it('disable rejects a lossy large-offset rebase but permits insignificant fractional roundoff',()=>{
  const input=freeze(backing({offsetMs:-1e16,anchors:[{bar:0,occurrence:0,ratio:.25,audioMs:-1},{bar:0,occurrence:0,ratio:.5,audioMs:2}],referenceSync:{entryAudioMs:-4,exitAudioMs:8}}));
  expect(()=>disableReferenceSync(input)).toThrow();
  const fractional=backing({offsetMs:-120,anchors:[{bar:0,occurrence:0,ratio:.25,audioMs:-.1},{bar:0,occurrence:0,ratio:.5,audioMs:.1}],referenceSync:{entryAudioMs:-120,exitAudioMs:880}});
  const disabled=disableReferenceSync(freeze(fractional));
  expect(disabled.offsetMs).toBe(-119.9);expect(disabled.anchors.map(a=>a.audioMs)).toEqual([0,.2]);
  expect(disabled.anchors[1].audioMs-disabled.offsetMs).toBeCloseTo(120.1,7);
});

it('structural growth rejects physical exit cancellation instead of changing the old prefix',()=>{
  const input=freeze(backing({offsetMs:-1e16,anchors:[],referenceSync:{entryAudioMs:0,exitAudioMs:4}})),oldRoute=[{bar:0,occurrence:0,startTick:0,endTick:4}];
  const previous=referenceSyncTiming(input,oldRoute)!;expect(previous.segments[0].bpm).toBe(62.5);
  expect(()=>adjustReferenceSyncBounds(input,previous,[{bar:0,occurrence:0,startTick:0,endTick:5}])).toThrow();
  expect(input.referenceSync!.exitAudioMs).toBe(4);
});

it('rejects a short occurrence that collapses between otherwise representable pin times',()=>{
  const route=[{bar:0,occurrence:0,startTick:1e10,endTick:1e10+10},{bar:1,occurrence:0,startTick:1e10+10,endTick:1e10+11},{bar:2,occurrence:0,startTick:1e10+11,endTick:1e10+20}];
  const input=freeze(backing({offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:1e10}],referenceSync:{entryAudioMs:0,exitAudioMs:1e10+4096}}));
  expect(()=>referenceSyncTiming(input,route)).toThrow();
  expect(()=>applyReferenceSyncPlan(freeze(plan(route)),input)).toThrow();
});

it('endpoint edits reject an unrepresentable physical source request',()=>{
  const input=freeze(backing({offsetMs:1e16,anchors:[],referenceSync:{entryAudioMs:1e16,exitAudioMs:1e16+10}}));
  expect(()=>moveReferenceEndpoint(input,'entry',1,locations,10)).toThrow();
  expect(moveReferenceEndpoint(input,'entry',2,locations,10).referenceSync!.entryAudioMs).toBe(1e16+2);
});

it('projects a finite source interval even when its milliseconds-per-tick quotient overflows',()=>{
  const route=[{bar:0,occurrence:0,startTick:0,endTick:1},{bar:1,occurrence:0,startTick:1,endTick:1.1}];
  const input=freeze(backing({offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:1}],referenceSync:{entryAudioMs:0,exitAudioMs:1e308}}));
  const timing=referenceSyncTiming(input,route)!;
  expect(referenceSourceMs(timing,1.05)).toBe(5e307);
});

it('structural growth validates its physical delta before adding it to a huge source extent',()=>{
  const oldRoute=[{bar:0,occurrence:0,startTick:0,endTick:1},{bar:1,occurrence:0,startTick:1,endTick:5}];
  const input=freeze(backing({offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:1e16}],referenceSync:{entryAudioMs:0,exitAudioMs:1e16+2}}));
  const previous=referenceSyncTiming(input,oldRoute)!;expect(previous.segments[1].bpm).toBe(125);
  expect(()=>adjustReferenceSyncBounds(input,previous,[oldRoute[0],{...oldRoute[1],endTick:6}])).toThrow();
});
