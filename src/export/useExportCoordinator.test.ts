// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,renderHook,waitFor } from '@testing-library/react';
import { importer,Settings } from '@coderline/alphatab';
import { buildScore,previewEdit,trackIdentity } from '../engine';
import * as engine from '../engine';
import { blankProject } from '../project';
import { defaultDocumentSettings } from '../document-settings';
import { music,noteAt } from '../editor/fixtures';
import { useExportCoordinator } from './useExportCoordinator';
import type { ExportNativeBridge,NativeAudioExportPayload } from './bridge';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function native():ExportNativeBridge{return {exportPdf:async()=>null,exportMidi:async()=>true,exportAudio:async()=>null,status:async()=>null,cancel:async()=>{}};}
it('freezes GP music before awaiting confirmation and clears busy when destination cancels',async()=>{
  const score=buildScore(blankProject());score.title='Frozen title';let allow!:(v:boolean)=>void;let bytes:Uint8Array|undefined;
  const bridge={confirmExport:()=>new Promise<boolean>(r=>{allow=r;}),exportGp:async(data:Uint8Array)=>{bytes=data;return false;}};
  const api=native();const {result}=renderHook(()=>useExportCoordinator({score,settings:defaultDocumentSettings(),currentSpeed:1,bridge,native:api}));
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:null}});});
  expect(result.current.busy).toBe(true);score.title='Later title';allow(true);await act(async()=>{expect(await pending).toBe(false);});
  expect(result.current.busy).toBe(false);expect(importer.ScoreLoader.loadScoreFromBytes(bytes!,new Settings()).title).toBe('Frozen title');expect(score.title).toBe('Later title');
});
it('freezes the explicit phrase-slur origin before awaiting GP export confirmation',async()=>{
  const score=music(),origin=noteAt(score),destination=noteAt(score,2);destination.string=5;destination.fret=7;score.finish(new Settings());
  origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;
  const exported=vi.spyOn(engine,'exportGp');
  let allow!:(v:boolean)=>void;let bytes:Uint8Array|undefined;const bridge={confirmExport:()=>new Promise<boolean>(resolve=>{allow=resolve;}),exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native();const settings=defaultDocumentSettings();const {result}=renderHook(()=>useExportCoordinator({score,settings,currentSpeed:1,bridge,native:api}));
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:{first:0,last:2}}});});
  origin.slurDestination=null;destination.slurOrigin=null;destination.isSlurDestination=false;allow(true);await act(async()=>{expect(await pending).toBe(true);});
  const frozen=exported.mock.calls[0][0];expect(noteAt(frozen,2).slurOrigin?.id).toBe(origin.id);expect(noteAt(frozen,2).slurOrigin===noteAt(frozen)).toBe(true);expect(frozen).not.toBe(score);
  const reopened=importer.ScoreLoader.loadScoreFromBytes(bytes!,new Settings());expect(noteAt(reopened,2).string).toBe(5);expect(noteAt(reopened,2).fret).toBe(7);
  expect(destination.slurOrigin).toBeNull();expect(destination.isSlurDestination).toBe(false);
});
it('prepares selected audio with original stable identities frozen settings and acknowledged progress',async()=>{
  const project=previewEdit(blankProject(),{type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,28]}).project;
  const score=buildScore(project);const settings=defaultDocumentSettings();settings.mixes[trackIdentity(score.tracks[1])]={gain:.3,pan:.2,mute:false,solo:false};
  let payload:NativeAudioExportPayload|undefined;const api=native();api.exportAudio=async value=>{payload=value;return 'audio';};api.status=async()=>({id:'audio',frames:100,totalFrames:100,status:'complete'});
  const bridge={confirmExport:async()=>true,exportGp:async()=>true};const {result}=renderHook(()=>useExportCoordinator({score,settings,currentSpeed:.5,bridge,native:api,embeddedBacking:new Uint8Array([1,2,3])}));
  await act(async()=>{expect(await result.current.run({format:'stems',selection:{tracks:[1],range:{first:1,last:2}},audio:{sampleRate:44100,bitDepth:24,speed:'current',metronome:false,tailSeconds:.1,backing:true,includeMix:true}})).toBe(true);});
  expect(payload!.plan.tracks[1].id).toBe(trackIdentity(score.tracks[1]));expect(payload!.request.tracks[0].id).toBe(trackIdentity(score.tracks[1]));expect(payload!.request.speed).toBe(.5);expect(payload!.embeddedBytes).toEqual([1,2,3]);expect(payload!.stems).toBe(true);expect(payload!.settings.mixes[trackIdentity(score.tracks[1])].gain).toBe(.3);
  expect(result.current.progress?.status).toBe('complete');expect(result.current.busy).toBe(false);
});
it('waits for native cancellation acknowledgement and reports failed jobs as errors',async()=>{
  const score=buildScore(blankProject()),api=native();let cancelled=false;api.exportAudio=async()=> 'job';api.cancel=async()=>{cancelled=true;};api.status=async()=>({id:'job',frames:0,totalFrames:10,status:cancelled?'cancelled':'running'});
  const props={score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{confirmExport:async()=>true,exportGp:async()=>true},native:api};const {result}=renderHook(()=>useExportCoordinator(props));
  const options={format:'wav' as const,selection:{tracks:[0],range:null},audio:{sampleRate:48000 as const,bitDepth:16 as const,speed:'saved' as const,metronome:false,tailSeconds:0,backing:false,includeMix:false}};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run(options);});await waitFor(()=>expect(result.current.progress?.status).toBe('running'));
  await act(async()=>{await result.current.cancel();expect(await pending).toBe(false);});expect(result.current.busy).toBe(false);
  api.status=async()=>({id:'job',frames:0,totalFrames:10,status:'failed',error:'Disk full'});await act(async()=>{await expect(result.current.run(options)).rejects.toThrow('Disk full');});expect(result.current.busy).toBe(false);
});
