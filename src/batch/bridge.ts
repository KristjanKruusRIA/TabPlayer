import { invoke } from '@tauri-apps/api/core';
import type { BatchBridge,BatchScan,BatchWritten } from './convert';

export const nativeBatchBridge:BatchBridge={
  pickFolder:role=>invoke<string|null>('batch_pick_folder',{role}),
  scan:kinds=>invoke<BatchScan>('batch_scan',{kinds}),
  read:async index=>new Uint8Array(await invoke<ArrayBuffer>('batch_read',{index})),
  write:(index,bytes,keepFolders)=>invoke<BatchWritten>('batch_write',{index,bytes:Array.from(bytes),keepFolders}),
};
