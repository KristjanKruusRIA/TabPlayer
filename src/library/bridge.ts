import {invoke} from '@tauri-apps/api/core';
import type {NativeFileLibraryBridge} from './types';

export const nativeFileLibraryBridge:NativeFileLibraryBridge={
  snapshot:()=>invoke('file_library_snapshot'),
  retry:()=>invoke('file_library_retry'),
  change:(expectedRevision,change)=>invoke('file_library_change',{expectedRevision,change}),
  pickRoot:expectedRevision=>invoke('file_library_root_pick',{expectedRevision}),
  saveTemplate:(expectedRevision,document,name)=>invoke('file_library_template_save',{expectedRevision,document,name}),
  ackMetadata:(document,metadata)=>invoke('file_library_metadata_ack',{document,metadata}),
  stage:source=>invoke('file_library_stage',{source}),
  scanBegin:rootId=>invoke('file_library_scan_begin',{rootId}),
  scanNext:jobId=>invoke('file_library_scan_next',{jobId}),
  scanRead:(jobId,fileId)=>invoke('file_library_scan_read',{jobId,fileId}),
  scanAccept:(jobId,fileId,result)=>invoke('file_library_scan_accept',{jobId,fileId,result}),
  scanFinish:jobId=>invoke('file_library_scan_finish',{jobId}),
  scanCancel:jobId=>invoke('file_library_scan_cancel',{jobId}),
  search:query=>invoke('file_library_search',{query}),
  reveal:document=>invoke('file_library_reveal',{document}),
  dropStage:(dropToken,index)=>invoke('workspace_drop_stage',{dropToken,index}),
};
