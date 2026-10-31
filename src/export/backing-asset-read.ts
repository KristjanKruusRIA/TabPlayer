import {invoke} from '@tauri-apps/api/core';
import {MAX_EXPORT_BACKING_BYTES,validateBackingAssetReadRequest,type BackingAssetReadRequest} from './backing-asset-types';

export function validateExportBackingByteLength(byteLength:number):void {
  if(byteLength>MAX_EXPORT_BACKING_BYTES)throw new Error('Backing asset exceeds the 512 MiB export read limit.');
}

export async function readExportBackingAsset(request:BackingAssetReadRequest):Promise<Uint8Array> {
  validateBackingAssetReadRequest(request);
  const response=fields(await invoke<unknown>('read_export_backing',{request}),['document','assetId','sha256','bytesBase64']);
  const document=fields(response.document,['documentId','revision']);
  if(typeof response.bytesBase64!=='string')throw new Error('Invalid backing asset read response.');
  if(document.documentId!==request.document.documentId||document.revision!==request.document.revision
    ||response.assetId!==request.assetId||response.sha256!==request.assetId)throw new Error('Backing asset response belongs to another document or source.');
  const base64=response.bytesBase64,padding=base64.endsWith('==')?2:base64.endsWith('=')?1:0;
  validateExportBackingByteLength(Math.ceil(base64.length/4)*3-padding);
  if(base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new Error('Invalid backing asset base64.');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if(padding&&(alphabet.indexOf(base64[base64.length-padding-1])&(padding===2?15:3))!==0)throw new Error('Invalid backing asset base64.');
  const decoded=atob(base64);
  validateExportBackingByteLength(decoded.length);
  const bytes=new Uint8Array(decoded.length);
  for(let index=0;index<decoded.length;index++)bytes[index]=decoded.charCodeAt(index);
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  const sha256=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(sha256!==request.assetId)throw new Error('Backing asset bytes do not match the requested digest.');
  return bytes;
}

function fields(value:unknown,names:readonly string[]):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw new Error('Invalid backing asset read response.');
  return value as Record<string,unknown>;
}
