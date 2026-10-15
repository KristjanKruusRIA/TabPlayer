import type {BackingSettings} from '../edit-types';
import type {AudioOwner,DocumentRevision} from '../workspace/types';
import type {BackingTimeline} from './backing-waveform-types';

export type ReferenceEndpoint='entry'|'exit';
export interface ReferenceLocation {bar:number;occurrence:number;startTick:number;endTick:number}
export interface ReferenceTempoSegment {startTick:number;endTick:number;startSourceMs:number;endSourceMs:number;bpm:number}
export interface ReferenceSyncTiming {
  entryTick:number;exitTick:number;entrySourceMs:number;exitSourceMs:number;
  segments:readonly ReferenceTempoSegment[];
}
export interface ReferenceEditBinding {
  active:{endpoint:ReferenceEndpoint;surface:'number'|'waveform'}|null;
  preview:BackingSettings|null;error:string|null;
  begin(endpoint:ReferenceEndpoint,surface:'number'|'waveform'):boolean;
  update(sourceMs:number):void;commit():void;cancel():void;
}
export interface ReferenceEditOptions {
  owner:Readonly<AudioOwner>;document:DocumentRevision;sourceKey:string|null;
  settings:BackingSettings|null;timeline:BackingTimeline|null;durationMs:number|null;
  visible:{number:boolean;waveform:boolean};busy:boolean;
  beginOperation:()=>()=>void;isCurrent:(document:DocumentRevision,settings:BackingSettings)=>boolean;
  onCommit:(backing:BackingSettings,document:DocumentRevision)=>Promise<void>;
}
export interface ReferenceSyncControls {
  timing:ReferenceSyncTiming|null;edit:ReferenceEditBinding;ready:boolean;
  onModeChange:(mode:'score'|'reference')=>Promise<void>;
  onFromScore:(mode:'replace'|'add')=>Promise<void>;onWriteScore:()=>Promise<void>;
}
