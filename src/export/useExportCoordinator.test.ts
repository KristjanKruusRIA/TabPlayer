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
import { getTrackLyrics,applyLyricsEdit } from '../editor/lyrics';
import { loadInterchangeScore } from '../interchange/gp';
import * as pdf from './pdf';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('freezes custom page and engraving at launch and uses explicit export tracks',async()=>{
  const score=music(),settings=defaultDocumentSettings();settings.page={widthMm:250,heightMm:350,marginsMm:{top:12,right:22,bottom:32,left:42},scale:.8,profile:'document'};settings.engraving.stylesheet.hideDynamics=true;
  let release!:()=>void;vi.spyOn(pdf,'loadExportFonts').mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const renderPages=vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:250,heightMm:350,svg:'<svg/>'}]),api=native(),exportPdf=vi.fn(api.exportPdf);api.exportPdf=exportPdf;
  const {result}=renderHook(()=>useExportCoordinator({score,settings,currentSpeed:1,bridge:{confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'pdf',selection:{tracks:[0],range:null},layout,page:settings.page!});});
  settings.page.widthMm=300;settings.engraving.stylesheet.hideDynamics=false;release();await act(async()=>{await pending;});
  expect(renderPages).toHaveBeenCalledWith(expect.anything(),{tracks:[0],range:null},layout,{page:expect.objectContaining({widthMm:250}),engraving:expect.objectContaining({stylesheet:expect.objectContaining({hideDynamics:true})}),trackIds:['base/0']});
  expect(exportPdf).toHaveBeenCalledWith([{widthMm:250,heightMm:350,svg:'<svg/>'}],false);
});
it('honors explicit legacy export geometry when the caller omits a custom page',async()=>{
  const score=music(),settings=defaultDocumentSettings();vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();
  const renderPages=vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:279.4,heightMm:215.9,svg:'<svg/>'}]);
  const {result}=renderHook(()=>useExportCoordinator({score,settings,currentSpeed:1,bridge:{confirmExport:async()=>true,exportGp:async()=>true},native:native()})),layout={paper:'Letter' as const,orientation:'landscape' as const,marginMm:20,scale:.8,profile:'Score' as const};
  await act(async()=>{await result.current.run({format:'pdf',selection:{tracks:[0],range:null},layout});});
  expect(renderPages.mock.calls[0][3]?.page).toEqual({widthMm:279.4,heightMm:215.9,marginsMm:{top:20,right:20,bottom:20,left:20},scale:.8,profile:'Score'});
});
it.each([true,false])('freezes exact raw and hidden lyrics through the export dialog: visible=%s',async visible=>{
  const raw='[VERSE]\r\nHel-lo  world+today';
  const score=buildScore({...blankProject(),edits:[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:0},{type:'setTrackLyrics',track:0,visible,lines:[{startBar:0,text:raw}]}]});
  let allow!:(value:boolean)=>void,bytes:Uint8Array|undefined;
  const bridge={confirmExport:()=>new Promise<boolean>(resolve=>{allow=resolve;}),exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native(),{result}=renderHook(()=>useExportCoordinator({score,settings:defaultDocumentSettings(),currentSpeed:1,bridge,native:api}));
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:null}});});
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'Later'}]});allow(true);
  await act(async()=>{expect(await pending).toBe(true);});
  expect(getTrackLyrics(loadInterchangeScore(bytes!,new Settings()),0)).toEqual({visible,lines:[{startBar:0,text:raw}],source:'raw'});
  expect(getTrackLyrics(score,0).lines[0].text).toBe('Later');
});
function native():ExportNativeBridge{return {exportPdf:async()=>null,exportMidi:async()=>true,exportAudio:async()=>null,status:async()=>null,cancel:async()=>{}};}
it('rejects an unavailable current coefficient before launching or entering a native job',async()=>{
  const score=buildScore(blankProject()),api=native(),exportAudio=vi.fn(api.exportAudio);api.exportAudio=exportAudio;
  const bridge={confirmExport:async()=>true,exportGp:async()=>true};
  const {result}=renderHook(()=>useExportCoordinator({score,settings:defaultDocumentSettings(),currentSpeed:null,bridge,native:api}));
  await act(async()=>{await expect(result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'current',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).rejects.toThrow(/fixed BPM.*saved speed/i);});
  expect(exportAudio).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);expect(result.current.progress).toBeUndefined();
});
it('exports saved speed and interchange files when fixed BPM has no coefficient',async()=>{
  const score=buildScore(blankProject()),api=native();let payload:NativeAudioExportPayload|undefined, gp:Uint8Array|undefined, midi:Uint8Array|undefined;
  api.exportAudio=async value=>{payload=value;return 'saved';};api.status=async()=>({id:'saved',frames:1,totalFrames:1,status:'complete'});api.exportMidi=async bytes=>{midi=bytes;return true;};
  const bridge={confirmExport:async()=>true,exportGp:async(bytes:Uint8Array)=>{gp=bytes;return true;}};
  const {result}=renderHook(()=>useExportCoordinator({score,settings:defaultDocumentSettings(),currentSpeed:null,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).toBe(true);});
  expect(payload!.request.speed).toBe(1);expect(payload!.request.metronome).toBe(false);
  await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:null}})).toBe(true);});
  await act(async()=>{expect(await result.current.run({format:'midi',selection:{tracks:[0],range:null}})).toBe(true);});
  expect(importer.ScoreLoader.loadScoreFromBytes(gp!,new Settings()).masterBars).toHaveLength(4);expect(Array.from(midi!.slice(0,4))).toEqual([77,84,104,100]);
});
it('freezes one progressive coefficient and explicit audio options when the job starts',async()=>{
  const score=buildScore(blankProject()),api=native();let payload:NativeAudioExportPayload|undefined, finish!:(id:string)=>void;
  api.exportAudio=async value=>{payload=value;return new Promise<string>(resolve=>{finish=resolve;});};api.status=async()=>({id:'frozen',frames:1,totalFrames:1,status:'complete'});
  const bridge={confirmExport:async()=>true,exportGp:async()=>true},settings=defaultDocumentSettings();
  const {result,rerender}=renderHook(({ratio}:{ratio:number|null})=>useExportCoordinator({score,settings,currentSpeed:ratio,bridge,native:api}),{initialProps:{ratio:.7 as number|null}});
  const options={format:'wav' as const,selection:{tracks:[0],range:null},audio:{sampleRate:48000 as const,bitDepth:16 as const,speed:'current' as const,metronome:true,tailSeconds:0,backing:false,includeMix:false}};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run(options);});
  rerender({ratio:.9});options.audio.metronome=false;options.audio.tailSeconds=8;rerender({ratio:null});
  finish('frozen');await act(async()=>{expect(await pending).toBe(true);});
  expect(payload!.request.speed).toBe(.7);expect(payload!.request.metronome).toBe(true);expect(payload!.request.tailSeconds).toBe(0);
  expect(payload!.request).not.toHaveProperty('countIn');expect(payload!.request).not.toHaveProperty('practice');
});
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
