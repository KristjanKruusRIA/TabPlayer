import { invoke } from '@tauri-apps/api/core';
import type { DocumentSettings } from '../document-settings';
import type { PlaybackPlan } from '../audio/types';
import type { ExportProgress,SvgPage } from './types';
export interface NativeAudioExportRequest {
  tracks:{id:string;name:string;preset:string;kind:'score'}[];
  range:{first:number;last:number}|null;format:{sampleRate:44100|48000;bitDepth:16|24};speed:number;metronome:boolean;tailSeconds:number;includeBacking:boolean;includeMix:boolean;
}
export interface NativeAudioExportPayload {plan:PlaybackPlan;request:NativeAudioExportRequest;settings:DocumentSettings;embeddedBytes:number[]|null;stems:boolean}
export interface ExportNativeBridge {
  exportPdf(pages:SvgPage[],print:boolean):Promise<string|null>;
  exportMidi(bytes:Uint8Array):Promise<boolean>;
  exportAudio(payload:NativeAudioExportPayload):Promise<string|null>;
  status(id:string):Promise<ExportProgress|null>;
  cancel(id:string):Promise<void>;
}
export const nativeExportBridge:ExportNativeBridge={
  exportPdf:(pages,print)=>invoke('export_pdf',{pages,print}),
  exportMidi:bytes=>invoke('export_midi',{bytes:Array.from(bytes)}),
  exportAudio:payload=>invoke('export_audio',{...payload}),
  status:id=>invoke('export_status',{id}),
  cancel:id=>invoke('cancel_export',{id}),
};
