export const PPQ: number;
export const TEMPOS: number[];
export const MAX_MIDI_BYTES: number;
export interface ProbeCase { id: string; type: string; length: number; beat: number; shape: string; label: string }
export interface PlanNote { start: number; dur: number; key: number }
export interface PlanBar { index: number; case: ProbeCase | null; t1: PlanNote[]; t2: PlanNote[] }
export const CASES: ProbeCase[];
export function probePlan(): PlanBar[];
export function fermataXml(probeCase: ProbeCase): string;
export function buildProbeFile(bpm: number): Uint8Array;
export function readmeText(): string;
export function writeProbe(dir: string): string[];
export interface Smf {
  ok: boolean; warnings: string[]; format: number; declaredTracks: number; ppq: number; tracks: number;
  tempos: { tick: number; usPerQuarter: number; track: number }[];
  timeSigs: { tick: number; numerator: number; denominator: number }[];
  texts: { tick: number; kind: number; text: string; track: number }[];
  notes: { track: number; channel: number; key: number; velocity: number; on: number; off: number | null }[];
}
export function parseSmf(input: Uint8Array | ArrayBuffer, maxBytes?: number): Smf;
export function tempoMap(tempos: { tick: number; usPerQuarter: number }[], ppq: number): { tick: number; usPerQuarter: number; seconds: number }[];
export function tickToSeconds(map: ReturnType<typeof tempoMap>, ppq: number, tick: number): number;
export interface AnalysedCase { id: string; mechanism: string; added1: { ticks: number; seconds: number }; added2: { ticks: number; seconds: number }; [key: string]: unknown }
export interface Analysis { ppq: number; bpm: number; problems: string[]; cases: AnalysedCase[]; [key: string]: unknown }
export function analyseSmf(smf: Smf, nominalBpm: number | null): Analysis;
export function describeFile(name: string, result: Analysis): string[];
export function conclude(files: { name: string; bpm: number; result: Analysis }[]): string[];
export function analyseDirectory(dir: string): string[];
