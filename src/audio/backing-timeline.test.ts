import {expect,it} from 'vitest';
import mapping from '../../tests/backing-timeline-mapping.json';
import type {BackingSettings} from '../edit-types';
import type {BackingScoreSelection,BackingTimeline} from './backing-waveform-types';
import {moveBackingAnchor,projectBackingGrid,projectBackingSelection,scoreTickToAudioMs,scoreTimeToAudioMs} from './backing-timeline';

type MapSettings=Pick<BackingSettings,'offsetMs'|'anchors'>;
interface MappingCase {
  name:string;timeline:string;backing:MapSettings;samples:{tick:number;sourceMs:number}[];
  gridWindow?:{startMs:number;endMs:number};gridTicks?:number[];
  selection?:BackingScoreSelection;expectedSelection?:{points:number[];spans:{startMs:number;endMs:number}[]};
}
const timelines:Record<string,BackingTimeline>=mapping.timelines;
const cases:MappingCase[]=mapping.cases;
const empty:MapSettings={offsetMs:0,anchors:[]};
function settings(backing:MapSettings):BackingSettings {
  return {...structuredClone(backing),assetId:'original-asset',mix:{gain:0.7,pan:-0.25,mute:false,solo:true}};
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object') {Object.freeze(value);for(const child of Object.values(value))freeze(child);}
  return value;
}
function expectSelection(actual:{points:number[];spans:{startMs:number;endMs:number}[]},expected:{points:number[];spans:{startMs:number;endMs:number}[]}) {
  expect(actual).toEqual({points:expected.points.map(ms=>expect.closeTo(ms,6)),spans:expected.spans.map(span=>({startMs:expect.closeTo(span.startMs,6),endMs:expect.closeTo(span.endMs,6)}))});
}

for(const fixture of cases)it(`visual_mapping_agrees_with_native_reference_fixtures: ${fixture.name}`,()=>{
  const timeline=freeze(structuredClone(timelines[fixture.timeline])),backing=freeze(structuredClone(fixture.backing));
  const before=structuredClone({timeline,backing});
  for(const sample of fixture.samples)expect(Math.abs(scoreTickToAudioMs(timeline,backing,sample.tick)-sample.sourceMs)).toBeLessThanOrEqual(mapping.toleranceMs);
  if(fixture.gridWindow)expect(projectBackingGrid(timeline,backing,fixture.gridWindow.startMs,fixture.gridWindow.endMs).map(line=>line.tick)).toEqual(fixture.gridTicks);
  if(fixture.selection)expectSelection(projectBackingSelection(timeline,backing,freeze(structuredClone(fixture.selection))),fixture.expectedSelection!);
  expect({timeline,backing}).toEqual(before);
});

for(const fixture of mapping.invalidMaps)it(`visual_mapping_rejects_invalid_map_without_mutation: ${fixture.name}`,()=>{
  const timeline=freeze(structuredClone(timelines[fixture.timeline])),backing=freeze(structuredClone(fixture.backing));
  const before=structuredClone({timeline,backing});
  expect(()=>scoreTickToAudioMs(timeline,backing,0)).toThrow();
  expect(()=>scoreTimeToAudioMs(timeline,backing,0)).toThrow();
  expect(()=>projectBackingGrid(timeline,backing,0,1000)).toThrow();
  expect(()=>projectBackingSelection(timeline,backing,{points:[],spans:[]})).toThrow();
  expect({timeline,backing}).toEqual(before);
});

it('nominal_time_is_mapped_directly_and_endpoint_segments_extrapolate',()=>{
  const timeline=timelines.tempoChange;
  const backing:MapSettings={offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0.5,audioMs:2000}]};
  expect(scoreTimeToAudioMs(timeline,backing,500)).toBeCloseTo(880,6);
  expect(scoreTimeToAudioMs(timeline,backing,-100)).toBeCloseTo(280,6);
  expect(scoreTickToAudioMs(timeline,empty,-960)).toBe(0);
  expect(scoreTickToAudioMs(timeline,empty,8640)).toBeCloseTo(8500,6);
  const piecewise:MapSettings={offsetMs:100,anchors:[
    {bar:0,occurrence:0,ratio:0,audioMs:1000},
    {bar:1,occurrence:0,ratio:0,audioMs:5000},
    {bar:2,occurrence:0,ratio:0,audioMs:6000},
  ]};
  expect([-500,1000,2000,3000,4000,6000].map(ms=>scoreTimeToAudioMs(timelines.straight,piecewise,ms))).toEqual([-100,2900,4900,5400,5900,6900].map(ms=>expect.closeTo(ms,6)));
});

