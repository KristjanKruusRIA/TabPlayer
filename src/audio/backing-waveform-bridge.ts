import {invoke} from '@tauri-apps/api/core';
import {MAX_WAVEFORM_AUDIO_BYTES,MAX_WAVEFORM_BUCKETS,type BackingWaveform,type BackingWaveformRequest,type NativeBackingWaveformBridge,type WaveformSourceInput} from './backing-waveform-types';
import type {AudioOwner} from '../workspace/types';

export function createDocumentBackingWaveformBridge(context:AudioOwner):NativeBackingWaveformBridge {
  const owner=Object.freeze({documentId:context.documentId,activationId:context.activationId});
  return Object.freeze({owner,read:async(document,source,buckets)=>{
    validateBackingWaveformRequest({owner,document,source,buckets});
    const request={owner,document:{...document},source:{...source},buckets};
    const response=await invoke<unknown>('backing_waveform',{request});
    validateBackingWaveformResponse(response,request);
    return response;
  }} satisfies NativeBackingWaveformBridge);
}

export async function makeEmbeddedWaveformSource(sourceKey:string,bytes:Uint8Array):Promise<Extract<WaveformSourceInput,{kind:'embedded'}>> {
  if(typeof sourceKey!=='string'||!/^[a-f0-9]{64}$/i.test(sourceKey))throw new Error('Invalid waveform base digest.');
  if(bytes.byteLength>MAX_WAVEFORM_AUDIO_BYTES)throw new Error('Waveform audio exceeds the 512 MiB container limit.');
  const input=new Uint8Array(bytes),hash=await crypto.subtle.digest('SHA-256',input);
  const sha256=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  const chunks:string[]=[];
  for(let offset=0;offset<input.length;offset+=0x8000)chunks.push(String.fromCharCode(...input.subarray(offset,offset+0x8000)));
  return {kind:'embedded',sourceKey:sourceKey.toLowerCase(),sha256,bytesBase64:btoa(chunks.join(''))};
}

function validateBackingWaveformResponse(value:unknown,request:BackingWaveformRequest):asserts value is BackingWaveform {
  const response=fields(value,['owner','document','source','durationMs','sampleRate','frameCount','channels','bucketCount','peaks']);
  const owner=fields(response.owner,['documentId','activationId']),document=fields(response.document,['documentId','revision']);
  if(owner.documentId!==request.owner.documentId||owner.activationId!==request.owner.activationId
    ||document.documentId!==request.document.documentId||document.revision!==request.document.revision)throw new Error('Waveform response belongs to another document.');
  const source=fields(response.source,request.source.kind==='asset'?['kind','assetId']:['kind','sourceKey','sha256']);
  if(source.kind!==request.source.kind||(request.source.kind==='asset'?source.assetId!==request.source.assetId
    :source.sourceKey!==request.source.sourceKey||source.sha256!==request.source.sha256))throw new Error('Waveform response belongs to another source.');
  const {sampleRate,frameCount,bucketCount,durationMs,channels,peaks}=response;
  if(typeof sampleRate!=='number'||!Number.isInteger(sampleRate)||sampleRate<=0||sampleRate>4294967295
    ||typeof frameCount!=='number'||!Number.isSafeInteger(frameCount)||frameCount<=0
    ||(channels!==1&&channels!==2)||bucketCount!==Math.min(request.buckets,frameCount)
    ||!Array.isArray(peaks)||peaks.length!==bucketCount)throw new Error('Invalid waveform response dimensions.');
  const expectedDuration=1000*frameCount/sampleRate;
  if(typeof durationMs!=='number'||!Number.isFinite(durationMs)||durationMs<=0
    ||Math.abs(durationMs-expectedDuration)>Math.max(1,expectedDuration)*Number.EPSILON*8)throw new Error('Invalid waveform response duration.');
  for(const input of peaks){
    const peak=fields(input,['min','max']),min=peak.min,max=peak.max;
    if(!Array.isArray(min)||!Array.isArray(max)||min.length!==2||max.length!==2
      ||[...min,...max].some(value=>typeof value!=='number'||!Number.isFinite(value))
      ||min[0]>max[0]||min[1]>max[1])throw new Error('Invalid waveform response peaks.');
  }
}

function fields(value:unknown,names:readonly string[]):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw new Error('Invalid waveform request fields.');
  return value as Record<string,unknown>;
}
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function validateBackingWaveformRequest(value:unknown):asserts value is BackingWaveformRequest {
  const request=fields(value,['owner','document','source','buckets']);
  const owner=fields(request.owner,['documentId','activationId']);
  const document=fields(request.document,['documentId','revision']);
  if(typeof owner.documentId!=='string'||!owner.documentId||typeof owner.activationId!=='string'||!owner.activationId
    ||document.documentId!==owner.documentId||typeof document.revision!=='number'||!Number.isSafeInteger(document.revision)||document.revision<0)throw new Error('Invalid waveform document address.');
  if(typeof request.buckets!=='number'||!Number.isInteger(request.buckets)||request.buckets<1||request.buckets>MAX_WAVEFORM_BUCKETS)throw new Error('Waveform bucket count must be between 1 and 8192.');
  const input=request.source;
  if(input===null||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid waveform source.');
  const kind=(input as Record<string,unknown>).kind;
  if(kind==='asset'){
    const source=fields(input,['kind','assetId']);
    if(!digest(source.assetId))throw new Error('Invalid waveform asset digest.');
  }else if(kind==='embedded'){
    const source=fields(input,['kind','sourceKey','sha256','bytesBase64']);
    if(!digest(source.sourceKey)||!digest(source.sha256)||typeof source.bytesBase64!=='string')throw new Error('Invalid embedded waveform source.');
  }else throw new Error('Invalid waveform source kind.');
}
