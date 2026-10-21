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
import { clearBacking } from '../interchange/backing-projection';
import { loadExportFonts,renderPdfPages,svgPageWithBackground } from './pdf';
import { validateSelection,type ExportOptions,type ExportProgress } from './types';
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
      if(frozenOptions.format==='gp'){
        if(!await bridge.confirmExport()||cancelled.current||!alive.current)return false;
        const include=frozenOptions.backing!==false,backing=frozenSettings.backing;
        const bytes=include&&backing?(backing.assetId==='embedded'?embedded:await bridge.readBackingAsset(backing.assetId,revision)):null;
        if(cancelled.current||!alive.current)return false;
        return await bridge.exportGp(exportGp(projectGpDocument({score:copy,settings:frozenSettings,bytes,selection,backing:include})),revision);
      }
      if(frozenOptions.format==='midi'){if(cancelled.current)return false;return await native.exportMidi(exportMidi(copy,selection),revision);}
      // Backing audio is left out; refusals throw here, before the native save dialog opens.
      if(frozenOptions.format==='musicxml'){clearBacking(copy);const bytes=exportMusicXml(copy,selection);if(cancelled.current)return false;return await native.exportMusicXml(bytes,revision);}
      if(frozenOptions.format==='svg'){await loadExportFonts();if(cancelled.current)return false;const pages=renderPdfPages(copy,selection,frozenOptions.layout,{page:frozenOptions.page??effectivePageLayout({page:null,print:frozenOptions.layout}),engraving:frozenSettings.engraving,trackIds:ids});if(cancelled.current)return false;return await native.exportSvg(frozenOptions.transparent?pages:pages.map(svgPageWithBackground),revision);}
      if(frozenOptions.format==='pdf'||frozenOptions.format==='print'){await loadExportFonts();if(cancelled.current)return false;const pages=renderPdfPages(copy,selection,frozenOptions.layout,{page:frozenOptions.page??effectivePageLayout({page:null,print:frozenOptions.layout}),engraving:frozenSettings.engraving,trackIds:ids});if(cancelled.current)return false;return await watch(await native.exportPdf(pages,frozenOptions.format==='print',revision),active);}
      const audio=frozenOptions.audio;
      const selected=selectStaves(copy,selection);
      if(frozenSettings.backing?.referenceSync&&Object.keys(selection.staves??{}).length){
        const original=backingLocationsForScore(copy),route=backingLocationsForScore(selected);
        if(original.length!==route.length||original.some((item,index)=>{const next=route[index];return item.bar!==next.bar||item.occurrence!==next.occurrence||item.startTick!==next.startTick||item.endTick!==next.endTick;}))throw new Error('The selected staves change reference playback timing. Choose staves with the original performed route.');
      }
      const plan=applyReferenceSyncPlan(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(selected),ids,++generation.current),frozenSettings.backing);
      if(cancelled.current)return false;
      return await watch(await native.exportAudio({plan,settings:frozenSettings,embeddedBytes:embedded?Array.from(embedded):null,stems:frozenOptions.format==='stems',request:{tracks:selection.tracks.map(i=>({id:ids[i],name:copy.tracks[i].name,preset:frozenSettings.sounds[ids[i]]?.presetId??'gm',kind:'score'})),range:selection.range,format:{sampleRate:audio.sampleRate,bitDepth:audio.bitDepth},speed,metronome:audio.metronome,tailSeconds:audio.tailSeconds,includeBacking:audio.backing,includeMix:audio.includeMix}},revision),active);
    }finally{if(active.cancelRequest)await active.cancelRequest.catch(()=>{});pending.current=false;job.current=null;if(alive.current)setBusy(false);operation.current=null;finish();}
  }
  return {busy,progress,run,cancel};
}
