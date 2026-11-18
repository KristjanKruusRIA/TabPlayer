import {expect,it,vi} from 'vitest';
import {buildDocument} from '../engine';
import {blankProject} from '../project';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import {buildPlaybackPlan} from './plan';
import {DEFAULT_PRACTICE} from './practice-types';

const BAR=3840;
const cursor={track:0,staff:0,bar:0,voice:0,beat:0};
/** A bridge whose status poll lags: loop commands are accepted (or refused) but the status shows them only when the test says so. */
function fixture(){
  const project=blankProject(),built=buildDocument(project);
  let receive:(status:NativeAudioStatus)=>void=()=>{};
  let refuse=false;
  let status:NativeAudioStatus={generation:0,desiredGeneration:0,ready:false,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null}};
  const emit=(patch:Partial<NativeAudioStatus>)=>{status={...status,...patch};receive(status);};
  const bridge:NativeAudioBridge={
    prepare:vi.fn(async(plan,_s,_e,_k,practice)=>{emit({generation:plan.generation,desiredGeneration:plan.generation,ready:true,playing:false,tick:0,range:null,loop:null,practice:{...status.practice,settings:structuredClone(practice!),phase:'idle'}});}),
    command:vi.fn(async command=>{
      if((command.type==='setLoop'||command.type==='clearLoop')&&refuse)throw new Error('Loop refused.');
    }),
    setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>status),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null),
  };
  const player=new NativePlaybackController({bridge,onEdit:vi.fn(),preparePlan:vi.fn(async(candidate:typeof project,generation:number)=>buildPlaybackPlan(buildDocument(candidate).score,generation))});
  const sent=()=>vi.mocked(bridge.command).mock.calls.map(([command])=>command.type).filter(type=>type!=='invalidate');
  return {project,built,player,emit,sent,refuse:(value:boolean)=>{refuse=value;}};
}
const settle=()=>new Promise<void>(done=>setTimeout(done,0));

it('plays the loop when Play comes before native has reported a loop that was just set',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);f.player.play(cursor);await settle();
  expect(f.sent()).toEqual(['setLoop','play']);
});

it('does not use a loop that was just cleared, though native still reports it',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.emit({loop:{startTick:BAR,endTick:3*BAR}});
  f.player.clearLoop();f.player.play(cursor);await settle();
  expect(f.sent()).toEqual(['clearLoop','playRange']);
});

it('falls back to the acknowledged state when native refuses the loop',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.refuse(true);f.player.setLoop(1,2);await settle();
  expect(f.player.getState().loop).toBeNull();
  f.refuse(false);f.player.play(cursor);await settle();
  expect(f.sent()).toEqual(['setLoop','playRange']);
});

it('adds no native call and follows native once it reports the loop',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await settle();
  f.emit({loop:{startTick:BAR,endTick:3*BAR}});
  f.emit({loop:null});
  f.player.play(cursor);await settle();
  expect(f.sent()).toEqual(['setLoop','playRange']);
});
