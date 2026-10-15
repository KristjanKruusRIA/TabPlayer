import {expect,it,vi} from 'vitest';
import {buildDocument,previewEdit} from '../engine';
import {blankProject} from '../project';
import type {MusicSelection} from '../editor/range-types';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import type {BackingTimeline} from './backing-waveform-types';
import {DEFAULT_PRACTICE} from './practice-types';
import type {PlaybackPlan} from './types';

const cursor={track:0,staff:0,bar:0,voice:0,beat:1};
const passage:MusicSelection={kind:'range',range:{start:{bar:0,tick:480},end:{bar:0,tick:1440},lanes:[{track:0,staff:0,voice:0}]}};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
// Authored route and intra-bar tempo change; expected positions never use the plan builder.
function timeline(generation:number):PlaybackPlan {
  const occurrences=[
    {bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:3840,startMs:0,endMs:3000,clickTicks:[0,960,1920,2880]},
    {bar:1,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:3840,endTick:7680,startMs:3000,endMs:7000},
    {bar:0,occurrence:1,meterNumerator:4,meterDenominator:4,startTick:7680,endTick:11520,startMs:7000,endMs:11000},
    {bar:2,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:11520,endTick:15360,startMs:11000,endMs:15000},
  ];
  return {generation,ppq:960,durationTick:15360,durationMs:15000,tracks:[{id:'base/0',program:0,percussion:false}],tempos:[{tick:0,bpm:120},{tick:1920,bpm:60}],occurrences,notes:[],midi:[],performedBeats:occurrences.flatMap(o=>Array.from({length:4},(_,beat)=>({target:{...cursor,bar:o.bar,beat},occurrence:o.occurrence,startTick:o.startTick+beat*960,endTick:o.startTick+(beat+1)*960,leadInTick:o.startTick+beat*960})))};
}
function fixture(){
  const project=previewEdit(blankProject(),{type:'setNote',target:cursor,string:6,fret:7}).project,built=buildDocument(project);
  let receive:(status:NativeAudioStatus)=>void=()=>{};
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const prepare=vi.fn(async(_project:typeof project,generation:number)=>timeline(generation)),onEdit=vi.fn(),player=new NativePlaybackController({bridge,onEdit,preparePlan:prepare});
  const emit=(patch:Partial<NativeAudioStatus>={})=>receive({generation:player.generation,ready:true,playing:false,tick:0,seconds:0,durationSeconds:15,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},...patch});
  return {project,built,bridge,prepare,onEdit,player,emit};
}

it('generated_timing_is_available_without_output_device_and_notifies_after_preparation',async()=>{
  const {project,built,bridge,player,onEdit}=fixture();
  try {
    expect(player.backingTimeline()).toBeNull();expect(player.backingScoreSelection(cursor,passage)).toEqual({points:[],spans:[]});
    vi.mocked(bridge.prepare).mockRejectedValueOnce(new Error('No audio output device'));
    const observations:(BackingTimeline|null)[]=[];player.subscribe(()=>observations.push(player.backingTimeline()));
    await player.loadDocument(project,built);
    const plan=vi.mocked(bridge.prepare).mock.calls[0][0],timing=player.backingTimeline();
    expect(player.getState()).toMatchObject({ready:false,error:'No audio output device'});
    expect(timing).toEqual({generation:player.generation,durationTick:15360,tempos:[{tick:0,bpm:120},{tick:1920,bpm:60}],occurrences:plan.occurrences});
    expect(timing!.tempos).toBe(plan.tempos);expect(timing!.occurrences).toBe(plan.occurrences);
    expect(observations.at(-1)).toEqual(timing);expect(observations.filter(Boolean)).toHaveLength(1);
    expect(player.backingScoreSelection(cursor,passage)).toEqual({points:[{tick:960,anchor:{bar:0,occurrence:0,ratio:.25}},{tick:8640,anchor:{bar:0,occurrence:1,ratio:.25}}],spans:[{startTick:480,endTick:1440},{startTick:8160,endTick:9120}]});
    expect(onEdit).not.toHaveBeenCalled();expect(vi.mocked(bridge.command).mock.calls.map(([command])=>command.type)).toEqual(['invalidate']);
  }finally{player.destroy();}
});

it('clock_updates_and_native_error_keep_current_timing_arrays_and_selection_read_only',async()=>{
  const {project,built,bridge,player,emit,onEdit}=fixture();
  try {
    await player.loadDocument(project,built);const timing=player.backingTimeline()!,before=JSON.stringify(project),commands=vi.mocked(bridge.command).mock.calls.length;
    expect(timing).not.toBeNull();
    for(const patch of [{playing:true,tick:960,seconds:.5},{tick:8640,seconds:8},{ready:false,error:'Device disconnected'}]){
      emit(patch);const current=player.backingTimeline()!;
      expect(current.tempos).toBe(timing.tempos);expect(current.occurrences).toBe(timing.occurrences);
      expect(player.backingScoreSelection(cursor,null)).toEqual({points:[{tick:960,anchor:{bar:0,occurrence:0,ratio:.25}},{tick:8640,anchor:{bar:0,occurrence:1,ratio:.25}}],spans:[]});
    }
    expect(JSON.stringify(project)).toBe(before);expect(onEdit).not.toHaveBeenCalled();expect(bridge.command).toHaveBeenCalledTimes(commands);expect(bridge.prepare).toHaveBeenCalledOnce();
  }finally{player.destroy();}
});