it('grid_uses_real_meter_pickup_and_visible_source_window',()=>{
  const sixEight=structuredClone(timelines.sixEight);
  delete sixEight.occurrences[0].clickTicks;
  const before=structuredClone(sixEight);
  const lines=projectBackingGrid(freeze(sixEight),empty,0,1499);
  expect(lines.map(({tick,ratio,kind})=>({tick,ratio,kind}))).toEqual([
    {tick:0,ratio:0,kind:'bar'},{tick:480,ratio:1/6,kind:'beat'},
    {tick:960,ratio:1/3,kind:'beat'},{tick:1440,ratio:1/2,kind:'beat'},
    {tick:1920,ratio:2/3,kind:'beat'},{tick:2400,ratio:5/6,kind:'beat'},
  ]);
  expect(sixEight).toEqual(before);
  for(const name of ['pickup','freeTime']) {
    const timeline=structuredClone(timelines[name]);delete timeline.occurrences[0].clickTicks;
    expect(projectBackingGrid(timeline,empty,0,name==='pickup'?499:625).map(line=>line.tick)).toEqual(name==='pickup'?[0]:[0,480,960]);
  }
  const irregular=structuredClone(timelines.sixEight);irregular.occurrences[0].clickTicks=[0,240,1440];
  expect(projectBackingGrid(irregular,empty,0,1499).map(line=>line.tick)).toEqual([0,240,1440]);
  const mapped:MapSettings={offsetMs:120,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:4000}]};
  expect(projectBackingGrid(timelines.straight,mapped,1600,2400).map(({tick,audioMs})=>({tick,audioMs}))).toEqual([{tick:960,audioMs:1630},{tick:1920,audioMs:2380}]);
  expect(projectBackingGrid(timelines.straight,mapped,1630,1630).map(line=>line.tick)).toEqual([960]);
  const repeated=projectBackingGrid(timelines.repeatRoute,empty,0,8000).filter(line=>line.kind==='bar');
  expect(repeated.map(({bar,occurrence,tick})=>({bar,occurrence,tick}))).toEqual([
    {bar:0,occurrence:0,tick:0},{bar:1,occurrence:0,tick:3840},{bar:0,occurrence:1,tick:7680},{bar:3,occurrence:0,tick:11520},
  ]);
  expect(new Set(repeated.map(line=>line.key)).size).toBe(4);
});

it('grid_includes_a_quarter_pulse_at_an_exact_source_window_boundary',()=>{
  expect(projectBackingGrid(timelines.straight,empty,500,500).map(line=>line.tick)).toEqual([960]);
  const fractional:BackingTimeline={generation:1,durationTick:15,tempos:[{tick:0,bpm:625}],occurrences:[{bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:15,startMs:0,endMs:1.5,clickTicks:[0,3]}]};
  expect(projectBackingGrid(fractional,empty,0.3,0.3).map(line=>line.tick)).toEqual([3]);
});

it('grid_bounds_fallback_work_to_the_visible_part_of_a_long_free_time_measure',()=>{
  const timeline:BackingTimeline={generation:1,durationTick:960_000_000_000,tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,meterNumerator:6,meterDenominator:256,startTick:0,endTick:960_000_000_000,startMs:0,endMs:500_000_000_000}]};
  expect(projectBackingGrid(timeline,empty,499_999_999_992,500_000_000_000).map(line=>line.tick)).toEqual([959_999_999_985]);
});

it('fallback_grid_never_invents_an_end_pulse_when_fractional_span_rounds_up',()=>{
  const timeline:BackingTimeline={generation:1,durationTick:16.1,tempos:[{tick:0,bpm:625}],occurrences:[{bar:0,occurrence:0,meterNumerator:6,meterDenominator:256,startTick:1.1,endTick:16.1,startMs:0.11,endMs:1.61}]};
  expect(projectBackingGrid(timeline,empty,0,2).map(line=>line.tick)).toEqual([1.1]);
});

