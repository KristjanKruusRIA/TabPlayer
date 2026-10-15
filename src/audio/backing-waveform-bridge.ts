import {MAX_WAVEFORM_BUCKETS,type BackingWaveformRequest} from './backing-waveform-types';

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