it('preparing_superseded_and_destroyed_plans_never_expose_stale_timing',async()=>{
  const {project,built,bridge,prepare,player}=fixture(),planQuery=deferred<PlaybackPlan>(),nativeQuery=deferred<void>();
  try {
    prepare.mockReturnValueOnce(planQuery.promise);vi.mocked(bridge.prepare).mockReturnValueOnce(nativeQuery.promise);
    const loading=player.loadDocument(project,built);await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());const oldGeneration=player.generation;
    expect(player.backingTimeline()).toBeNull();expect(player.backingScoreSelection(cursor,passage)).toEqual({points:[],spans:[]});
    planQuery.resolve(timeline(oldGeneration));await vi.waitFor(()=>expect(bridge.prepare).toHaveBeenCalledOnce());
    expect(player.backingTimeline()).toBeNull();expect(player.backingScoreSelection(cursor,passage)).toEqual({points:[],spans:[]});
    player.beforeScoreChange(false);expect(player.backingTimeline()).toBeNull();
    await player.loadDocument(project,built);const current=player.backingTimeline()!;expect(current.generation).toBe(player.generation);expect(current.generation).not.toBe(oldGeneration);
    nativeQuery.reject(new Error('Superseded device preparation'));await loading;
    expect(player.backingTimeline()).toEqual(current);expect(player.getState().error).toBeNull();
    player.destroy();expect(player.backingTimeline()).toBeNull();expect(player.backingScoreSelection(cursor,passage)).toEqual({points:[],spans:[]});
  }finally{player.destroy();}
});

it('grace_lead_in_outside_its_occurrence_is_visible_without_a_fabricated_anchor',async()=>{
  const {project,built,prepare,player}=fixture();
  try {
    prepare.mockImplementationOnce(async(_project,generation)=>{const plan=timeline(generation);plan.performedBeats!.find(row=>row.target.bar===1&&row.target.beat===0)!.leadInTick=3720;return plan;});
    await player.loadDocument(project,built);
    expect(player.backingScoreSelection({...cursor,bar:1,beat:0},null)).toEqual({points:[{tick:3720,anchor:null}],spans:[]});
    expect(player.backingScoreSelection({...cursor,bar:1,beat:1},null)).toEqual({points:[{tick:4800,anchor:{bar:1,occurrence:0,ratio:.25}}],spans:[]});
  }finally{player.destroy();}
});

it('selection_spans_preserve_existing_exclusive_seam_notes_and_bar_passage_semantics',async()=>{
  const {project,built,player}=fixture();
  try {
    await player.loadDocument(project,built);
    const cases:{selection:MusicSelection;spans:{startTick:number;endTick:number}[]}[]=[
      {selection:{kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:0},lanes:[{track:0,staff:0,voice:0}]}},spans:[{startTick:0,endTick:3840},{startTick:7680,endTick:11520}]},
      {selection:{kind:'notes',notes:[{target:cursor,noteIndex:0}]},spans:[{startTick:960,endTick:1920},{startTick:8640,endTick:9600}]},
      {selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:2},spans:[{startTick:0,endTick:15360}]},
    ];
    for(const {selection,spans} of cases)expect(player.backingScoreSelection(cursor,selection).spans).toEqual(spans);
  }finally{player.destroy();}
});

it('invalid_or_unperformed_addresses_hide_only_the_unavailable_selection_part',async()=>{
  const {project,built,prepare,player}=fixture();
  try {
    prepare.mockImplementationOnce(async(_project,generation)=>{const plan=timeline(generation);plan.performedBeats=plan.performedBeats!.filter(row=>row.target.bar!==2);return plan;});
    await player.loadDocument(project,built);
    for(const target of [{...cursor,beat:99},{...cursor,bar:2}])expect(player.backingScoreSelection(target,passage)).toEqual({points:[],spans:[{startTick:480,endTick:1440},{startTick:8160,endTick:9120}]});
    expect(player.backingScoreSelection(cursor,{kind:'bars',tracks:[99],firstBar:0,lastBar:0})).toEqual({points:[{tick:960,anchor:{bar:0,occurrence:0,ratio:.25}},{tick:8640,anchor:{bar:0,occurrence:1,ratio:.25}}],spans:[]});
  }finally{player.destroy();}
});
