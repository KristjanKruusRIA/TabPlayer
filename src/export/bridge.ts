import type { ClickSound } from '../audio/practice-types';
import { invoke } from '@tauri-apps/api/core';
import type { DocumentSettings } from '../document-settings';
import type { PlaybackPlan } from '../audio/types';
import type { ExportProgress,PngResolution,SvgPage,TrackPages } from './types';
import type { DocumentId } from '../workspace/types';
export interface NativeAudioExportRequest {
  tracks:{id:string;name:string;preset:string;kind:'score'}[];
  range:{first:number;last:number}|null;format:{sampleRate:44100|48000;bitDepth:16|24;container?:'aiff'|'flac'|'ogg'};speed:number;metronome:boolean;metronomeSound?:ClickSound;tailSeconds:number;includeBacking:boolean;normalizeRmsDb?:number;includeMix:boolean;
}
export interface NativeAudioExportPayload {plan:PlaybackPlan;request:NativeAudioExportRequest;settings:DocumentSettings;embeddedBytes:number[]|null;stems:boolean}
export interface ExportNativeBridge {
  // `fileName` pre-fills the save dialog; the native side validates it again.
  exportPdf(pages:SvgPage[],print:boolean,revision:number,fileName:string|null):Promise<string|null>;
  exportMidi(bytes:Uint8Array,revision:number,fileName:string):Promise<boolean>;
  exportMusicXml(bytes:Uint8Array,revision:number,fileName:string):Promise<boolean>;
  exportAsciiTab(bytes:Uint8Array,revision:number,fileName:string):Promise<boolean>;
  exportGp5(bytes:Uint8Array,revision:number,fileName:string):Promise<boolean>;
  exportSvg(pages:SvgPage[],revision:number,fileName:string):Promise<boolean>;
  exportPng(pages:SvgPage[],dpi:PngResolution,revision:number,fileName:string):Promise<boolean>;
  /** Writes one file per track (pdf, svg or png) into a folder the user picks. */
  exportTrackFiles(format:'pdf'|'svg'|'png',files:TrackPages[],dpi:PngResolution|null,revision:number):Promise<boolean>;
  exportAudio(payload:NativeAudioExportPayload,revision:number,fileName:string):Promise<string|null>;
  status(id:string):Promise<ExportProgress|null>;
  cancel(id:string):Promise<void>;
}
const desktopTest=import.meta.env.VITE_DESKTOP_TEST==='1';
/** Desktop-test builds keep the rendered pages native export accepted, since exported text is outlined. */
async function recordPages<T>(result:Promise<T>,pages:SvgPage[]):Promise<T> {
  const value=await result;
  if(desktopTest&&value)((window as unknown as {__tabplayerTestExportPages?:SvgPage[][]}).__tabplayerTestExportPages??=[]).push(structuredClone(pages));
  return value;
}
export function createDocumentExportBridge(documentId:DocumentId):ExportNativeBridge {
  return {
    exportPdf:(pages,print,revision,fileName)=>recordPages(invoke<string|null>('export_pdf',{document:{documentId,revision},pages,print,fileName}),pages),
    exportMidi:(bytes,revision,fileName)=>invoke('export_midi',{document:{documentId,revision},bytes:Array.from(bytes),fileName}),
    exportMusicXml:(bytes,revision,fileName)=>invoke('export_musicxml',{document:{documentId,revision},bytes:Array.from(bytes),fileName}),
    exportAsciiTab:(bytes,revision,fileName)=>invoke('export_ascii_tab',{document:{documentId,revision},bytes:Array.from(bytes),fileName}),
    exportGp5:(bytes,revision,fileName)=>invoke('export_gp5',{document:{documentId,revision},bytes:Array.from(bytes),fileName}),
    exportSvg:(pages,revision,fileName)=>recordPages(invoke<boolean>('export_svg',{document:{documentId,revision},pages,fileName}),pages),
    exportPng:(pages,dpi,revision,fileName)=>invoke('export_png',{document:{documentId,revision},pages,dpi,fileName}),
    exportTrackFiles:(format,files,dpi,revision)=>invoke('export_track_files',{document:{documentId,revision},format,files,dpi}),
    exportAudio:(payload,revision,fileName)=>invoke('export_audio',{...payload,document:{documentId,revision},fileName}),
    status:id=>invoke('export_status',{documentId,id}),
    cancel:id=>invoke('cancel_export',{documentId,id}),
  };
}
