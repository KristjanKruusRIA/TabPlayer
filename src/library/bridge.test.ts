import {afterEach,expect,it,vi} from 'vitest';
import {nativeFileLibraryBridge as bridge} from './bridge';
import type {LibraryMetadata,LibrarySource} from './types';

const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
afterEach(()=>vi.resetAllMocks());
const document={documentId:'document-b',revision:7},metadata:LibraryMetadata={title:'Evening study',artist:'TabPlayer',album:'Original studies',trackNames:['Guitar','Bass'],metadataTruncated:false};

it('passes catalog CAS and addressed template metadata without frontend canonical music',async()=>{
  const receipt={accepted:true};native.invoke.mockResolvedValue(receipt);
  expect(await bridge.snapshot()).toBe(receipt);expect(await bridge.retry()).toBe(receipt);
  expect(await bridge.change(12,{kind:'pin',id:'recent-b',pinned:true})).toBe(receipt);
  native.invoke.mockResolvedValueOnce(null);expect(await bridge.pickRoot(13)).toBeNull();
  expect(await bridge.saveTemplate(14,document,'Seven string ensemble')).toBe(receipt);expect(await bridge.ackMetadata(document,metadata)).toBe(receipt);
  expect(native.invoke.mock.calls).toEqual([
    ['file_library_snapshot'],['file_library_retry'],['file_library_change',{expectedRevision:12,change:{kind:'pin',id:'recent-b',pinned:true}}],
    ['file_library_root_pick',{expectedRevision:13}],['file_library_template_save',{expectedRevision:14,document,name:'Seven string ensemble'}],
    ['file_library_metadata_ack',{document,metadata}],
  ]);
});

it('stages only descriptor identities and native drop tokens and reveals an exact document revision',async()=>{
  const candidate={kind:'existing',documentId:'document-a'};native.invoke.mockResolvedValue(candidate);
  const sources:LibrarySource[]=[{kind:'recent',id:'recent-a'},{kind:'indexed',rootId:'root-a',id:'file-b'},{kind:'template',id:'personal-a'},{kind:'example',id:'example-groove'}];
  for(const source of sources)expect(await bridge.stage(source)).toBe(candidate);
  expect(await bridge.dropStage('native-drop-token',2)).toBe(candidate);await bridge.reveal(document);
  expect(native.invoke.mock.calls).toEqual([...sources.map(source=>['file_library_stage',{source}]),['workspace_drop_stage',{dropToken:'native-drop-token',index:2}],['file_library_reveal',{document}]]);
});

it('keeps scan jobs, file hashes, query scope and rejection identity on the fixed wire',async()=>{
  const receipt={accepted:true},result={sha256:'a'.repeat(64),metadata,error:null},query={rootId:'root-b',text:'TabPlayer bass',title:'',artist:'',instrument:'',sort:'artist' as const,offset:100,limit:100 as const};
  native.invoke.mockResolvedValue(receipt);
  expect(await bridge.scanBegin('root-b')).toBe(receipt);expect(await bridge.scanNext('job-b')).toBe(receipt);
  expect(await bridge.scanRead('job-b','file-c')).toBe(receipt);expect(await bridge.scanAccept('job-b','file-c',result)).toBe(receipt);
  expect(await bridge.scanFinish('job-b')).toBe(receipt);await bridge.scanCancel('job-b');expect(await bridge.search(query)).toBe(receipt);
  expect(native.invoke.mock.calls).toEqual([
    ['file_library_scan_begin',{rootId:'root-b'}],['file_library_scan_next',{jobId:'job-b'}],['file_library_scan_read',{jobId:'job-b',fileId:'file-c'}],
    ['file_library_scan_accept',{jobId:'job-b',fileId:'file-c',result}],['file_library_scan_finish',{jobId:'job-b'}],['file_library_scan_cancel',{jobId:'job-b'}],['file_library_search',{query}],
  ]);
  const error=new Error('The configured folder is unavailable.');native.invoke.mockRejectedValueOnce(error);await expect(bridge.scanBegin('root-b')).rejects.toBe(error);
});