for(const fixture of mapping.moves)it(`drag_writes_pre_offset_value_and_preserves_unrelated_settings: ${fixture.name}`,()=>{
  const backing=freeze(settings(fixture.backing)),timeline=freeze(structuredClone(timelines[fixture.timeline]));
  const before=structuredClone({backing,timeline});
  if('reject' in fixture&&fixture.reject)expect(()=>moveBackingAnchor(backing,fixture.index,fixture.sourceMs,timeline,fixture.durationMs)).toThrow();
  else {
    const candidate=moveBackingAnchor(backing,fixture.index,fixture.sourceMs,timeline,fixture.durationMs);
    const expected=structuredClone(backing);expected.anchors[fixture.index].audioMs='expectedAudioMs' in fixture?fixture.expectedAudioMs!:NaN;
    expect(candidate).toEqual(expected);
    expect(candidate).not.toBe(backing);expect(candidate.anchors).not.toBe(backing.anchors);expect(candidate.mix).not.toBe(backing.mix);
    candidate.anchors[0].ratio=0.75;candidate.mix.gain=0.1;
  }
  expect({backing,timeline}).toEqual(before);
});

it('drag_accepts_source_endpoints_and_rejects_nonfinite_bounds_indices_and_neighbors',()=>{
  const timeline=freeze(structuredClone(timelines.straight));
  const backing=freeze(settings({offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:2500}]}));
  const before=structuredClone(backing);
  expect(moveBackingAnchor(backing,0,0,timeline,16000).anchors[0].audioMs).toBe(0);
  expect(moveBackingAnchor(backing,0,16000,timeline,16000).anchors[0].audioMs).toBe(16000);
  expect(moveBackingAnchor({...backing,offsetMs:120},0,16000,timeline,16000).anchors[0].audioMs).toBe(16120);
  for(const value of [NaN,Infinity,-Infinity]) {
    expect(()=>moveBackingAnchor(backing,0,value,timeline,16000)).toThrow();
    expect(()=>moveBackingAnchor(backing,0,1000,timeline,value)).toThrow();
    expect(()=>moveBackingAnchor(backing,value,1000,timeline,16000)).toThrow();
  }
  for(const index of [-1,0.5,1])expect(()=>moveBackingAnchor(backing,index,1000,timeline,16000)).toThrow();
  expect(()=>moveBackingAnchor(backing,0,0,timeline,-1)).toThrow();
  const neighbors=freeze(settings({offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:1000},{bar:1,occurrence:0,ratio:0,audioMs:2000},{bar:2,occurrence:0,ratio:0,audioMs:3000}]}));
  for(const sourceMs of [500,1000,3000,3500])expect(()=>moveBackingAnchor(neighbors,1,sourceMs,timeline,16000)).toThrow();
  const missing=freeze(settings({offsetMs:0,anchors:[{bar:0,occurrence:1,ratio:0,audioMs:1000}]}));
  expect(()=>moveBackingAnchor(missing,0,2000,timeline,16000)).toThrow();
  expect(backing).toEqual(before);
});

it('selection_projects_all_performed_copies_without_first_pass_guess',()=>{
  const selection=freeze({points:[{tick:120,anchor:null},{tick:960,anchor:{bar:0,occurrence:0,ratio:0.25}},{tick:8640,anchor:{bar:0,occurrence:1,ratio:0.25}}],spans:[{startTick:120,endTick:1920},{startTick:8640,endTick:9600}]});
  const before=structuredClone(selection);
  expectSelection(projectBackingSelection(timelines.repeatRoute,{offsetMs:120,anchors:[]},selection),{points:[-57.5,380,4380],spans:[{startMs:-57.5,endMs:880},{startMs:4380,endMs:4880}]});
  expectSelection(projectBackingSelection(timelines.tempoChange,empty,{points:[{tick:960,anchor:null},{tick:1920,anchor:null}],spans:[{startTick:960,endTick:3840}]}),{points:[500,1500],spans:[{startMs:500,endMs:3500}]});
  expect(selection).toEqual(before);
});

