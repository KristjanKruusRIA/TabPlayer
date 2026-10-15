import { useEffect,useRef,useState } from 'react';
import { model,Settings } from '@coderline/alphatab';
import { exportGp,trackIdentity } from '../engine';
import type { NativeBridge } from '../bridge';
import type { DocumentSettings } from '../document-settings';
import { buildPlaybackPlanFromJson } from '../audio/plan';
import { nativeExportBridge,type ExportNativeBridge } from './bridge';
import { selectScore,selectStaves } from './selection';
import { exportMidi } from './midi';
import { loadExportFonts,renderPdfPages } from './pdf';
import { validateSelection,type ExportOptions,type ExportProgress } from './types';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource } from '../interchange/gp';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { effectivePageLayout } from '../engraving/page';
export function useExportCoordinator({score,settings,currentSpeed,bridge,native=nativeExportBridge,embeddedBacking=null}:{score:model.Score;settings:DocumentSettings;currentSpeed:number|null;bridge:Pick<NativeBridge,'confirmExport'|'exportGp'>;native?:ExportNativeBridge;embeddedBacking?:Uint8Array|null}) {
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState<ExportProgress>();
  const pending=useRef(false),cancelled=useRef(false),job=useRef<string|null>(null),alive=useRef(true),generation=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancelled.current=true;if(job.current)void native.cancel(job.current).catch(()=>{});};},[native]);
  async function cancel(){cancelled.current=true;if(job.current)await native.cancel(job.current);}
  async function watch(id:string|null):Promise<boolean>{
    if(!id)return false;job.current=id;if(cancelled.current)await native.cancel(id);
    while(true){const state=await native.status(id);if(!state)throw new Error('Export job is no longer available.');if(alive.current)setProgress(state);
      if(state.status==='complete')return true;if(state.status==='cancelled')return false;if(state.status==='failed')throw new Error(state.error??'Export failed.');
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }
  async function run(options:ExportOptions):Promise<boolean>{
    if(pending.current)throw new Error('An export is already running.');
    validateSelection(score.tracks.length,score.masterBars.length,options.selection,score.tracks.map(t=>t.staves.length));
    let speed=1;
    if((options.format==='wav'||options.format==='stems')&&options.audio.speed==='current'){
      if(currentSpeed===null)throw new Error('Fixed BPM has no single speed coefficient. Export at saved speed is available.');
      speed=currentSpeed;
    }
    const json=model.JsonConverter.scoreToJson(score),ids=score.tracks.map(trackIdentity),frozenSettings=structuredClone(settings),embedded=embeddedBacking?.slice()??null;
    const frozenOptions=structuredClone(options);pending.current=true;cancelled.current=false;job.current=null;setBusy(true);setProgress(undefined);
    try{
      const copy=scoreFromJson(json,new Settings()),selection=frozenOptions.selection;
      restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);
      if(frozenOptions.format==='gp'){if(!await bridge.confirmExport()||cancelled.current)return false;return await bridge.exportGp(exportGp(selectScore(copy,selection)));}
      if(frozenOptions.format==='midi'){if(cancelled.current)return false;return await native.exportMidi(exportMidi(copy,selection));}
      if(frozenOptions.format==='pdf'||frozenOptions.format==='print'){await loadExportFonts();if(cancelled.current)return false;const pages=renderPdfPages(copy,selection,frozenOptions.layout,{page:frozenOptions.page??effectivePageLayout({page:null,print:frozenOptions.layout}),engraving:frozenSettings.engraving,trackIds:ids});if(cancelled.current)return false;return await watch(await native.exportPdf(pages,frozenOptions.format==='print'));}
      const audio=frozenOptions.audio;
      const plan=buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(selectStaves(copy,selection)),ids,++generation.current);
      if(cancelled.current)return false;
      return await watch(await native.exportAudio({plan,settings:frozenSettings,embeddedBytes:embedded?Array.from(embedded):null,stems:frozenOptions.format==='stems',request:{tracks:selection.tracks.map(i=>({id:ids[i],name:copy.tracks[i].name,preset:frozenSettings.sounds[ids[i]]?.presetId??'gm',kind:'score'})),range:selection.range,format:{sampleRate:audio.sampleRate,bitDepth:audio.bitDepth},speed,metronome:audio.metronome,tailSeconds:audio.tailSeconds,includeBacking:audio.backing,includeMix:audio.includeMix}}));
    }finally{pending.current=false;job.current=null;if(alive.current)setBusy(false);}
  }
  return {busy,progress,run,cancel};
}
