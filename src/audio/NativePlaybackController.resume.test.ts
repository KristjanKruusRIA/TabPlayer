import {expect,it,vi} from 'vitest';
import {buildDocument,previewEdit} from '../engine';
import {blankProject} from '../project';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import {buildPlaybackPlan} from './plan';
import {DEFAULT_PRACTICE,type PracticeSettings} from './practice-types';
import type {PlaybackPlan} from './types';

const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function fixture(){
  const project=previewEdit(blankProject(),{type:'setNote',target:cursor,string:6,fret:7}).project,built=buildDocument(project);
  let receive:(status:NativeAudioStatus)=>void=()=>{},floor=0;
  let status:NativeAudioStatus={generation:0,desiredGeneration:0,ready:false,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null}};
  const emit=(patch:Partial<NativeAudioStatus>)=>{status={...status,...patch};receive(status);};
  const bridge:NativeAudioBridge={
    prepare:vi.fn(async(plan,_settings,_embedded,_sourceKey,practice)=>{if(plan.generation<floor)throw new Error('Stale prepare generation.');floor=plan.generation;emit({generation:floor,desiredGeneration:floor,ready:true,playing:false,tick:0,seconds:0,range:null,loop:null,practice:{...status.practice,settings:structuredClone(practice!),phase:'idle',completedPasses:0,countInRemaining:0}});}),
    command:vi.fn(async command=>{if(command.type==='invalidate'){floor=Math.max(floor,command.generation);return;}if(command.generation!==floor||command.generation!==status.generation)throw new Error('Stale transport generation.');if(command.type==='play'||command.type==='playRange')emit({playing:true});else if(command.type==='pause'||command.type==='stop')emit({playing:false});}),
    setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>status),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null),
  };
  const prepare=vi.fn(async(candidate:typeof project,generation:number)=>buildPlaybackPlan(buildDocument(candidate).score,generation)),onEdit=vi.fn();
  const player=new NativePlaybackController({bridge,onEdit,preparePlan:prepare});
  const shutdown=()=>{floor+=100;emit({desiredGeneration:floor,ready:false,playing:false});return floor;};
  return {project,built,bridge,prepare,onEdit,player,emit,event:(patch:Partial<NativeAudioStatus>)=>receive({...status,...patch}),shutdown,status:()=>status};
}

it('same retained player refreshes the native floor and exact cached document stopped after resume',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;try{
    await player.loadDocument(project,built);const oldGeneration=player.generation,oldChoice=player.cursorPlaybackChoices(cursor)[0];
    const practice:PracticeSettings={...structuredClone(DEFAULT_PRACTICE),tempo:{kind:'relative',ratio:.75},metronome:{...DEFAULT_PRACTICE.metronome,enabled:true}};
    f.emit({practice:{...f.status().practice,settings:practice,effectiveRatio:.75,phase:'paused'},loop:{startTick:0,endTick:3840},range:{startTick:0,endTick:3840}});
    const source=JSON.stringify(project),floor=f.shutdown(),query=deferred<NativeAudioStatus|null>();vi.mocked(bridge.status).mockReturnValueOnce(query.promise);
    const refreshing=player.loadDocument(project,built,0,0,1);await vi.waitFor(()=>expect(bridge.status).toHaveBeenCalledTimes(3));
    expect(player.getState()).toMatchObject({ready:false,playing:false,range:null,loop:null});expect(player.cursorPlaybackChoices(cursor)).toEqual([]);
    const sameScore=player.loadDocument(project,built,0,0,1);query.resolve(f.status());await Promise.all([refreshing,sameScore]);
    expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(player.generation).toBeGreaterThan(floor);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null,range:null,loop:null,practice:{settings:practice,phase:'idle'}});
    expect(f.prepare.mock.calls.at(-1)).toEqual([project,player.generation]);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)![1]).toEqual(vi.mocked(bridge.prepare).mock.calls[0][1]);expect(vi.mocked(bridge.command).mock.calls.some(([command])=>command.type==='play'||command.type==='playRange')).toBe(false);
    expect(()=>player.playFromCursor(cursor,oldChoice)).toThrow(/current performed occurrence/);f.event({generation:oldGeneration,playing:true});expect(player.getState().playing).toBe(false);
    player.play(cursor,player.cursorPlaybackChoices(cursor)[0]);await vi.waitFor(()=>expect(player.getState().playing).toBe(true));player.pause();await vi.waitFor(()=>expect(player.getState().playing).toBe(false));
    expect(f.onEdit).not.toHaveBeenCalled();expect(JSON.stringify(project)).toBe(source);expect(bridge.subscribe).toHaveBeenCalledOnce();
  }finally{player.destroy();}
});

