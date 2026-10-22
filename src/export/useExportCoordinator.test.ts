// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,renderHook,waitFor } from '@testing-library/react';
import { importer,model,Settings } from '@coderline/alphatab';
import { buildScore,previewEdit,trackIdentity } from '../engine';
import * as engine from '../engine';
import { blankProject } from '../project';
import { defaultDocumentSettings } from '../document-settings';
import { music,noteAt } from '../editor/fixtures';
import { useExportCoordinator } from './useExportCoordinator';
import type { ExportNativeBridge,NativeAudioExportPayload } from './bridge';
import type { ExportOptions,ExportProgress,SvgPage } from './types';
import { getTrackLyrics,applyLyricsEdit } from '../editor/lyrics';
import { loadInterchangeScore } from '../interchange/gp';
import * as pdf from './pdf';

function currentBacking(){return {assetId:'a'.repeat(64),offsetMs:120,anchors:[{bar:1,occurrence:0,ratio:0,audioMs:3120}],referenceSync:{entryAudioMs:1120,exitAudioMs:15120},mix:{gain:1,pan:0,mute:false,solo:false}};}
it('exports current committed backing bytes and the original full route at the captured revision',async()=>{
  const score=music();score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.of(1,2,3);
  const settings=defaultDocumentSettings();settings.backing=currentBacking();const before=model.JsonConverter.scoreToJson(score),saved=structuredClone(settings);
  let bytes:Uint8Array|undefined;const read=vi.fn(async()=>Uint8Array.of(9,8,7)),publish=vi.fn(async(value:Uint8Array,_revision:number)=>{bytes=value;return true;});
  const bridge={confirmExport:async()=>true,readBackingAsset:read,exportGp:publish};
  const api=native(),{result}=renderHook(()=>useExportCoordinator({revision:19,score,settings,currentSpeed:1,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:{first:1,last:1}}})).toBe(true);});
  expect(read).toHaveBeenCalledWith('a'.repeat(64),19);expect(publish).toHaveBeenCalledWith(expect.any(Uint8Array),19,expect.any(String));
  const reopened=loadInterchangeScore(bytes!,new Settings());expect(reopened.masterBars).toHaveLength(1);expect(reopened.backingTrack?.rawAudioFile).toEqual(Uint8Array.of(9,8,7));
  expect(reopened.exportFlatSyncPoints().map(point=>point.millisecondOffset)).toEqual([3000,7000]);expect(reopened.masterBars[0].tempoAutomations.map(point=>point.value)).toEqual([120]);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(settings).toEqual(saved);
});
it('freezes embedded bytes, current settings and selection before GP confirmation',async()=>{
  const score=music();score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.of(1,2,3);
  const embedded=Uint8Array.of(1,2,3),settings=defaultDocumentSettings();settings.backing={...currentBacking(),assetId:'embedded'};
  let allow!:(value:boolean)=>void,bytes:Uint8Array|undefined;const read=vi.fn(async()=>{throw new Error('Embedded backing must not be read.');});
  const bridge={confirmExport:()=>new Promise<boolean>(resolve=>{allow=resolve;}),readBackingAsset:read,exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native(),{result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,embeddedBacking:embedded,currentSpeed:1,bridge,native:api}));
  const options:ExportOptions={format:'gp',selection:{tracks:[0],range:{first:1,last:1}}};let pending!:Promise<boolean>;act(()=>{pending=result.current.run(options);});
  embedded.fill(4);score.backingTrack.rawAudioFile.fill(5);settings.backing.anchors[0].audioMs=5120;options.selection.range={first:2,last:3};allow(true);
  await act(async()=>{expect(await pending).toBe(true);});const reopened=loadInterchangeScore(bytes!,new Settings());
  expect(read).not.toHaveBeenCalled();expect(reopened.masterBars).toHaveLength(1);expect(reopened.backingTrack?.rawAudioFile).toEqual(Uint8Array.of(1,2,3));expect(reopened.exportFlatSyncPoints().map(point=>point.millisecondOffset)).toEqual([3000,7000]);
});
it('omits backing and all old sync points without reading or validating an invalid map',async()=>{
  const score=music();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.of(1,2,3);score.applyFlatSyncPoints([{barIndex:1,barOccurence:99,barPosition:.5,millisecondOffset:3000}]);
  const settings=defaultDocumentSettings();settings.backing={...currentBacking(),offsetMs:NaN,anchors:[{bar:999,occurrence:99,ratio:2,audioMs:-1}]};
  let bytes:Uint8Array|undefined;const read=vi.fn(async()=>{throw new Error('Omitted backing must not be read.');}),bridge={confirmExport:async()=>true,readBackingAsset:read,exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native(),{result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:{first:1,last:1}},backing:false})).toBe(true);});
  const reopened=loadInterchangeScore(bytes!,new Settings());expect(reopened.masterBars).toHaveLength(1);expect(reopened.backingTrack).toBeUndefined();expect(reopened.exportFlatSyncPoints()).toEqual([]);expect(read).not.toHaveBeenCalled();
});
it.each(['cancel','unmount'] as const)('does not publish GP after a delayed backing read and %s',async action=>{
  const settings=defaultDocumentSettings();settings.backing=currentBacking();let release!:(bytes:Uint8Array)=>void;
  const read=vi.fn(()=>new Promise<Uint8Array>(resolve=>{release=resolve;})),publish=vi.fn(async()=>true),bridge={confirmExport:async()=>true,readBackingAsset:read,exportGp:publish};
  const score=music(),api=native(),{result,unmount}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge,native:api}));let pending!:Promise<boolean>,cancelling:Promise<void>|undefined;
  await act(async()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:null}});});expect(read).toHaveBeenCalledWith('a'.repeat(64),7);
  act(()=>{if(action==='cancel')cancelling=result.current.cancel();else unmount();});
  await act(async()=>{release(Uint8Array.of(9,8,7));expect(await pending).toBe(false);await cancelling;});expect(publish).not.toHaveBeenCalled();
});
it('rejects a stale backing read before GP publication',async()=>{
  const settings=defaultDocumentSettings();settings.backing=currentBacking();const publish=vi.fn(async()=>true),bridge={confirmExport:async()=>true,readBackingAsset:vi.fn(async()=>{throw new Error('Backing asset revision is stale.');}),exportGp:publish};
  const score=music(),api=native(),{result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge,native:api}));
  await act(async()=>{await expect(result.current.run({format:'gp',selection:{tracks:[0],range:null}})).rejects.toThrow(/stale/);});expect(publish).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);
});
it('validates GP selection before confirmation or current backing reads',async()=>{
  const settings=defaultDocumentSettings();settings.backing=currentBacking();const bridge={confirmExport:vi.fn(async()=>true),readBackingAsset:vi.fn(async()=>Uint8Array.of(9,8,7)),exportGp:vi.fn(async()=>true)};
  const score=music(),api=native(),{result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge,native:api}));
  await act(async()=>{await expect(result.current.run({format:'gp',selection:{tracks:[99],range:null}})).rejects.toThrow(/existing tracks/);});expect(bridge.confirmExport).not.toHaveBeenCalled();expect(bridge.readBackingAsset).not.toHaveBeenCalled();expect(bridge.exportGp).not.toHaveBeenCalled();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('freezes custom page and engraving at launch and uses explicit export tracks',async()=>{
  const score=music(),settings=defaultDocumentSettings();settings.page={widthMm:250,heightMm:350,marginsMm:{top:12,right:22,bottom:32,left:42},scale:.8,profile:'document'};settings.engraving.stylesheet.hideDynamics=true;
  let release!:()=>void;vi.spyOn(pdf,'loadExportFonts').mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const renderPages=vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:250,heightMm:350,svg:'<svg/>'}]),api=native(),exportPdf=vi.fn(api.exportPdf);api.exportPdf=exportPdf;
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'pdf',selection:{tracks:[0],range:null},layout,page:settings.page!});});
  settings.page.widthMm=300;settings.engraving.stylesheet.hideDynamics=false;release();await act(async()=>{await pending;});
  expect(renderPages).toHaveBeenCalledWith(expect.anything(),{tracks:[0],range:null},layout,{page:expect.objectContaining({widthMm:250}),engraving:expect.objectContaining({stylesheet:expect.objectContaining({hideDynamics:true})}),trackIds:['base/0']});
  expect(exportPdf).toHaveBeenCalledWith([{widthMm:250,heightMm:350,svg:'<svg/>'}],false,7,expect.any(String));
});
it('honors explicit legacy export geometry when the caller omits a custom page',async()=>{
  const score=music(),settings=defaultDocumentSettings();vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();
  const renderPages=vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:279.4,heightMm:215.9,svg:'<svg/>'}]);
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:native()})),layout={paper:'Letter' as const,orientation:'landscape' as const,marginMm:20,scale:.8,profile:'Score' as const};
  await act(async()=>{await result.current.run({format:'pdf',selection:{tracks:[0],range:null},layout});});
  expect(renderPages.mock.calls[0][3]?.page).toEqual({widthMm:279.4,heightMm:215.9,marginsMm:{top:20,right:20,bottom:20,left:20},scale:.8,profile:'Score'});
});
it.each([true,false])('freezes exact raw and hidden lyrics through the export dialog: visible=%s',async visible=>{
  const raw='[VERSE]\r\nHel-lo  world+today';
  const score=buildScore({...blankProject(),edits:[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:0},{type:'setTrackLyrics',track:0,visible,lines:[{startBar:0,text:raw}]}]});
  let allow!:(value:boolean)=>void,bytes:Uint8Array|undefined;
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:()=>new Promise<boolean>(resolve=>{allow=resolve;}),exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native(),{result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge,native:api}));
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:null}});});
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'Later'}]});allow(true);
  await act(async()=>{expect(await pending).toBe(true);});
  expect(getTrackLyrics(loadInterchangeScore(bytes!,new Settings()),0)).toEqual({visible,lines:[{startBar:0,text:raw}],source:'raw'});
  expect(getTrackLyrics(score,0).lines[0].text).toBe('Later');
});
function native():ExportNativeBridge{return {exportPdf:async()=>null,exportMidi:async()=>true,exportMusicXml:async()=>true,exportSvg:async()=>true,exportPng:async()=>true,exportAudio:async()=>null,status:async()=>null,cancel:async()=>{}};}
it('rejects an unavailable current coefficient before launching or entering a native job',async()=>{
  const score=buildScore(blankProject()),api=native(),exportAudio=vi.fn(api.exportAudio);api.exportAudio=exportAudio;
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true};
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:null,bridge,native:api}));
  await act(async()=>{await expect(result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'current',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).rejects.toThrow(/fixed BPM.*saved speed/i);});
  expect(exportAudio).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);expect(result.current.progress).toBeUndefined();
});
it('exports saved speed and interchange files when fixed BPM has no coefficient',async()=>{
  const score=buildScore(blankProject()),api=native();let payload:NativeAudioExportPayload|undefined, gp:Uint8Array|undefined, midi:Uint8Array|undefined;
  api.exportAudio=async value=>{payload=value;return 'saved';};api.status=async()=>({id:'saved',frames:1,totalFrames:1,status:'complete'});api.exportMidi=async bytes=>{midi=bytes;return true;};
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async(bytes:Uint8Array)=>{gp=bytes;return true;}};
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:null,bridge,native:api}));
  await act(async()=>{expect(await result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}})).toBe(true);});
  expect(payload!.request.speed).toBe(1);expect(payload!.request.metronome).toBe(false);
  await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:null}})).toBe(true);});
  await act(async()=>{expect(await result.current.run({format:'midi',selection:{tracks:[0],range:null}})).toBe(true);});
  expect(importer.ScoreLoader.loadScoreFromBytes(gp!,new Settings()).masterBars).toHaveLength(4);expect(Array.from(midi!.slice(0,4))).toEqual([77,84,104,100]);
});
it('freezes one progressive coefficient and explicit audio options when the job starts',async()=>{
  const score=buildScore(blankProject()),api=native();let payload:NativeAudioExportPayload|undefined, finish!:(id:string)=>void;
  api.exportAudio=async value=>{payload=value;return new Promise<string>(resolve=>{finish=resolve;});};api.status=async()=>({id:'frozen',frames:1,totalFrames:1,status:'complete'});
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},settings=defaultDocumentSettings();
  const {result,rerender}=renderHook(({ratio}:{ratio:number|null})=>useExportCoordinator({revision:7,score,settings,currentSpeed:ratio,bridge,native:api}),{initialProps:{ratio:.7 as number|null}});
  const options={format:'wav' as const,selection:{tracks:[0],range:null},audio:{sampleRate:48000 as const,bitDepth:16 as const,speed:'current' as const,metronome:true,tailSeconds:0,backing:false,includeMix:false}};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run(options);});
  rerender({ratio:.9});options.audio.metronome=false;options.audio.tailSeconds=8;rerender({ratio:null});
  finish('frozen');await act(async()=>{expect(await pending).toBe(true);});
  expect(payload!.request.speed).toBe(.7);expect(payload!.request.metronome).toBe(true);expect(payload!.request.tailSeconds).toBe(0);
  expect(payload!.request).not.toHaveProperty('countIn');expect(payload!.request).not.toHaveProperty('practice');
});
it('freezes GP music before awaiting confirmation and clears busy when destination cancels',async()=>{
  const score=buildScore(blankProject());score.title='Frozen title';let allow!:(v:boolean)=>void;let bytes:Uint8Array|undefined;
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:()=>new Promise<boolean>(r=>{allow=r;}),exportGp:async(data:Uint8Array)=>{bytes=data;return false;}};
  const api=native();const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge,native:api}));
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run({format:'gp',selection:{tracks:[0],range:null}});});
  expect(result.current.busy).toBe(true);score.title='Later title';allow(true);await act(async()=>{expect(await pending).toBe(false);});
  expect(result.current.busy).toBe(false);expect(importer.ScoreLoader.loadScoreFromBytes(bytes!,new Settings()).title).toBe('Frozen title');expect(score.title).toBe('Later title');
});
it('freezes the explicit phrase-slur origin before awaiting GP export confirmation',async()=>{
  const score=music(),origin=noteAt(score),destination=noteAt(score,2);destination.string=5;destination.fret=7;score.finish(new Settings());
  origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;
  const exported=vi.spyOn(engine,'exportGp');
  let allow!:(v:boolean)=>void;let bytes:Uint8Array|undefined;const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:()=>new Promise<boolean>(resolve=>{allow=resolve;}),exportGp:async(value:Uint8Array)=>{bytes=value;return true;}};
  const api=native();const settings=defaultDocumentSettings();const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:1,bridge,native:api}));
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
  const bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true};const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings,currentSpeed:.5,bridge,native:api,embeddedBacking:new Uint8Array([1,2,3])}));
  await act(async()=>{expect(await result.current.run({format:'stems',selection:{tracks:[1],range:{first:1,last:2}},audio:{sampleRate:44100,bitDepth:24,speed:'current',metronome:false,tailSeconds:.1,backing:true,includeMix:true}})).toBe(true);});
  expect(payload!.plan.tracks[1].id).toBe(trackIdentity(score.tracks[1]));expect(payload!.request.tracks[0].id).toBe(trackIdentity(score.tracks[1]));expect(payload!.request.speed).toBe(.5);expect(payload!.embeddedBytes).toEqual([1,2,3]);expect(payload!.stems).toBe(true);expect(payload!.settings.mixes[trackIdentity(score.tracks[1])].gain).toBe(.3);
  expect(result.current.progress?.status).toBe('complete');expect(result.current.busy).toBe(false);
});
it('waits for native cancellation acknowledgement and reports failed jobs as errors',async()=>{
  const score=buildScore(blankProject()),api=native();let cancelled=false;api.exportAudio=async()=> 'job';api.cancel=async()=>{cancelled=true;};api.status=async()=>({id:'job',frames:0,totalFrames:10,status:cancelled?'cancelled':'running'});
  const props={revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api};const {result}=renderHook(()=>useExportCoordinator(props));
  const options={format:'wav' as const,selection:{tracks:[0],range:null},audio:{sampleRate:48000 as const,bitDepth:16 as const,speed:'saved' as const,metronome:false,tailSeconds:0,backing:false,includeMix:false}};
  let pending!:Promise<boolean>;act(()=>{pending=result.current.run(options);});await waitFor(()=>expect(result.current.progress?.status).toBe('running'));
  await act(async()=>{await result.current.cancel();expect(await pending).toBe(false);});expect(result.current.busy).toBe(false);
  api.status=async()=>({id:'job',frames:0,totalFrames:10,status:'failed',error:'Disk full'});await act(async()=>{await expect(result.current.run(options)).rejects.toThrow('Disk full');});expect(result.current.busy).toBe(false);
});