it('nonfinite_values_and_invalid_temporal_inputs_reject_without_mutation',()=>{
  const timeline=freeze(structuredClone(timelines.straight)),backing=freeze(settings(empty));
  for(const value of [NaN,Infinity,-Infinity]) {
    expect(()=>scoreTickToAudioMs(timeline,backing,value)).toThrow();
    expect(()=>scoreTimeToAudioMs(timeline,backing,value)).toThrow();
    expect(()=>projectBackingGrid(timeline,backing,value,1000)).toThrow();
    expect(()=>projectBackingGrid(timeline,backing,0,value)).toThrow();
    expect(()=>scoreTickToAudioMs(timeline,{offsetMs:value,anchors:[]},0)).toThrow();
    for(const key of ['ratio','audioMs'] as const)expect(()=>scoreTickToAudioMs(timeline,{offsetMs:0,anchors:[{bar:0,occurrence:0,ratio:0,audioMs:0,[key]:value}]},0)).toThrow();
  }
  expect(()=>projectBackingGrid(timeline,backing,1000,0)).toThrow();
  for(const selection of [{points:[{tick:NaN,anchor:null}],spans:[]},{points:[],spans:[{startTick:960,endTick:0}]},{points:[],spans:[{startTick:0,endTick:0}]}])expect(()=>projectBackingSelection(timeline,backing,selection)).toThrow();
  const invalidTimelines:BackingTimeline[]=[
    {...structuredClone(timeline),tempos:[]},
    {...structuredClone(timeline),tempos:[{tick:0,bpm:0}]},
    {...structuredClone(timeline),tempos:[{tick:0,bpm:120},{tick:0,bpm:60}]},
    {...structuredClone(timeline),tempos:[{tick:960,bpm:120}]},
    {...structuredClone(timeline),tempos:[{tick:0,bpm:NaN}]},
    {...structuredClone(timeline),durationTick:NaN},
  ];
  for(const invalid of invalidTimelines) {
    const before=structuredClone(invalid);expect(()=>scoreTickToAudioMs(invalid,backing,0)).toThrow();expect(invalid).toEqual(before);
  }
});

it('reference preview projects mandatory brackets through ticks rather than authored tempo spans',()=>{
  const timeline=freeze(structuredClone(timelines.tempoChange));
  const input=freeze(settings({offsetMs:120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}]}));
  const reference=freeze({...input,referenceSync:{entryAudioMs:1120,exitAudioMs:7120}});
  const before=structuredClone({timeline,reference});
  expect(scoreTickToAudioMs(timeline,reference,4800)).toBeCloseTo(4000,7);
  // The supplied authored timeline reaches tick1920 at1500ms, tick4800 at4500ms.
  expect(scoreTimeToAudioMs(timeline,reference,4500)).toBeCloseTo(4000,7);
  expect(projectBackingGrid(timeline,reference,3500,4500).map(({tick,audioMs})=>({tick,audioMs}))).toEqual([{tick:4800,audioMs:4000}]);
  expectSelection(projectBackingSelection(timeline,reference,{points:[{tick:4800,anchor:null}],spans:[{startTick:3840,endTick:7680}]}),{points:[4000],spans:[{startMs:3000,endMs:7000}]});
  const preview={...reference,referenceSync:{entryAudioMs:1120,exitAudioMs:11120}};
  expect(scoreTickToAudioMs(timeline,preview,4800)).toBeCloseTo(5000,7);
  expect({timeline,reference}).toEqual(before);
});

it('reference repeated selection uses each performed occurrence and clear interiors retains bounds',()=>{
  const timeline=freeze(structuredClone(timelines.repeatRoute));
  const reference={...settings({offsetMs:-120,anchors:[]}),referenceSync:{entryAudioMs:-120,exitAudioMs:7880}};
  expectSelection(projectBackingSelection(timeline,reference,{points:[{tick:960,anchor:null},{tick:8640,anchor:null}],spans:[{startTick:7680,endTick:11520}]}),{points:[500,4500],spans:[{startMs:4000,endMs:6000}]});
  expect(projectBackingGrid(timeline,reference,0,8000).filter(line=>line.kind==='bar').map(line=>line.audioMs)).toEqual([0,2000,4000,6000].map(ms=>expect.closeTo(ms,7)));
});

it('reference anchor movement accepts signed stored positions and validates against mandatory bounds',()=>{
  const timeline=freeze(structuredClone(timelines.straight));
  const reference=freeze({...settings({offsetMs:-120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:880}]}),referenceSync:{entryAudioMs:-120,exitAudioMs:1880}});
  const moved=moveBackingAnchor(reference,0,50,timeline,2000);
  expect(moved.anchors[0].audioMs).toBe(-70);
  expect(moved.referenceSync).toEqual(reference.referenceSync);expect(moved.referenceSync).not.toBe(reference.referenceSync);
  for(const sourceMs of [0,2000])expect(()=>moveBackingAnchor(reference,0,sourceMs,timeline,2000)).toThrow();
});

it('reference anchor edits reject an unrepresentable physical source request',()=>{
  const timeline=freeze(structuredClone(timelines.straight));
  const reference=freeze({...settings({offsetMs:1e16,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:1e16+2}]}),referenceSync:{entryAudioMs:1e16,exitAudioMs:1e16+10}});
  expect(()=>moveBackingAnchor(reference,0,3,timeline,10)).toThrow();
});
