import { useEffect,useRef,useState } from 'react';
import { model,Settings } from '@coderline/alphatab';
import { exportGp,trackIdentity } from '../engine';
import type { NativeBridge } from '../bridge';
import type { DocumentSettings } from '../document-settings';
import { backingLocationsForScore,buildPlaybackPlanFromJson } from '../audio/plan';
import { applyReferenceSyncPlan } from '../audio/reference-sync';
import type { ExportNativeBridge } from './bridge';
import { selectStaves } from './selection';
import { exportMidi } from './midi';
import { exportMusicXml } from './musicxml';
import { exportAsciiTab } from './ascii-tab';
import { clearBacking } from '../interchange/backing-projection';
import { DEFAULT_FILE_NAME,expandFileName,fileKey,fileNameContext,savedFileNames,withSuffix } from './file-name';
import { assertPngSize,loadExportFonts,renderPdfPages,svgPageWithBackground } from './pdf';
import { validateSelection,type ExportOptions,type ExportProgress,type ExportSelection,type TrackPages } from './types';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource } from '../interchange/gp';
import { projectGpDocument } from '../interchange/backing-projection';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { effectivePageLayout } from '../engraving/page';
export type ExportSource={score:model.Score;settings:DocumentSettings;embeddedBacking?:Uint8Array|null;revision:number};
type ExportOperation={finished:Promise<void>;cancelRequest:Promise<void>|null};
export function useExportCoordinator({score,settings,currentSpeed,bridge,native,embeddedBacking=null,revision}:ExportSource&{currentSpeed:number|null;bridge:Pick<NativeBridge,'confirmExport'|'exportGp'|'readBackingAsset'>;native:ExportNativeBridge}) {
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState<ExportProgress>();
  const pending=useRef(false),cancelled=useRef(false),job=useRef<string|null>(null),alive=useRef(true),generation=useRef(0);
  const operation=useRef<ExportOperation|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancelled.current=true;if(job.current)void native.cancel(job.current).catch(()=>{});};},[native]);
  function requestCancel(id:string,active:ExportOperation){return active.cancelRequest??(active.cancelRequest=native.cancel(id));}
  async function cancel(){cancelled.current=true;const active=operation.current;if(!active)return;if(job.current)void requestCancel(job.current,active).catch(()=>{});await active.finished;await active.cancelRequest;}
  async function watch(id:string|null,active:ExportOperation):Promise<boolean>{
    if(!id)return false;job.current=id;if(cancelled.current)await requestCancel(id,active).catch(()=>{});
    while(true){const state=await native.status(id);if(!state)throw new Error('Export job is no longer available.');if(alive.current)setProgress(state);
      if(state.status==='complete')return true;if(state.status==='cancelled')return false;if(state.status==='failed')throw new Error(state.error??'Export failed.');
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }
  async function run(options:ExportOptions,source:ExportSource={score,settings,embeddedBacking,revision}):Promise<boolean>{
    if(pending.current)throw new Error('An export is already running.');
    const {score,settings,embeddedBacking,revision}=source;
    validateSelection(score.tracks.length,score.masterBars.length,options.selection,score.tracks.map(t=>t.staves.length));
    let speed=1;
    if((options.format==='wav'||options.format==='stems')&&options.audio.speed==='current'){
      if(currentSpeed===null)throw new Error('Fixed BPM has no single speed coefficient. Export at saved speed is available.');
      speed=currentSpeed;
    }
    const json=model.JsonConverter.scoreToJson(score),ids=score.tracks.map(trackIdentity),frozenSettings=structuredClone(settings),embedded=embeddedBacking?.slice()??null;
    const frozenOptions=structuredClone(options);pending.current=true;cancelled.current=false;job.current=null;setBusy(true);setProgress(undefined);
    let finish!:()=>void;const active:ExportOperation={finished:new Promise<void>(resolve=>{finish=resolve;}),cancelRequest:null};operation.current=active;
    try{
      const copy=scoreFromJson(json,new Settings()),selection=frozenOptions.selection;
      restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);
      const name=expandFileName(frozenOptions.fileName??DEFAULT_FILE_NAME,fileNameContext(copy,selection,new Date()));
      if(frozenOptions.format==='gp'){
        if(!await bridge.confirmExport()||cancelled.current||!alive.current)return false;
        const include=frozenOptions.backing!==false,backing=frozenSettings.backing;
        const bytes=include&&backing?(backing.assetId==='embedded'?embedded:await bridge.readBackingAsset(backing.assetId,revision)):null;
        if(cancelled.current||!alive.current)return false;
        return await bridge.exportGp(exportGp(projectGpDocument({score:copy,settings:frozenSettings,bytes,selection,backing:include})),revision,name);
      }
      if(frozenOptions.format==='midi'){if(cancelled.current)return false;return await native.exportMidi(exportMidi(copy,selection),revision,name);}
      // Backing audio is left out; refusals throw here, before the native save dialog opens.
      if(frozenOptions.format==='musicxml'){clearBacking(copy);const bytes=exportMusicXml(copy,selection);if(cancelled.current)return false;return await native.exportMusicXml(bytes,revision,name);}
      // Refusals (no stringed track selected) throw before the save dialog opens.
      if(frozenOptions.format==='ascii'){const bytes=exportAsciiTab(copy,selection);if(cancelled.current)return false;return await native.exportAsciiTab(bytes,revision,name);}
      if((frozenOptions.format==='pdf'||frozenOptions.format==='svg'||frozenOptions.format==='png')&&frozenOptions.perTrack){
        await loadExportFonts();if(cancelled.current)return false;
        const options=frozenOptions,now=new Date(),used=new Set<string>(),files:TrackPages[]=[];
        // A PDF is one file whatever its page count; SVG and PNG pages are numbered.
        const saved=(name:string,pages:number)=>savedFileNames(name,options.format==='pdf'?1:pages,options.format);
        const taken=(name:string,pages:number)=>saved(name,pages).some(file=>used.has(fileKey(file)));
        // Each track is rendered alone and named from its own %t and %n; a name whose files would repeat gets the track number.
        for(const track of [...selection.tracks].sort((a,b)=>a-b)){
          await new Promise(resolve=>setTimeout(resolve,0));if(cancelled.current)return false;
          const single:ExportSelection={tracks:[track],range:selection.range,...(selection.staves?.[track]?{staves:{[track]:selection.staves[track]}}:{})};
          const rendered=renderPdfPages(copy,single,options.layout,{page:options.page??effectivePageLayout({page:null,print:options.layout}),engraving:frozenSettings.engraving,trackIds:ids});
          const pages=options.format!=='pdf'&&!options.transparent?rendered.map(svgPageWithBackground):rendered;
          const base=expandFileName(options.fileName??DEFAULT_FILE_NAME,fileNameContext(copy,single,now));
          let name=base;
          for(let attempt=1;taken(name,pages.length);attempt++)name=withSuffix(base,attempt===1?` (${track+1})`:` (${track+1}-${attempt})`);
          for(const file of saved(name,pages.length))used.add(fileKey(file));
          files.push({name,pages});
        }
        if(cancelled.current)return false;
        if(options.format==='png')assertPngSize(files.flatMap(file=>file.pages),options.dpi);
        return await native.exportTrackFiles(options.format,files,options.format==='png'?options.dpi:null,revision);
      }
      if(frozenOptions.format==='svg'||frozenOptions.format==='png'){await loadExportFonts();if(cancelled.current)return false;const rendered=renderPdfPages(copy,selection,frozenOptions.layout,{page:frozenOptions.page??effectivePageLayout({page:null,print:frozenOptions.layout}),engraving:frozenSettings.engraving,trackIds:ids});if(cancelled.current)return false;if(frozenOptions.format==='png')assertPngSize(rendered,frozenOptions.dpi);const pages=frozenOptions.transparent?rendered:rendered.map(svgPageWithBackground);return await (frozenOptions.format==='png'?native.exportPng(pages,frozenOptions.dpi,revision,name):native.exportSvg(pages,revision,name));}
      if(frozenOptions.format==='pdf'||frozenOptions.format==='print'){await loadExportFonts();if(cancelled.current)return false;const pages=renderPdfPages(copy,selection,frozenOptions.layout,{page:frozenOptions.page??effectivePageLayout({page:null,print:frozenOptions.layout}),engraving:frozenSettings.engraving,trackIds:ids});if(cancelled.current)return false;return await watch(await native.exportPdf(pages,frozenOptions.format==='print',revision,frozenOptions.format==='print'?null:name),active);}
      const audio=frozenOptions.audio;
      const selected=selectStaves(copy,selection);
      if(frozenSettings.backing?.referenceSync&&Object.keys(selection.staves??{}).length){
        const original=backingLocationsForScore(copy),route=backingLocationsForScore(selected);
        if(original.length!==route.length||original.some((item,index)=>{const next=route[index];return item.bar!==next.bar||item.occurrence!==next.occurrence||item.startTick!==next.startTick||item.endTick!==next.endTick;}))throw new Error('The selected staves change reference playback timing. Choose staves with the original performed route.');
      }
      const plan=applyReferenceSyncPlan(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(selected),ids,++generation.current),frozenSettings.backing);
      if(cancelled.current)return false;
      return await watch(await native.exportAudio({plan,settings:frozenSettings,embeddedBytes:embedded?Array.from(embedded):null,stems:frozenOptions.format==='stems',request:{tracks:selection.tracks.map(i=>({id:ids[i],name:copy.tracks[i].name,preset:frozenSettings.sounds[ids[i]]?.presetId??'gm',kind:'score'})),range:selection.range,format:{sampleRate:audio.sampleRate,bitDepth:audio.bitDepth,...(audio.container?{container:audio.container}:{})},speed,metronome:audio.metronome,tailSeconds:audio.tailSeconds,includeBacking:audio.backing,includeMix:audio.includeMix,...(frozenOptions.format==='wav'&&audio.normalizeRmsDb!==undefined?{normalizeRmsDb:audio.normalizeRmsDb}:{})}},revision,name),active);
    }finally{if(active.cancelRequest)await active.cancelRequest.catch(()=>{});pending.current=false;job.current=null;if(alive.current)setBusy(false);operation.current=null;finish();}
  }
  return {busy,progress,run,cancel};
}