it.each(['gp','midi','musicxml','pdf','print','svg','png','wav','stems'] as const)('captures a coherent explicit source and revision for %s',async format=>{
  const old=music(),score=music();old.title='Old';score.title='Latest';
  const settings=defaultDocumentSettings();settings.mixes['base/0']={gain:.2,pan:0,mute:false,solo:false};
  const api=native(),gp=vi.fn(async(_bytes:Uint8Array,_revision:number)=>true),bridge={readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:gp};
  api.exportMidi=vi.fn(async()=>true);api.exportMusicXml=vi.fn(async()=>true);api.exportSvg=vi.fn(async()=>true);api.exportPng=vi.fn(async()=>true);api.exportPdf=vi.fn(async()=> 'job');api.exportAudio=vi.fn(async()=> 'job');
  api.status=async()=>({id:'job',frames:1,totalFrames:1,status:'complete'});
  vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();const pages=vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:210,heightMm:297,svg:'<svg/>'}]);
  const {result}=renderHook(()=>useExportCoordinator({revision:1,score:old,settings:defaultDocumentSettings(),currentSpeed:1,bridge,native:api}));
  const source={score,settings,embeddedBacking:Uint8Array.of(5,6),revision:19};
  const options:ExportOptions=format==='wav'||format==='stems'?{format,selection:{tracks:[0],range:null},audio:{sampleRate:48000 as const,bitDepth:16 as const,speed:'saved' as const,metronome:false,tailSeconds:0,backing:true,includeMix:false}}:format==='pdf'||format==='print'?{format,selection:{tracks:[0],range:null},layout:{paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'Score' as const}}:format==='svg'?{format,selection:{tracks:[0],range:null},layout:{paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'Score' as const},transparent:false}:format==='png'?{format,selection:{tracks:[0],range:null},layout:{paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'Score' as const},transparent:false,dpi:300}:{format,selection:{tracks:[0],range:null}};
  await act(async()=>{expect(await result.current.run(options,source)).toBe(true);});
  if(format==='gp'){expect(gp).toHaveBeenCalledWith(expect.any(Uint8Array),19,'Latest');expect(loadInterchangeScore(gp.mock.calls[0][0],new Settings()).title).toBe('Latest');}
  else if(format==='midi')expect(api.exportMidi).toHaveBeenCalledWith(expect.any(Uint8Array),19,'Latest');
  else if(format==='musicxml'){const [bytes,revision]=vi.mocked(api.exportMusicXml).mock.calls[0];expect(ArrayBuffer.isView(bytes)).toBe(true);expect(revision).toBe(19);expect(loadInterchangeScore(bytes,new Settings()).title).toBe('Latest');}
  else if(format==='svg'){expect(api.exportSvg).toHaveBeenCalledWith(expect.any(Array),19,'Latest');expect(pages.mock.calls[0][0].title).toBe('Latest');}
  else if(format==='png'){expect(api.exportPng).toHaveBeenCalledWith(expect.any(Array),300,19,'Latest');expect(pages.mock.calls[0][0].title).toBe('Latest');}
  else if(format==='pdf'||format==='print'){expect(api.exportPdf).toHaveBeenCalledWith(expect.any(Array),format==='print',19,format==='print'?null:'Latest');expect(pages.mock.calls[0][0].title).toBe('Latest');}
  else expect(api.exportAudio).toHaveBeenCalledWith(expect.objectContaining({settings,embeddedBytes:[5,6],stems:format==='stems'}),19,'Latest');
});
it('leaves embedded backing audio out of MusicXML without touching the live score',async()=>{
  const score=music();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.of(1,2,3);score.masterBars[0].syncPoints=[Object.assign(new model.Automation(),{type:model.AutomationType.SyncPoint,ratioPosition:0,syncPointValue:Object.assign(new model.SyncPointData(),{millisecondOffset:0})})];
  const before=model.JsonConverter.scoreToJson(score),api=native(),save=vi.fn(async(_bytes:Uint8Array,_revision:number)=>true);api.exportMusicXml=save;
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  await act(async()=>{expect(await result.current.run({format:'musicxml',selection:{tracks:[0],range:null}})).toBe(true);});
  const reopened=loadInterchangeScore(save.mock.calls[0][0],new Settings());expect(reopened.backingTrack).toBeFalsy();expect(reopened.masterBars.every(bar=>!bar.syncPoints?.length)).toBe(true);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it.each([false,true])('writes SVG pages with a white background unless transparent is %s',async transparent=>{
  const score=music(),before=model.JsonConverter.scoreToJson(score),api=native(),save=vi.fn(async(_pages:SvgPage[],_revision:number)=>true);api.exportSvg=save;
  vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:210,heightMm:297,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123"><style>.at{}</style><text>1</text></svg>'}]);
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  await act(async()=>{expect(await result.current.run({format:'svg',selection:{tracks:[0],range:null},layout:{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'Score'},transparent})).toBe(true);});
  const [[pages,revision]]=save.mock.calls;expect(revision).toBe(7);expect(pages).toHaveLength(1);
  const background=/<rect [^>]*fill="#fff"/;if(transparent)expect(pages[0].svg).not.toMatch(background);else expect(pages[0].svg).toMatch(/^<svg[^>]*><rect width="100%" height="100%" fill="#fff"\/><style>/);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it.each([false,true])('rasterizes PNG pages at the chosen resolution with a white background unless transparent is %s',async transparent=>{
  const score=music(),before=model.JsonConverter.scoreToJson(score),api=native(),save=vi.fn(async(_pages:SvgPage[],_dpi:number,_revision:number)=>true);api.exportPng=save;
  vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:210,heightMm:297,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123"><style>.at{}</style><text>1</text></svg>'}]);
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  await act(async()=>{expect(await result.current.run({format:'png',selection:{tracks:[0],range:null},layout:{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'Score'},transparent,dpi:150})).toBe(true);});
  const [[pages,dpi,revision]]=save.mock.calls;expect(dpi).toBe(150);expect(revision).toBe(7);expect(pages).toHaveLength(1);
  const background=/<rect [^>]*fill="#fff"/;if(transparent)expect(pages[0].svg).not.toMatch(background);else expect(pages[0].svg).toMatch(/^<svg[^>]*><rect width="100%" height="100%" fill="#fff"\/><style>/);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it.each([[[{widthMm:1000,heightMm:1000}],'too large for that resolution. Choose a lower resolution.'],[Array.from({length:50},()=>({widthMm:210,heightMm:297})),'fewer pages']] as const)('refuses an oversized PNG export before opening the native save dialog',async(sizes,message)=>{
  const api=native(),save=vi.fn(async()=>true);api.exportPng=save;
  vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();vi.spyOn(pdf,'renderPdfPages').mockReturnValue(sizes.map(size=>({...size,svg:'<svg/>'})));
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score:music(),settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  await act(async()=>{await expect(result.current.run({format:'png',selection:{tracks:[0],range:null},layout:{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'Score'},transparent:false,dpi:600})).rejects.toThrow(message);});
  expect(save).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);
});
it('expands the file-name template from the frozen copy and selection when the export runs',async()=>{
  vi.useFakeTimers({now:new Date(2026,2,30,13,3),toFake:['Date']});
  try{
    const score=music();score.title='Anatole';score.tracks[0].name='Lead';const api=native(),save=vi.fn(async()=>true);api.exportMidi=save;
    const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
    await act(async()=>{expect(await result.current.run({format:'midi',selection:{tracks:[0],range:null},fileName:'%T/%t %n of %N %d %h'})).toBe(true);});
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array),7,`Anatole-Lead 1 of ${score.tracks.length} 2026-03-30 13-03`);
  }finally{vi.useRealTimers();}
});
it('refuses unsupported MusicXML notation before opening the native save dialog',async()=>{
  const score=music();score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(true,0,120,2)];
  const api=native(),save=vi.fn(async()=>true);api.exportMusicXml=save;
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  await act(async()=>{await expect(result.current.run({format:'musicxml',selection:{tracks:[0],range:null}})).rejects.toThrow('MusicXML export does not support gradual tempo changes yet.');});
  expect(save).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);
});
it.each(['pdf','print','wav','stems'] as const)('cancel before a late %s job id waits for cancellation and native terminal state',async format=>{
  const api=native();let create!:(id:string)=>void,ack!:()=>void,terminal!:(state:Awaited<ReturnType<ExportNativeBridge['status']>>)=>void;
  api.exportAudio=()=>new Promise(resolve=>{create=resolve;});api.exportPdf=()=>new Promise(resolve=>{create=resolve;});
  vi.spyOn(pdf,'loadExportFonts').mockResolvedValue();vi.spyOn(pdf,'renderPdfPages').mockReturnValue([{widthMm:210,heightMm:297,svg:'<svg/>'}]);
  api.cancel=vi.fn(()=>new Promise<void>(resolve=>{ack=resolve;}));
  api.status=vi.fn(()=>new Promise<ExportProgress|null>(resolve=>{terminal=resolve;}));
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score:music(),settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  let pending!:Promise<boolean>,cancelling!:Promise<void>,resolved=false;
  const options:ExportOptions=format==='pdf'||format==='print'?{format,selection:{tracks:[0],range:null},layout:{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'Score'}}:{format,selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}};
  await act(async()=>{pending=result.current.run(options);});
  act(()=>{cancelling=result.current.cancel().then(()=>{resolved=true;});});
  await act(async()=>{await Promise.resolve();});expect(resolved).toBe(false);expect(result.current.busy).toBe(true);
  await act(async()=>{create('late');});expect(api.cancel).toHaveBeenCalledWith('late');expect(resolved).toBe(false);
  await act(async()=>{ack();});expect(api.status).toHaveBeenCalledWith('late');expect(resolved).toBe(false);expect(result.current.busy).toBe(true);
  await act(async()=>{terminal({id:'late',frames:0,totalFrames:10,status:'cancelled'});expect(await pending).toBe(false);await cancelling;});
  expect(resolved).toBe(true);expect(result.current.busy).toBe(false);expect(api.cancel).toHaveBeenCalledTimes(1);
});

