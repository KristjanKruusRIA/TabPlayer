import { invoke } from '@tauri-apps/api/core';
import type { BatchBridge,BatchScan,BatchWritten } from './convert';

export const nativeBatchBridge:BatchBridge={
  pickFolder:role=>invoke<string|null>('batch_pick_folder',{role}),
  scan:kinds=>invoke<BatchScan>('batch_scan',{kinds}),
  read:async index=>new Uint8Array(await invoke<ArrayBuffer>('batch_read',{index})),
  // The bytes go as the raw request body; the index and option travel in headers.
  write:(index,bytes,keepFolders)=>invoke<BatchWritten>('batch_write',bytes,{headers:{'x-batch-index':String(index),'x-batch-keep-folders':keepFolders?'1':'0'}}),
  reset:()=>invoke<void>('batch_reset'),
};
