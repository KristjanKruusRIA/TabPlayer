import {expect,it,vi} from 'vitest';
import {model} from '@coderline/alphatab';
import {buildDocument} from '../engine';
import {blankProject} from '../project';
import type {BackingSettings} from '../edit-types';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import {DEFAULT_PRACTICE} from './practice-types';
import type {PlaybackPlan} from './types';

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

it.each([false,true])('settled processing and subsequent gain edits retain generation, source, notation and timing (reference=%s)',async reference=>{
 const initial=backing();if(!reference)delete initial.referenceSync;const f=fixture(initial),score=model.JsonConverter.scoreToJson(f.built.score);
 try{
  await f.player.loadDocument(f.project,f.built);const generation=f.player.generation,timeline=f.player.backingTimeline()!,value={...initial,processing:{semitones:2,cents:-25,filter:'bassEnhance' as const}};
  await f.player.loadDocument(f.project,f.next(value));
  expect(f.player.generation).toBe(generation);expect(f.prepare).toHaveBeenCalledOnce();expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(f.bridge.setMix).toHaveBeenCalledExactlyOnceWith(f.next(value).settings,generation);
  expect(f.player.backingTimeline()!.tempos).toBe(timeline.tempos);expect(f.player.backingTimeline()!.occurrences).toBe(timeline.occurrences);expect(value.assetId).toBe(initial.assetId);expect(value.anchors).toBe(initial.anchors);expect(value.referenceSync).toBe(initial.referenceSync);
  const gain={...value,mix:{...value.mix,gain:.25}};await f.player.loadDocument(f.project,f.next(gain));expect(f.bridge.setMix).toHaveBeenLastCalledWith(f.next(gain).settings,generation);expect(f.bridge.setMix).toHaveBeenCalledTimes(2);expect(f.bridge.prepare).toHaveBeenCalledOnce();expect(f.prepare).toHaveBeenCalledOnce();expect(f.player.generation).toBe(generation);
  expect(model.JsonConverter.scoreToJson(f.built.score)).toBe(score);expect(f.onEdit).not.toHaveBeenCalled();expect(vi.mocked(f.bridge.command).mock.calls.map(([command])=>command.type)).toEqual(['invalidate']);
 }finally{f.player.destroy();}
});
