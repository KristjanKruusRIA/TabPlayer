import { invoke } from '@tauri-apps/api/core';
import type { DocumentSettings } from '../document-settings';
import type { PlaybackPlan } from '../audio/types';
import type { ExportProgress,SvgPage } from './types';
import type { DocumentId } from '../workspace/types';
export interface NativeAudioExportRequest {
  tracks:{id:string;name:string;preset:string;kind:'score'}[];
  range:{first:number;last:number}|null;format:{sampleRate:44100|48000;bitDepth:16|24};speed:number;metronome:boolean;tailSeconds:number;includeBacking:boolean;includeMix:boolean;
}
export interface NativeAudioExportPayload {plan:PlaybackPlan;request:NativeAudioExportRequest;settings:DocumentSettings;embeddedBytes:number[]|null;stems:boolean}
export interface ExportNativeBridge {
  exportPdf(pages:SvgPage[],print:boolean,revision:number):Promise<string|null>;
  exportMidi(bytes:Uint8Array,revision:number):Promise<boolean>;
  exportMusicXml(bytes:Uint8Array,revision:number):Promise<boolean>;
  exportSvg(pages:SvgPage[],revision:number):Promise<boolean>;
  exportAudio(payload:NativeAudioExportPayload,revision:number):Promise<string|null>;
  status(id:string):Promise<ExportProgress|null>;
  cancel(id:string):Promise<void>;
}
export function createDocumentExportBridge(documentId:DocumentId):ExportNativeBridge {
  return {
    exportPdf:(pages,print,revision)=>invoke('export_pdf',{document:{documentId,revision},pages,print}),
    exportMidi:(bytes,revision)=>invoke('export_midi',{document:{documentId,revision},bytes:Array.from(bytes)}),
    exportMusicXml:(bytes,revision)=>invoke('export_musicxml',{document:{documentId,revision},bytes:Array.from(bytes)}),
    exportSvg:(pages,revision)=>invoke('export_svg',{document:{documentId,revision},pages}),
    exportAudio:(payload,revision)=>invoke('export_audio',{...payload,document:{documentId,revision}}),
    status:id=>invoke('export_status',{documentId,id}),
    cancel:id=>invoke('cancel_export',{documentId,id}),
  };
}
