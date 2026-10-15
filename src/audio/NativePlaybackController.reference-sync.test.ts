import {expect,it,vi} from 'vitest';
import {model} from '@coderline/alphatab';
import {buildDocument} from '../engine';
import {blankProject} from '../project';
import type {BackingSettings} from '../edit-types';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import {DEFAULT_PRACTICE} from './practice-types';
import type {PlaybackPlan} from './types';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function backing():BackingSettings{return {assetId:'a'.repeat(64),offsetMs:0,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3000}],referenceSync:{entryAudioMs:1000,exitAudioMs:7000},mix:{gain:.7,pan:0,mute:false,solo:false}};}
// Literal authored clock: two 4/4 measures at 120 BPM, independently of reference timing.
function authored(generation:number):PlaybackPlan{return {generation,ppq:960,durationTick:7680,durationMs:4000,tempos:[{tick:0,bpm:120}],occurrences:[
  {bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:3840,startMs:0,endMs:2000,clickTicks:[0,960,1920,2880]},
  {bar:1,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:3840,endTick:7680,startMs:2000,endMs:4000},
],tracks:[{id:'base/0',program:0,percussion:false}],notes:[],midi:[],performedBeats:[]};}
function fixture(initial:BackingSettings|null=backing()){
  const project=blankProject(),original=buildDocument(project),built={...original,settings:{...original.settings,backing:initial}};
  let receive:(status:NativeAudioStatus)=>void=()=>{};
  const bridge:NativeAudioBridge={prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};
  const prepare=vi.fn(async(_project:typeof project,generation:number)=>authored(generation)),onEdit=vi.fn(),player=new NativePlaybackController({bridge,onEdit,preparePlan:prepare});
  const status=(patch:Partial<NativeAudioStatus>={}):NativeAudioStatus=>({generation:player.generation,ready:true,playing:false,tick:0,seconds:0,durationSeconds:6,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'paused',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null},...patch});
  const next=(value:BackingSettings|null)=>({...built,settings:{...built.settings,backing:value}});
  return {project,built,bridge,prepare,onEdit,player,status,emit:(patch:Partial<NativeAudioStatus>={})=>receive(status(patch)),next};
}
function view(player:NativePlaybackController){
  const output:{handler?:{seekTo:(time:number)=>void;backingTrackDuration:number};updatePosition:ReturnType<typeof vi.fn>}={updatePosition:vi.fn()};
  const api={player:{output,updateSyncPoints:vi.fn()},playerReady:{on:vi.fn(),off:vi.fn()},play:vi.fn(),pause:vi.fn()} as unknown as Parameters<NativePlaybackController['attachView']>[0];
  player.attachView(api);return {output,api};
}

it('prepares effective 120/60 timing while retaining exact authored plan and score',async()=>{
  const f=fixture(),source=model.JsonConverter.scoreToJson(f.built.score),settings=structuredClone(f.built.settings),worker=authored(0);
  f.prepare.mockImplementationOnce(async(_project,generation)=>{worker.generation=generation;return worker;});
  try{
    await f.player.loadDocument(f.project,f.built);
    const effective=vi.mocked(f.bridge.prepare).mock.calls[0][0];
    expect(effective).not.toBe(worker);expect(effective.tempos).toEqual([{tick:0,bpm:120},{tick:3840,bpm:60}]);
    expect(effective).toMatchObject({durationTick:7680,durationMs:6000,playbackEndTick:7680});
    expect(effective.occurrences.map(o=>[o.startMs,o.endMs])).toEqual([[0,2000],[2000,6000]]);
    expect(f.player.backingTimeline()).toMatchObject({tempos:effective.tempos,occurrences:effective.occurrences});
    expect(worker.tempos).toEqual([{tick:0,bpm:120}]);expect(worker.durationMs).toBe(4000);expect(worker.playbackEndTick).toBeUndefined();
    expect(f.player.getState().endTime).toBe(6000);expect(f.prepare).toHaveBeenCalledWith(f.project,f.player.generation);
    expect(f.built.settings).toEqual(settings);expect(model.JsonConverter.scoreToJson(f.built.score)).toBe(source);expect(f.onEdit).not.toHaveBeenCalled();
  }finally{f.player.destroy();}
});

