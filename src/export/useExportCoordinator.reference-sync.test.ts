// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import {model,Settings} from '@coderline/alphatab';
import {music} from '../editor/fixtures';
import {defaultDocumentSettings} from '../document-settings';
import {trackIdentity} from '../engine';
import type {ExportNativeBridge,NativeAudioExportPayload} from './bridge';
import {useExportCoordinator} from './useExportCoordinator';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const bridge={confirmExport:async()=>true,exportGp:async()=>true,readBackingAsset:async()=>{throw new Error('Audio export uses native source capture.');}};
function score120(){const score=music();score.masterBars=score.masterBars.slice(0,2);score.tracks[0].staves[0].bars=score.tracks[0].staves[0].bars.slice(0,2);score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,240,2)];score.finish(new Settings());return score;}
function settings(){return {...defaultDocumentSettings(),backing:{assetId:'a'.repeat(64),offsetMs:120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}],referenceSync:{entryAudioMs:1120,exitAudioMs:7120},mix:{gain:.7,pan:-.25,mute:false,solo:false}}};}
function native():ExportNativeBridge{return {exportPdf:async()=>null,exportMidi:async()=>true,exportMusicXml:async()=>true,exportSvg:async()=>true,exportPng:async()=>true,exportAudio:async()=> 'job',status:async()=>({id:'job',frames:1,totalFrames:1,status:'complete'}),cancel:async()=>{}};}

it.each([
  {format:'wav',includeBacking:true,speed:'saved',ratio:.5,wantSpeed:1},
  {format:'wav',includeBacking:false,speed:'current',ratio:.5,wantSpeed:.5},
  {format:'stems',includeBacking:true,speed:'current',ratio:.7,wantSpeed:.7},
  {format:'stems',includeBacking:false,speed:'saved',ratio:null,wantSpeed:1},
] as const)('exports $format at literal reference tempos with backing=$includeBacking and speed=$speed',async({format,includeBacking,speed,ratio,wantSpeed})=>{
  const score=score120(),stored=settings(),before=model.JsonConverter.scoreToJson(score),saved=structuredClone(stored),embedded=Uint8Array.of(1,2,3);let payload:NativeAudioExportPayload|undefined;
  const api=native();api.exportAudio=vi.fn(async value=>{payload=value;return 'job';});const {result}=renderHook(()=>useExportCoordinator({revision:19,score,settings:stored,embeddedBacking:embedded,currentSpeed:ratio,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format,selection:{tracks:[0],range:{first:1,last:1}},audio:{sampleRate:48000,bitDepth:24,speed,metronome:false,tailSeconds:.25,backing:includeBacking,includeMix:true}})).toBe(true);});
  expect(payload!.plan.tempos).toEqual([{tick:0,bpm:120},{tick:3840,bpm:60}]);expect(payload!.plan.occurrences.map(item=>[item.startTick,item.endTick,item.startMs,item.endMs])).toEqual([[0,3840,0,2000],[3840,7680,2000,6000]]);
  expect(payload!.plan.playbackEndTick).toBe(7680);expect(payload!.plan.durationMs).toBe(6000);expect(payload!.request).toMatchObject({range:{first:1,last:1},speed:wantSpeed,includeBacking,tailSeconds:.25});expect(payload!.stems).toBe(format==='stems');
  expect(payload!.settings).toEqual(saved);expect(payload!.settings).not.toBe(stored);expect(payload!.embeddedBytes).toEqual([1,2,3]);expect(api.exportAudio).toHaveBeenCalledWith(payload,19,expect.any(String));expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(stored).toEqual(saved);
});
it('freezes reference settings and embedded bytes while native audio capture is pending',async()=>{
  const score=score120(),stored=settings(),embedded=Uint8Array.of(1,2,3),api=native();let release!:(id:string)=>void,payload:NativeAudioExportPayload|undefined;
  api.exportAudio=async value=>{payload=value;return new Promise(resolve=>{release=resolve;});};const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:stored,embeddedBacking:embedded,currentSpeed:1,bridge,native:api}));let pending!:Promise<boolean>;
  act(()=>{pending=result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}});});
  stored.backing.referenceSync.exitAudioMs=9120;stored.backing.anchors[0].audioMs=4120;embedded.fill(9);score.masterBars[0].tempoAutomations[0].value=80;release('job');await act(async()=>{expect(await pending).toBe(true);});
  expect(payload!.plan.tempos).toEqual([{tick:0,bpm:120},{tick:3840,bpm:60}]);expect(payload!.plan.playbackEndTick).toBe(7680);expect(payload!.settings.backing?.referenceSync?.exitAudioMs).toBe(7120);expect(payload!.embeddedBytes).toEqual([1,2,3]);
});
it('keeps original track identities while selecting staves before reference timing',async()=>{
  const score=score120(),track=score.tracks[0],staff=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings()).tracks[0].staves[0];track.addStaff(staff);score.finish(new Settings());const stored=settings(),id=trackIdentity(track),api=native();let payload:NativeAudioExportPayload|undefined;api.exportAudio=async value=>{payload=value;return 'job';};
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:stored,currentSpeed:1,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format:'stems',selection:{tracks:[0],staves:{0:[1]},range:{first:1,last:1}},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).toBe(true);});
  expect(payload!.plan.tracks[0].id).toBe(id);expect(payload!.request.tracks[0].id).toBe(id);expect(new Set(payload!.plan.notes.map(note=>note.source.target.staff))).toEqual(new Set([0]));expect(payload!.plan.tempos).toEqual([{tick:0,bpm:120},{tick:3840,bpm:60}]);expect(score.tracks[0].staves).toHaveLength(2);
});
it('rejects a selected staff that changes reference pickup timing before native export',async()=>{
  const score=score120();score.masterBars[0].isAnacrusis=true;score.tracks[0].staves[0].bars[0].voices[0].beats.splice(1);
  const staff=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings()).tracks[0].staves[0];staff.bars[0].voices[0].beats[0].duration=model.Duration.Half;score.tracks[0].addStaff(staff);score.finish(new Settings());
  const stored=settings();stored.backing.anchors=[];const api=native();api.exportAudio=vi.fn(api.exportAudio);const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:stored,currentSpeed:1,bridge,native:api}));
  await act(async()=>{await expect(result.current.run({format:'wav',selection:{tracks:[0],staves:{0:[0]},range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).rejects.toThrow(/route|timing|pickup/i);});expect(api.exportAudio).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);
});