it('resume fences an old plan while identical loads do not strand the fresh preparation',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;try{
    await player.loadDocument(project,built);const oldPlan=deferred<PlaybackPlan>(),freshPlan=deferred<PlaybackPlan>();
    const edited=previewEdit(project,{type:'setNote',target:cursor,string:6,fret:9},built);f.prepare.mockReturnValueOnce(oldPlan.promise).mockReturnValueOnce(freshPlan.promise);
    const oldLoading=player.loadDocument(edited.project,edited);await vi.waitFor(()=>expect(f.prepare).toHaveBeenCalledTimes(2));const stale=player.generation,floor=f.shutdown();
    const refreshing=player.loadDocument(edited.project,edited,0,0,1);await vi.waitFor(()=>expect(f.prepare).toHaveBeenCalledTimes(3));const fresh=player.generation;expect(fresh).toBeGreaterThan(floor);
    await player.loadDocument(edited.project,edited,1,0,1);oldPlan.resolve(buildPlaybackPlan(edited.score,stale));await oldLoading;
    expect(player.getState().ready).toBe(false);expect(bridge.prepare).toHaveBeenCalledTimes(1);expect(player.cursorPlaybackChoices(cursor)).toEqual([]);
    freshPlan.resolve(buildPlaybackPlan(edited.score,fresh));await refreshing;
    expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(vi.mocked(bridge.prepare).mock.calls.at(-1)![0].generation).toBe(fresh);expect(player.cursorPlaybackChoices(cursor)).toHaveLength(1);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});
  }finally{player.destroy();}
});

it('a late pre-resume mix rejection and stale epoch cannot replace the refreshed playback',async()=>{
  const f=fixture(),{player,project,built,bridge}=f;try{
    await player.loadDocument(project,built);const mix=deferred<void>();vi.mocked(bridge.setMix).mockReturnValueOnce(mix.promise);
    const mixed=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{gain:.4,pan:0,mute:false,solo:false}},built),mixing=player.loadDocument(mixed.project,mixed);await vi.waitFor(()=>expect(bridge.setMix).toHaveBeenCalledOnce());
    const floor=f.shutdown();await player.loadDocument(mixed.project,mixed,0,0,1);expect(player.generation).toBeGreaterThan(floor);const generation=player.generation;
    mix.reject(new Error('stale mix rejected'));await mixing;await player.loadDocument(project,built,0,0,0);
    expect(player.generation).toBe(generation);expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});expect(vi.mocked(bridge.prepare).mock.calls.at(-1)![1].mixes['base/0'].gain).toBe(.4);
  }finally{player.destroy();}
});

it('a score change during the floor query still prepares the latest score without another render',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;try{
    await player.loadDocument(project,built);f.shutdown();const query=deferred<NativeAudioStatus|null>();vi.mocked(bridge.status).mockReturnValueOnce(query.promise);
    const old=player.loadDocument(project,built,0,0,1);await vi.waitFor(()=>expect(bridge.status).toHaveBeenCalledTimes(3));
    player.beforeScoreChange();const edited=previewEdit(project,{type:'setNote',target:cursor,string:6,fret:9},built);
    const latest=player.loadDocument(edited.project,edited,0,0,1);query.resolve(f.status());await Promise.all([old,latest]);
    expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(f.prepare.mock.calls.at(-1)![0]).toBe(edited.project);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});
  }finally{player.destroy();}
});

it('newer resume fences an older floor query and a failed floor read can be retried',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;try{
    await player.loadDocument(project,built);f.shutdown();const query=deferred<NativeAudioStatus|null>();vi.mocked(bridge.status).mockReturnValueOnce(query.promise);
    const old=player.loadDocument(project,built,0,0,1);await vi.waitFor(()=>expect(bridge.status).toHaveBeenCalledTimes(3));
    const floor=f.shutdown();await player.loadDocument(project,built,0,0,2);const generation=player.generation;expect(generation).toBeGreaterThan(floor);
    query.resolve({...f.status(),generation:0,desiredGeneration:0,playing:true});await old;
    expect(player.generation).toBe(generation);expect(bridge.prepare).toHaveBeenCalledTimes(2);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});
    f.shutdown();vi.mocked(bridge.status).mockRejectedValueOnce(new Error('status unavailable'));await player.loadDocument(project,built,0,0,3);expect(player.getState()).toMatchObject({ready:false,playing:false,error:'status unavailable'});
    await player.loadDocument(project,built,0,0,3);expect(bridge.prepare).toHaveBeenCalledTimes(3);expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});
  }finally{player.destroy();}
});

it('a delayed old native prepare cannot retire the resumed plan',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;try{
    await player.loadDocument(project,built);const waiting=deferred<void>();
    vi.mocked(bridge.prepare).mockReturnValueOnce(waiting.promise);
    const edited=previewEdit(project,{type:'setNote',target:cursor,string:6,fret:9},built),old=player.loadDocument(edited.project,edited);await vi.waitFor(()=>expect(bridge.prepare).toHaveBeenCalledTimes(2));
    f.shutdown();await player.loadDocument(edited.project,edited,0,0,1);const generation=player.generation;expect(bridge.prepare).toHaveBeenCalledTimes(3);
    waiting.reject(new Error('old native preparation retired'));await old;
    expect(player.getState()).toMatchObject({ready:true,playing:false,error:null});expect(player.generation).toBe(generation);expect(player.cursorPlaybackChoices(cursor)).toHaveLength(1);
  }finally{player.destroy();}
});

it('destroyed retained player cannot publish a pending floor query or prepare again',async()=>{
  const f=fixture(),{player,bridge,project,built}=f;await player.loadDocument(project,built);f.shutdown();const query=deferred<NativeAudioStatus|null>();vi.mocked(bridge.status).mockReturnValueOnce(query.promise);
  const pending=player.loadDocument(project,built,0,0,1);await vi.waitFor(()=>expect(bridge.status).toHaveBeenCalledTimes(3));player.destroy();const state=player.getState();query.resolve(f.status());await pending;
  expect(bridge.prepare).toHaveBeenCalledOnce();expect(player.getState()).toBe(state);expect(player.cursorPlaybackChoices(cursor)).toEqual([]);
});