it.each(['entry','exit','offset','interior','source','enable','disable'] as const)('same-score %s reference change invalidates and prepares a fresh generation',async change=>{
  const initial=backing();if(change==='enable')delete initial.referenceSync;
  const f=fixture(initial);try{
    await f.player.loadDocument(f.project,f.built);const generation=f.player.generation,value=backing();
    if(change==='entry')value.referenceSync!.entryAudioMs=1200;
    if(change==='exit')value.referenceSync!.exitAudioMs=8000;
    if(change==='offset')value.offsetMs=120;
    if(change==='interior')value.anchors[0].audioMs=3500;
    if(change==='source')value.assetId='b'.repeat(64);
    if(change==='disable')delete value.referenceSync;
    await f.player.loadDocument(f.project,f.next(value));
    expect(f.player.generation).toBeGreaterThan(generation);expect(f.bridge.prepare).toHaveBeenCalledTimes(2);expect(f.bridge.setMix).not.toHaveBeenCalled();
    expect(vi.mocked(f.bridge.command).mock.calls.map(([command])=>command.type)).toEqual(['invalidate','invalidate']);
    expect(vi.mocked(f.bridge.prepare).mock.calls.at(-1)![0].generation).toBe(f.player.generation);
    expect(vi.mocked(f.bridge.prepare).mock.calls.at(-1)![0].playbackEndTick).toBe(change==='disable'?undefined:7680);
  }finally{f.player.destroy();}
});

it('reference mix changes retain the prepared plan and use setMix',async()=>{
  const f=fixture();try{
    await f.player.loadDocument(f.project,f.built);const generation=f.player.generation,timeline=f.player.backingTimeline()!,value=backing();value.mix={gain:.25,pan:.5,mute:true,solo:true};
    await f.player.loadDocument(f.project,f.next(value));
    expect(f.player.generation).toBe(generation);expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(f.bridge.setMix).toHaveBeenCalledExactlyOnceWith(f.next(value).settings,generation);
    expect(f.player.backingTimeline()!.tempos).toBe(timeline.tempos);expect(f.player.backingTimeline()!.occurrences).toBe(timeline.occurrences);
  }finally{f.player.destroy();}
});

it('legacy same-score backing map changes retain incumbent setMix behavior',async()=>{
  const initial=backing();delete initial.referenceSync;const f=fixture(initial);try{
    await f.player.loadDocument(f.project,f.built);const generation=f.player.generation,value=structuredClone(initial);value.offsetMs=100;value.anchors[0].audioMs=3200;
    await f.player.loadDocument(f.project,f.next(value));expect(f.player.generation).toBe(generation);expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(f.bridge.setMix).toHaveBeenCalledOnce();
  }finally{f.player.destroy();}
});

it('adapts native ticks to authored view milliseconds and inverts authored seeks without feedback',async()=>{
  const f=fixture(),v=view(f.player);try{
    await f.player.loadDocument(f.project,f.built);vi.mocked(f.bridge.command).mockClear();
    v.output.updatePosition.mockImplementation(()=>v.output.handler!.seekTo(0));f.emit({tick:4800,seconds:3,playing:true});
    expect(v.output.updatePosition).toHaveBeenLastCalledWith(2500);expect(f.player.getState()).toMatchObject({time:3000,endTime:6000,measure:1});
    expect(v.output.handler!.backingTrackDuration).toBe(4000);expect(f.bridge.command).not.toHaveBeenCalled();expect(v.api.player!.updateSyncPoints).toHaveBeenLastCalledWith([]);
    v.output.handler!.seekTo(2500);expect(f.bridge.command).toHaveBeenLastCalledWith({type:'seekTick',generation:f.player.generation,tick:4800});
  }finally{f.player.destroy();}
});

