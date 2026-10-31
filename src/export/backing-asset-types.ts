import type {DocumentRevision} from '../workspace/types';

export const MAX_EXPORT_BACKING_BYTES=512*1024*1024;
export interface BackingAssetReadRequest {document:DocumentRevision;assetId:string}
export interface BackingAssetReadResponse extends BackingAssetReadRequest {sha256:string;bytesBase64:string}
export function validateBackingAssetReadRequest(value:unknown):asserts value is BackingAssetReadRequest {
  const exact=(candidate:unknown,keys:readonly string[]):candidate is Record<string,unknown>=>!!candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&Object.keys(candidate).length===keys.length&&keys.every(key=>Object.hasOwn(candidate,key));
  if(!exact(value,['document','assetId'])||!exact(value.document,['documentId','revision'])||typeof value.document.documentId!=='string'||!value.document.documentId.length||typeof value.document.revision!=='number'||!Number.isSafeInteger(value.document.revision)||value.document.revision<0||typeof value.assetId!=='string'||!/^[a-f0-9]{64}$/.test(value.assetId))throw new Error('Invalid backing asset read request.');
}
