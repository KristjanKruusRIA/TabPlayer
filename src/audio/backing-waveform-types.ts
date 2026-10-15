import type {BackingSettings,EditCommand,SyncAnchor} from '../edit-types';
import type {AudioOwner,DocumentRevision} from '../workspace/types';
import type {PlaybackSpan} from './selection-playback-types';
import type {MeasureOccurrence,PlanTempo} from './types';
import type {ReferenceSyncControls} from './reference-sync-types';

export const MAX_WAVEFORM_BUCKETS=8192;
export const MAX_WAVEFORM_AUDIO_BYTES=512*1024*1024;
export type WaveformSourceIdentity={kind:'asset';assetId:string}|{kind:'embedded';sourceKey:string;sha256:string};
export type WaveformSourceInput={kind:'asset';assetId:string}|{kind:'embedded';sourceKey:string;sha256:string;bytesBase64:string};
export interface BackingWaveformRequest {owner:AudioOwner;document:DocumentRevision;source:WaveformSourceInput;buckets:number}
export interface WaveformPeak {min:[number,number];max:[number,number]}
export interface WaveformPeaks {durationMs:number;sampleRate:number;frameCount:number;channels:1|2;bucketCount:number;peaks:WaveformPeak[]}
export interface BackingWaveform extends WaveformPeaks {owner:AudioOwner;document:DocumentRevision;source:WaveformSourceIdentity}
export interface NativeBackingWaveformBridge {
  readonly owner:Readonly<AudioOwner>;
  read(document:DocumentRevision,source:WaveformSourceInput,buckets:number):Promise<BackingWaveform>;
}
export interface BackingTimeline {generation:number;durationTick:number;tempos:readonly PlanTempo[];occurrences:readonly MeasureOccurrence[]}
export interface BackingScorePoint {tick:number;anchor:Pick<SyncAnchor,'bar'|'occurrence'|'ratio'>|null}
export interface BackingScoreSelection {points:readonly BackingScorePoint[];spans:readonly PlaybackSpan[]}
export interface BackingGridLine {key:string;bar:number;occurrence:number;ratio:number;tick:number;audioMs:number;kind:'bar'|'beat'}
export interface BackingWaveformProps {
  document:DocumentRevision;source:WaveformSourceInput|null;filename:string;bridge:NativeBackingWaveformBridge;
  timeline:BackingTimeline|null;selection:BackingScoreSelection;settings:BackingSettings|null;
  effectiveBacking:Pick<BackingSettings,'offsetMs'|'anchors'|'referenceSync'>|null;scoreTimeMs:number|null;enabled:boolean;busy:boolean;
  reference?:Pick<ReferenceSyncControls,'timing'|'edit'>;
  beginOperation:()=>()=>void;isCurrent:(document:DocumentRevision,settings:BackingSettings)=>boolean;
  onEdit:(command:Extract<EditCommand,{type:'setBacking'}>)=>Promise<void>;
}