it('uses the performed authored clock through repeats and intra-bar tempo changes',async()=>{
  const value=backing();value.referenceSync!.exitAudioMs=11000;const f=fixture(value),v=view(f.player);
  f.prepare.mockImplementationOnce(async(_project,generation)=>{const plan=authored(generation);plan.tempos=[{tick:0,bpm:120},{tick:960,bpm:60},{tick:5760,bpm:180}];plan.durationTick=11520;plan.durationMs=7500;
    plan.occurrences=[{...plan.occurrences[0],endMs:3500},{...plan.occurrences[1],startMs:3500,endMs:18500/3},{...plan.occurrences[0],occurrence:1,startTick:7680,endTick:11520,startMs:18500/3,endMs:7500}];return plan;});
  try{
    await f.player.loadDocument(f.project,f.built);f.emit({tick:8640,seconds:7,durationSeconds:10});expect(v.output.updatePosition).toHaveBeenLastCalledWith(6500);
    v.output.handler!.seekTo(6500);expect(f.bridge.command).toHaveBeenLastCalledWith({type:'seekTick',generation:f.player.generation,tick:8640});
    expect(f.player.getState()).toMatchObject({measure:0,time:7000,endTime:10000});expect(v.output.handler!.backingTrackDuration).toBe(7500);
  }finally{f.player.destroy();}
});

it('keeps grace pre-roll and effective active duration readable after no-device preparation',async()=>{
  const value=backing();value.anchors=[];value.referenceSync={entryAudioMs:1000,exitAudioMs:5000};const f=fixture(value),v=view(f.player);
  f.prepare.mockImplementationOnce(async(_project,generation)=>{const plan=authored(generation);plan.durationTick=8280;plan.durationMs=4312.5;plan.occurrences=plan.occurrences.map(o=>({...o,startTick:o.startTick+120,endTick:o.endTick+120,startMs:o.startMs+62.5,endMs:o.endMs+62.5}));return plan;});
  vi.mocked(f.bridge.prepare).mockRejectedValueOnce(new Error('No audio output device'));
  try{
    const observed:(ReturnType<NativePlaybackController['backingTimeline']>)[]=[];f.player.subscribe(()=>observed.push(f.player.backingTimeline()));await f.player.loadDocument(f.project,f.built);
    const timing=f.player.backingTimeline()!;expect(timing.occurrences[0].startMs).toBeCloseTo(62.5,7);expect(timing.occurrences.at(-1)!.endMs).toBeCloseTo(4062.5,7);
    expect(f.player.getState()).toMatchObject({ready:false,error:'No audio output device',endTime:4062.5});expect(observed.at(-1)).toEqual(timing);
    expect(vi.mocked(f.bridge.prepare).mock.calls[0][0]).toMatchObject({durationTick:8280,durationMs:expect.closeTo(4312.5,7),playbackEndTick:7800});
    f.emit({tick:60,seconds:.03125,durationSeconds:4.0625});expect(v.output.updatePosition).toHaveBeenLastCalledWith(31.25);v.output.handler!.seekTo(31.25);
    expect(f.bridge.command).toHaveBeenLastCalledWith({type:'seekTick',generation:f.player.generation,tick:60});
  }finally{f.player.destroy();}
});

it('supersedes a pending authored plan when reference timing changes on the same score',async()=>{
  const f=fixture(),old=deferred<PlaybackPlan>();f.prepare.mockReturnValueOnce(old.promise);
  try{
    const pending=f.player.loadDocument(f.project,f.built);await vi.waitFor(()=>expect(f.prepare).toHaveBeenCalledOnce());const generation=f.player.generation;
    const value=backing();value.referenceSync!.exitAudioMs=8000;await f.player.loadDocument(f.project,f.next(value));const current=f.player.backingTimeline()!;
    old.resolve(authored(generation));await pending;expect(f.player.generation).toBeGreaterThan(generation);expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(current.generation).toBe(f.player.generation);
    expect(current.occurrences.at(-1)!.endMs).toBe(7000);expect(f.player.backingTimeline()).toEqual(current);
    f.emit({generation,playing:true,tick:4800,seconds:99});expect(f.player.getState()).toMatchObject({playing:false,time:0,endTime:7000});
  }finally{f.player.destroy();}
});

