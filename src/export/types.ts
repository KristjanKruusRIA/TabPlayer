import type { PrintLayout } from '../document-settings';
import type { PageLayout } from '../engraving/types';
export type { PrintLayout } from '../document-settings';
export interface ExportSelection { tracks:number[]; range:{first:number;last:number}|null;staves?:Record<number,number[]> }
export interface SvgPage { svg:string; widthMm:number; heightMm:number }
export const PNG_RESOLUTIONS=[72,150,300,600] as const;
export type PngResolution=typeof PNG_RESOLUTIONS[number];
export interface SvgSystem { svg:string; width:number; height:number }
export interface AudioExportOptions { sampleRate:44100|48000;bitDepth:16|24;speed:'saved'|'current';metronome:boolean;tailSeconds:number;backing:boolean;includeMix:boolean }
export type ExportOptions =
  | {format:'gp';selection:ExportSelection;backing?:boolean}
  | {format:'midi';selection:ExportSelection}
  | {format:'musicxml';selection:ExportSelection}
  | {format:'pdf';selection:ExportSelection;layout:PrintLayout;page?:PageLayout}
  | {format:'print';selection:ExportSelection;layout:PrintLayout;page?:PageLayout}
  | {format:'svg';selection:ExportSelection;layout:PrintLayout;page?:PageLayout;transparent:boolean}
  | {format:'png';selection:ExportSelection;layout:PrintLayout;page?:PageLayout;transparent:boolean;dpi:PngResolution}
  | {format:'wav';selection:ExportSelection;audio:AudioExportOptions}
  | {format:'stems';selection:ExportSelection;audio:AudioExportOptions};
export interface ExportProgress { id:string;frames:number;totalFrames:number;status:'running'|'complete'|'cancelled'|'failed';error?:string|null }
export function validateSelection(trackCount:number,barCount:number,selection:ExportSelection,staffCounts:number[]=[]) {
  if (!selection.tracks.length) throw new Error('Select at least one track to export.');
  if (new Set(selection.tracks).size!==selection.tracks.length || selection.tracks.some(n=>!Number.isInteger(n)||n<0||n>=trackCount)) throw new Error('Select existing tracks to export.');
  const r=selection.range;
  if(r && (![r.first,r.last].every(Number.isInteger)||r.first<0||r.last<r.first||r.last>=barCount)) throw new Error('Use an inclusive range of existing measures.');
  for(const [track,staves] of Object.entries(selection.staves??{})){const index=Number(track);if(!selection.tracks.includes(index)||!Array.isArray(staves)||!staves.length||new Set(staves).size!==staves.length||staves.some(n=>!Number.isInteger(n)||n<0||n>=(staffCounts[index]??0)))throw new Error('Select existing staves for each exported track.');}
}
