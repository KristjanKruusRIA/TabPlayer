import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DocumentSettings } from '../edit-types';
import type { AssetInfo } from '../project';
import type { PlaybackPlan } from './types';
import type { PracticeLoop,PracticeSettings,PracticeStatus } from './practice-types';
import type { PlaybackSpan } from './selection-playback-types';
import type { AudioOwner } from '../workspace/types';

export interface NativeAudioStatus {generation:number;desiredGeneration?:number;ready:boolean;playing:boolean;tick:number;seconds:number;durationSeconds:number;speed:number;metronome:boolean;practice:PracticeStatus;loop:PracticeLoop|null;range:PlaybackSpan|null;error:string|null;deviceId:string|null;backingDurationSeconds?:number|null;renderedFrames?:number;outputPeak?:number}
export interface AudioDeviceInfo {id:string;name:string;isDefault:boolean}
export interface BackingCandidate {token:string;assetId:string;info:AssetInfo;durationMs?:number}
export type TransportCommand =
  | {type:'play'|'pause'|'stop'|'clearLoop';generation:number}
  | {type:'invalidate';generation:number}
  | {type:'seekTick';tick:number;generation:number}
  | {type:'playRange';generation:number;startTick:number;endTick:number|null}
  | {type:'setPractice';settings:PracticeSettings;generation:number}
  | {type:'setLoop';startTick:number;endTick:number;generation:number}
  | {type:'selectDevice';deviceId:string|null;generation:number};
export interface NativeAudioBridge {
  prepare(plan:PlaybackPlan,settings:DocumentSettings,embedded:Uint8Array|null,sourceKey?:string,practice?:PracticeSettings):Promise<void>;
  command(command:TransportCommand):Promise<void>;
  setMix(settings:DocumentSettings,generation:number):Promise<void>;
  devices():Promise<AudioDeviceInfo[]>;
  status():Promise<NativeAudioStatus|null>;
  subscribe(listener:(status:NativeAudioStatus)=>void):Promise<()=>void>;
  stageBacking():Promise<BackingCandidate|null>;
  stageEmbeddedBacking(bytes:Uint8Array):Promise<BackingCandidate|null>;
}
export function createDocumentAudioBridge(context:AudioOwner):NativeAudioBridge {
  const owner={documentId:context.documentId,activationId:context.activationId};
  let commandQueue:Promise<void>=Promise.resolve();
  return {
  prepare:async(plan,settings,embedded,sourceKey,practice)=>{await invoke('audio_prepare',{owner,plan,settings,embeddedBytes:embedded?Array.from(embedded):null,sourceKey:sourceKey??'blank',practice:practice??null});},
  command:command=>{
    if(command.type==='invalidate')return invoke('audio_command',{owner,command});
    const next=commandQueue.then(()=>invoke<void>('audio_command',{owner,command}));commandQueue=next.catch(()=>{});return next;
  },
  setMix:(settings,generation)=>invoke('audio_set_mix',{owner,settings,generation}),
  devices:()=>invoke('audio_devices'),status:()=>invoke('audio_status'),
  subscribe:listener=>listen<NativeAudioStatus>('native-audio-status',event=>listener(event.payload)),
  stageBacking:()=>invoke('stage_backing',{documentId:owner.documentId}),
  stageEmbeddedBacking:bytes=>invoke('stage_embedded_backing',{documentId:owner.documentId,bytes:Array.from(bytes)}),
  };
}
