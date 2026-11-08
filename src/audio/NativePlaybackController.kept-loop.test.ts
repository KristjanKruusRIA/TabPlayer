import {expect,it,vi} from 'vitest';
import {buildDocument,previewEdit} from '../engine';
import {barMapOfEdit} from '../editor/edit-bar-map';
import type {EditCommand} from '../edit-types';
import {blankProject} from '../project';
import {NativePlaybackController} from './NativePlaybackController';
import type {NativeAudioBridge,NativeAudioStatus} from './bridge';
import {buildPlaybackPlan} from './plan';
import {DEFAULT_PRACTICE} from './practice-types';

const note:EditCommand={type:'setNote',target:{track:0,staff:0,bar:1,voice:0,beat:0},string:6,fret:7};
const BAR=3840;
function fixture(){
  const project=blankProject(),built=buildDocument(project);
  let receive:(status:NativeAudioStatus)=>void=()=>{},floor=0;
  // `loop` holds the next setLoop command before native answers it; `prepare` holds the next prepare. Each is used once.
  const gate:{loop:Promise<void>|null;prepare:Promise<void>|null}={loop:null,prepare:null};
  let status:NativeAudioStatus={generation:0,desiredGeneration:0,ready:false,playing:false,tick:0,seconds:0,durationSeconds:8,speed:1,metronome:false,error:null,deviceId:null,range:null,loop:null,practice:{settings:structuredClone(DEFAULT_PRACTICE),phase:'idle',countInRemaining:0,completedPasses:0,effectiveRatio:1,currentBpm:120,pulse:null}};
  const emit=(patch:Partial<NativeAudioStatus>)=>{status={...status,...patch};receive(status);};
  // Like the native renderer, a prepared plan starts with no loop, and a loop is acknowledged as a status.
  const bridge:NativeAudioBridge={
    prepare:vi.fn(async(plan,_settings,_embedded,_sourceKey,practice)=>{const held=gate.prepare;gate.prepare=null;if(held)await held;floor=plan.generation;emit({generation:floor,desiredGeneration:floor,ready:true,playing:false,tick:0,range:null,loop:null,practice:{...status.practice,settings:structuredClone(practice!),phase:'idle'}});}),
    command:vi.fn(async command=>{
      if(command.type==='invalidate'){floor=Math.max(floor,command.generation);return;}
      if(command.type==='setLoop'){const held=gate.loop;gate.loop=null;if(held)await held;}
      if(command.generation!==floor||command.generation!==status.generation)throw new Error('Stale transport generation.');
      if(command.type==='setLoop')emit({loop:{startTick:command.startTick,endTick:command.endTick},tick:command.startTick});
      else if(command.type==='clearLoop')emit({loop:null});
    }),
    setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>status),subscribe:vi.fn(async listener=>{receive=listener;return()=>{};}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null),
  };
  const prepare=vi.fn(async(candidate:typeof project,generation:number)=>buildPlaybackPlan(buildDocument(candidate).score,generation));
  const player=new NativePlaybackController({bridge,onEdit:vi.fn(),preparePlan:prepare});
  /** What the editor does for an edit: tell the player first, then hand it the new document. */
  const apply=async(command:EditCommand,current:typeof project)=>{
    const before=buildDocument(current).score.masterBars.length,next=previewEdit(current,command).project;
    player.beforeScoreChange(true,barMapOfEdit(command,before)??undefined);await player.loadDocument(next,buildDocument(next));return next;
  };
  const setLoops=()=>vi.mocked(bridge.command).mock.calls.map(([command])=>command).filter(command=>command.type==='setLoop');
  const looping=()=>vi.waitFor(()=>expect(player.getState().loop).not.toBeNull());
  const hold=()=>{let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return {promise,release};};
  return {project,built,bridge,player,emit,apply,setLoops,looping,gate,hold};
}

