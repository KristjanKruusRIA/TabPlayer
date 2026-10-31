import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ChannelMix,DocumentSettings,TrackSound } from '../edit-types';
import type { AssetInfo } from '../project';
import type { PlaybackPlan } from './types';
import type { PracticeLoop,PracticeSettings,PracticeStatus } from './practice-types';
import type { PlaybackSpan } from './selection-playback-types';
import type { AudioOwner } from '../workspace/types';

export interface NativeAudioStatus {generation:number;desiredGeneration?:number;ready:boolean;playing:boolean;tick:number;seconds:number;durationSeconds:number;speed:number;metronome:boolean;practice:PracticeStatus;loop:PracticeLoop|null;range:PlaybackSpan|null;error:string|null;deviceId:string|null;backingDurationSeconds?:number|null;renderedFrames?:number;outputPeak?:number;auditionSerial?:number;auditionPeak?:number}
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
// A note audition plays 1-12 notes through a track's own sound without touching playback. `voice` and `mix`
// are the track's TrackSound and ChannelMix as sent to prepare/setMix (mute and solo are ignored natively);
// `program`/`percussion` identify the plan track; `durationMs` (100-3000) is how long each note is held.
export interface AudioDiagnostics {
  deviceName?: string;
  sampleRate?: number;
  bufferSize?: number;
}
export interface AuditionNote {key:number;startMs:number;velocity:number}
export interface AuditionRequest {voice:TrackSound;program:number;percussion:boolean;mix:ChannelMix;notes:AuditionNote[];durationMs:number}
export interface AuditionResult {played:boolean}
export interface NativeAudioBridge {
  prepare(plan:PlaybackPlan,settings:DocumentSettings,embedded:Uint8Array|null,sourceKey?:string,practice?:PracticeSettings):Promise<void>;
  command(command:TransportCommand):Promise<void>;
  setMix(settings:DocumentSettings,generation:number):Promise<void>;
  devices():Promise<AudioDeviceInfo[]>;
  status():Promise<NativeAudioStatus|null>;
  subscribe(listener:(status:NativeAudioStatus)=>void):Promise<()=>void>;
  stageBacking():Promise<BackingCandidate|null>;
  stageEmbeddedBacking(bytes:Uint8Array):Promise<BackingCandidate|null>;
  diagnostics?():Promise<AudioDiagnostics>;
  testTone?():Promise<void>;
  /** Optional so existing fixtures stay valid. Not queued behind transport commands; resolves `{played:false}` when no output stream is open. */
  audition?(request:AuditionRequest):Promise<AuditionResult>;
}
// Desktop-test builds record the settings of each preparation and mix native audio accepted, so
// end-to-end tests can check gains and that nothing was prepared again.
const desktopTest=import.meta.env.VITE_DESKTOP_TEST==='1';
function recordForTest(key:'__tabplayerTestMixes'|'__tabplayerTestPrepares'|'__tabplayerTestAuditions',settings:unknown){if(desktopTest)((window as unknown as Record<string,unknown[]|undefined>)[key]??=[]).push(structuredClone(settings));}
export function createDocumentAudioBridge(context:AudioOwner):NativeAudioBridge {
  const owner={documentId:context.documentId,activationId:context.activationId};
  let commandQueue:Promise<void>=Promise.resolve();
  return {
  prepare:async(plan,settings,embedded,sourceKey,practice)=>{await invoke('audio_prepare',{owner,plan,settings,embeddedBytes:embedded?Array.from(embedded):null,sourceKey:sourceKey??'blank',practice:practice??null});recordForTest('__tabplayerTestPrepares',settings);},
  command:command=>{
    if(command.type==='invalidate')return invoke('audio_command',{owner,command});
    const next=commandQueue.then(()=>invoke<void>('audio_command',{owner,command}));commandQueue=next.catch(()=>{});return next;
  },
  setMix:async(settings,generation)=>{await invoke('audio_set_mix',{owner,settings,generation});recordForTest('__tabplayerTestMixes',settings);},
  audition:async request=>{const result=await invoke<AuditionResult>('audio_audition',{owner,request});recordForTest('__tabplayerTestAuditions',request);return result;},
  devices:()=>invoke('audio_devices'),status:()=>invoke('audio_status'),
  diagnostics:()=>invoke<AudioDiagnostics>('audio_diagnostics'),
  testTone:()=>invoke<void>('audio_test_tone'),
  subscribe:listener=>listen<NativeAudioStatus>('native-audio-status',event=>listener(event.payload)),
  stageBacking:()=>invoke('stage_backing',{documentId:owner.documentId}),
  stageEmbeddedBacking:bytes=>invoke('stage_embedded_backing',{documentId:owner.documentId,bytes:Array.from(bytes)}),
  };
}