it('identical same-score reference loads preserve an in-flight generation and prepare once',async()=>{
  const f=fixture(),query=deferred<PlaybackPlan>();f.prepare.mockReturnValueOnce(query.promise);
  try{
    const pending=f.player.loadDocument(f.project,f.built);await vi.waitFor(()=>expect(f.prepare).toHaveBeenCalledOnce());const generation=f.player.generation;
    await f.player.loadDocument(f.project,f.next(backing()));expect(f.player.generation).toBe(generation);expect(f.prepare).toHaveBeenCalledOnce();
    query.resolve(authored(generation));await pending;expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(f.player.backingTimeline()!.generation).toBe(generation);
    expect(f.player.backingTimeline()!.occurrences.at(-1)!.endMs).toBe(6000);
  }finally{f.player.destroy();}
});

it('an old mix rejection cannot fail a replacement reference plan',async()=>{
  const f=fixture(),query=deferred<void>();try{
    await f.player.loadDocument(f.project,f.built);const generation=f.player.generation;vi.mocked(f.bridge.setMix).mockReturnValueOnce(query.promise);
    const mixed=backing();mixed.mix.gain=.25;const pending=f.player.loadDocument(f.project,f.next(mixed));await vi.waitFor(()=>expect(f.bridge.setMix).toHaveBeenCalledOnce());
    const replacement=structuredClone(mixed);replacement.referenceSync!.exitAudioMs=8000;await f.player.loadDocument(f.project,f.next(replacement));query.reject(new Error('Retired mix failed'));await pending;
    expect(f.player.generation).toBeGreaterThan(generation);expect(f.player.getState()).toMatchObject({error:null,endTime:7000});expect(f.player.backingTimeline()!.occurrences.at(-1)!.endMs).toBe(7000);
  }finally{f.player.destroy();}
});

it('a superseded native prepare rejection cannot clear the new reference timing',async()=>{
  const f=fixture(),old=deferred<void>();vi.mocked(f.bridge.prepare).mockReturnValueOnce(old.promise);
  try{
    const pending=f.player.loadDocument(f.project,f.built);await vi.waitFor(()=>expect(f.bridge.prepare).toHaveBeenCalledOnce());const generation=f.player.generation;expect(f.player.backingTimeline()).toBeNull();
    const value=backing();value.referenceSync!.exitAudioMs=8000;await f.player.loadDocument(f.project,f.next(value));old.reject(new Error('Old device prepare failed'));await pending;
    expect(f.player.generation).toBeGreaterThan(generation);expect(f.player.getState()).toMatchObject({error:null,endTime:7000});expect(f.player.backingTimeline()!.occurrences.at(-1)!.endMs).toBe(7000);
  }finally{f.player.destroy();}
});

it('a late status query from a superseded prepare cannot move the view or current state',async()=>{
  const f=fixture(),v=view(f.player),old=deferred<NativeAudioStatus|null>();vi.mocked(f.bridge.status).mockResolvedValueOnce(null).mockReturnValueOnce(old.promise);
  try{
    const pending=f.player.loadDocument(f.project,f.built);await vi.waitFor(()=>expect(f.bridge.status).toHaveBeenCalledTimes(2));const generation=f.player.generation;
    const value=backing();value.referenceSync!.exitAudioMs=8000;await f.player.loadDocument(f.project,f.next(value));old.resolve(f.status({generation,playing:true,tick:4800,seconds:99}));await pending;
    expect(v.output.updatePosition).not.toHaveBeenCalled();expect(f.player.getState()).toMatchObject({playing:false,time:0,endTime:7000,error:null});
  }finally{f.player.destroy();}
});