it('keeps a terminal export failure primary when cancellation also fails',async()=>{
  const api=native();let terminal!:(state:Awaited<ReturnType<ExportNativeBridge['status']>>)=>void;
  api.exportAudio=async()=> 'failed';api.status=()=>new Promise(resolve=>{terminal=resolve;});api.cancel=async()=>{throw new Error('Cancel unavailable');};
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score:music(),settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  let pending!:Promise<boolean>,cancelling!:Promise<void>,settled=false;
  await act(async()=>{pending=result.current.run({format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}});});
  act(()=>{cancelling=result.current.cancel();void cancelling.catch(()=>{settled=true;});});
  await act(async()=>{await Promise.resolve();});expect(settled).toBe(false);expect(result.current.busy).toBe(true);
  await act(async()=>{terminal({id:'failed',frames:0,totalFrames:10,status:'failed',error:'Disk full'});await expect(pending).rejects.toThrow('Disk full');await expect(cancelling).rejects.toThrow('Cancel unavailable');});
  expect(result.current.busy).toBe(false);
});

it.each(['cancelled','complete','failed'] as const)('known job %s terminal waits for outstanding cancel acknowledgement before settling run',async status=>{
  const api=native();let terminal!:(state:Awaited<ReturnType<ExportNativeBridge['status']>>)=>void,ack!:()=>void;
  api.exportAudio=async()=> 'known';api.status=()=>new Promise(resolve=>{terminal=resolve;});api.cancel=vi.fn(()=>new Promise<void>(resolve=>{ack=resolve;}));
  const {result}=renderHook(()=>useExportCoordinator({revision:7,score:music(),settings:defaultDocumentSettings(),currentSpeed:1,bridge:{readBackingAsset:async()=>{throw new Error('Unexpected backing read.');},confirmExport:async()=>true,exportGp:async()=>true},native:api}));
  const options:ExportOptions={format:'wav',selection:{tracks:[0],range:null},audio:{sampleRate:48000,bitDepth:16,speed:'saved',metronome:false,tailSeconds:0,backing:false,includeMix:false}};
  let pending!:Promise<boolean>,cancelling!:Promise<void>,runSettled=false,cancelSettled=false;
  await act(async()=>{pending=result.current.run(options);void pending.then(()=>{runSettled=true;},()=>{runSettled=true;});});
  act(()=>{cancelling=result.current.cancel().then(()=>{cancelSettled=true;});});expect(api.cancel).toHaveBeenCalledWith('known');
  await act(async()=>{terminal({id:'known',frames:1,totalFrames:1,status,error:status==='failed'?'Disk full':undefined});});
  expect(runSettled).toBe(false);expect(cancelSettled).toBe(false);expect(result.current.busy).toBe(true);
  await act(async()=>{await expect(result.current.run(options)).rejects.toThrow('An export is already running.');});
  await act(async()=>{ack();if(status==='failed')await expect(pending).rejects.toThrow('Disk full');else expect(await pending).toBe(status==='complete');await cancelling;});
  expect(runSettled).toBe(true);expect(cancelSettled).toBe(true);expect(result.current.busy).toBe(false);expect(api.cancel).toHaveBeenCalledTimes(1);
});