it('keeps a loop through an edit inside its bars, on the new plan',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await vi.waitFor(()=>expect(f.player.getState().loop).toEqual({startTick:BAR,endTick:3*BAR}));
  const before=f.player.generation;vi.mocked(f.bridge.command).mockClear();
  await f.apply(note,f.project);
  expect(f.player.generation).toBeGreaterThan(before);
  expect(f.setLoops()).toEqual([{type:'setLoop',generation:f.player.generation,startTick:BAR,endTick:3*BAR}]);
  expect(f.player.getState()).toMatchObject({ready:true,loop:{startTick:BAR,endTick:3*BAR},loopNotice:null,error:null});
});

it('keeps a loop that begins and ends inside bars',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.emit({loop:{startTick:BAR+960,endTick:2*BAR+2880}});
  await f.apply(note,f.project);
  expect(f.player.getState().loop).toEqual({startTick:BAR+960,endTick:2*BAR+2880});
});

it('moves the loop to the same bars when bars are inserted before it',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  await f.apply({type:'insertMeasures',beforeBar:0,count:2},f.project);
  expect(f.player.getState().loop).toEqual({startTick:3*BAR,endTick:5*BAR});
});

it('keeps the loop when bars after it are removed, and trims it when one of its end bars is',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  const after=await f.apply({type:'removeMeasures',firstBar:3,lastBar:3},f.project);
  expect(f.player.getState().loop).toEqual({startTick:BAR,endTick:3*BAR});
  await f.apply({type:'removeMeasures',firstBar:2,lastBar:2},after);
  expect(f.player.getState()).toMatchObject({loop:{startTick:BAR,endTick:2*BAR},loopNotice:null});
});

it('clears the loop and says so when the edit removed its bars',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  vi.mocked(f.bridge.command).mockClear();
  await f.apply({type:'removeMeasures',firstBar:1,lastBar:2},f.project);
  expect(f.setLoops()).toEqual([]);
  expect(f.player.getState()).toMatchObject({ready:true,loop:null,loopNotice:'cleared'});
});

it('clears the loop and says so when the bars changed in a way it cannot follow',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  f.player.beforeScoreChange();
  const next=previewEdit(f.project,{type:'insertMeasures',beforeBar:0,count:1}).project;
  await f.player.loadDocument(next,buildDocument(next));
  expect(f.player.getState()).toMatchObject({loop:null,loopNotice:'cleared'});
});

it('does not bring back a loop the player cleared, or say anything about one that never ran',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  f.player.clearLoop();await vi.waitFor(()=>expect(f.player.getState().loop).toBeNull());
  vi.mocked(f.bridge.command).mockClear();
  const next=await f.apply(note,f.project);
  expect(f.setLoops()).toEqual([]);expect(f.player.getState()).toMatchObject({loop:null,loopNotice:null});
  await f.apply({type:'removeMeasures',firstBar:1,lastBar:2},next);
  expect(f.player.getState().loopNotice).toBeNull();
});

it('carries the loop through several edits that land before the plan is rebuilt',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  const one=previewEdit(f.project,{type:'insertMeasures',beforeBar:0,count:1}).project,two=previewEdit(one,{type:'insertMeasures',beforeBar:0,count:1}).project;
  f.player.beforeScoreChange(true,barMapOfEdit({type:'insertMeasures',beforeBar:0,count:1},4)!);
  f.player.beforeScoreChange(true,barMapOfEdit({type:'insertMeasures',beforeBar:0,count:1},5)!);
  await f.player.loadDocument(two,buildDocument(two));
  expect(f.player.getState().loop).toEqual({startTick:3*BAR,endTick:5*BAR});
});

it('drops the loop with its document',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built,0,1);
  f.player.setLoop(1,2);await f.looping();
  vi.mocked(f.bridge.command).mockClear();
  const other=previewEdit(f.project,note).project;
  f.player.beforeScoreChange();await f.player.loadDocument(other,buildDocument(other),0,2);
  expect(f.setLoops()).toEqual([]);expect(f.player.getState()).toMatchObject({loop:null,loopNotice:null});
});

