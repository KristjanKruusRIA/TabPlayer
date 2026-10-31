import {afterEach,expect,it,vi} from 'vitest';
import {model} from '@coderline/alphatab';
import * as engine from '../engine';
import {blankProject} from '../project';
import type {NativeAudioBridge} from './bridge';
import {NativePlaybackController} from './NativePlaybackController';
import {buildPlaybackPlan,buildPlaybackPlanFromJson} from './plan';

function bridge():NativeAudioBridge{return {prepare:vi.fn(async()=>{}),command:vi.fn(async()=>{}),setMix:vi.fn(async()=>{}),devices:vi.fn(async()=>[]),status:vi.fn(async()=>null),subscribe:vi.fn(async()=>()=>{}),stageBacking:vi.fn(async()=>null),stageEmbeddedBacking:vi.fn(async()=>null)};}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('default preparation serializes the existing canonical score without rebuilding the project',async()=>{
  const project=blankProject(),built=engine.buildDocument(project),source=model.JsonConverter.scoreToJson(built.score),requests:unknown[]=[];
  class WorkerFixture{onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:ErrorEvent)=>void)|null=null;postMessage(data:{cmd:string;json:string;identities:string[];generation:number}){requests.push(data);queueMicrotask(()=>this.onmessage?.({data:{cmd:'tabplayer.plan.result',plan:buildPlaybackPlanFromJson(data.json,data.identities,data.generation)}} as MessageEvent));}terminate(){}}
  vi.stubGlobal('Worker',WorkerFixture);const rebuild=vi.spyOn(engine,'buildScore'),native=bridge(),player=new NativePlaybackController({bridge:native,onEdit:vi.fn()});try{await player.loadDocument(project,built);expect(rebuild).not.toHaveBeenCalled();expect(requests).toEqual([{cmd:'tabplayer.plan.prepare',json:source,identities:['base/0'],generation:player.generation}]);expect(native.prepare).toHaveBeenCalledOnce();expect(model.JsonConverter.scoreToJson(built.score)).toBe(source);}finally{player.destroy();}
});
it('injected preparation keeps its exact two-argument project and generation contract',async()=>{
  const project=blankProject(),built=engine.buildDocument(project),prepare=vi.fn(async(_project:typeof project,generation:number)=>buildPlaybackPlan(built.score,generation)),native=bridge(),player=new NativePlaybackController({bridge:native,onEdit:vi.fn(),preparePlan:prepare});try{await player.loadDocument(project,built);expect(prepare).toHaveBeenCalledWith(project,player.generation);expect(prepare.mock.calls[0]).toHaveLength(2);expect(native.prepare).toHaveBeenCalledOnce();}finally{player.destroy();}
});