it('clears the notice when a loop is set again, and keeps that loop through the next edit',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(1,2);await f.looping();
  const next=await f.apply({type:'removeMeasures',firstBar:1,lastBar:2},f.project);
  expect(f.player.getState().loopNotice).toBe('cleared');
  f.player.setLoop(0,0);await f.looping();
  expect(f.player.getState().loopNotice).toBeNull();
  await f.apply(note,next);expect(f.player.getState().loop).toEqual({startTick:0,endTick:BAR});
});

it('keeps the loop the player just set, not the one native still echoes, when an edit lands before the echo',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(0,1);await vi.waitFor(()=>expect(f.player.getState().loop).toEqual({startTick:0,endTick:2*BAR}));
  const held=f.hold();f.gate.loop=held.promise;
  f.player.setLoop(2,2);
  vi.mocked(f.bridge.command).mockClear();
  await f.apply(note,f.project);held.release();
  expect(f.setLoops()).toEqual([{type:'setLoop',generation:f.player.generation,startTick:2*BAR,endTick:3*BAR}]);
  expect(f.player.getState().loop).toEqual({startTick:2*BAR,endTick:3*BAR});
});

it('does not let a late status with the old loop undo a loop that was just set',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(0,1);await vi.waitFor(()=>expect(f.player.getState().loop).not.toBeNull());
  const held=f.hold();f.gate.loop=held.promise;
  f.player.setLoop(2,2);
  f.emit({loop:{startTick:0,endTick:2*BAR}});
  vi.mocked(f.bridge.command).mockClear();
  await f.apply(note,f.project);held.release();
  expect(f.player.getState().loop).toEqual({startTick:2*BAR,endTick:3*BAR});
});

it('keeps a loop set while the rebuilt plan is still being prepared',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(0,1);await vi.waitFor(()=>expect(f.player.getState().loop).not.toBeNull());
  const held=f.hold();f.gate.prepare=held.promise;
  const prepares=vi.mocked(f.bridge.prepare).mock.calls.length;
  const next=previewEdit(f.project,note).project;
  f.player.beforeScoreChange(true);const loading=f.player.loadDocument(next,buildDocument(next));
  await vi.waitFor(()=>expect(f.bridge.prepare).toHaveBeenCalledTimes(prepares+1));
  f.player.setLoop(2,2);
  held.release();await loading;
  expect(f.player.getState().loop).toEqual({startTick:2*BAR,endTick:3*BAR});
  // And it is still the kept one for the next edit.
  await f.apply(note,next);
  expect(f.player.getState().loop).toEqual({startTick:2*BAR,endTick:3*BAR});
});

it('a clear before the echo keeps nothing for the next edit',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(0,1);await vi.waitFor(()=>expect(f.player.getState().loop).not.toBeNull());
  f.player.clearLoop();
  vi.mocked(f.bridge.command).mockClear();
  await f.apply(note,f.project);
  expect(f.setLoops()).toEqual([]);expect(f.player.getState()).toMatchObject({loop:null,loopNotice:null});
});

it('does not lose the kept loop to a status without a loop that arrives while the loop is being sent again',async()=>{
  const f=fixture();await f.player.loadDocument(f.project,f.built);
  f.player.setLoop(0,1);await vi.waitFor(()=>expect(f.player.getState().loop).not.toBeNull());
  const held=f.hold();f.gate.loop=held.promise;
  const first=f.apply(note,f.project);
  await vi.waitFor(()=>expect(f.setLoops().length).toBeGreaterThan(1));
  // Native has not answered the restore yet and reports no loop; a second edit lands in that gap.
  f.emit({loop:null});
  const afterFirst=previewEdit(f.project,note).project;
  const second=f.apply({...note,fret:5},afterFirst);
  held.release();await Promise.all([first,second]);
  expect(f.player.getState().loop).toEqual({startTick:0,endTick:2*BAR});
  expect(f.setLoops().at(-1)).toEqual({type:'setLoop',generation:f.player.generation,startTick:0,endTick:2*BAR});
});
