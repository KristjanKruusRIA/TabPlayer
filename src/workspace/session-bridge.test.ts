import {afterEach,expect,it,vi} from 'vitest';
import type {RecoveryStatus,SessionResolution,SessionStartup} from './recovery-types';
import type {CloseDocument,DocumentViewState} from './types';

const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
afterEach(()=>{vi.resetAllMocks();});

it('reads startup and recovery status without sending frontend recovery or music payloads',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  const startup:SessionStartup={preferences:{version:1,restorePreviousSession:true},preview:null};
  const status:RecoveryStatus={state:'failed',capturedAtUnixMs:1400,generation:2,error:'Disk full'};
  const retried:RecoveryStatus={state:'pending',capturedAtUnixMs:1400,generation:2,error:null};
  native.invoke.mockResolvedValueOnce(startup).mockResolvedValueOnce(status).mockResolvedValueOnce(retried);
  expect(await bridge.startup()).toBe(startup);
  expect(await bridge.status()).toBe(status);
  expect(await bridge.retry()).toBe(retried);
  expect(native.invoke.mock.calls).toEqual([['session_startup'],['recovery_status'],['recovery_retry']]);
});

it('resolves only the supplied token and ordered successful document IDs, including explicit empty resolution',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  const documentIds=Object.freeze(['document-b','document-a']);
  const resolution:SessionResolution={workspace:{documents:[],active:{documentId:'new-blank',activationId:'fresh'}},views:{},issues:[{documentId:'excluded',message:'Score could not be built'}]};
  native.invoke.mockResolvedValue(resolution);
  expect(await bridge.resolve('preview-token',documentIds)).toBe(resolution);
  await bridge.resolve('discard-token',[]);
  await bridge.resolve(null,[]);
  expect(native.invoke.mock.calls).toEqual([
    ['session_resolve',{token:'preview-token',documentIds:['document-b','document-a']}],
    ['session_resolve',{token:'discard-token',documentIds:[]}],
    ['session_resolve',{token:null,documentIds:[]}],
  ]);
  expect(native.invoke.mock.calls[0][1].documentIds).toBe(documentIds);
});

it('attaches a reloaded webview through its own command, never session_resolve',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  native.invoke.mockResolvedValue({workspace:{documents:[],active:{documentId:'a',activationId:'b'}},views:{},issues:[]});
  await bridge.attach();
  expect(native.invoke.mock.calls).toEqual([['session_attach']]);
});

it('persists the complete addressed location and score display preference without activation or transport state',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  const view:DocumentViewState={target:{track:2,staff:1,bar:4,voice:0,beat:3},selectedString:4,selectedNoteIndex:1,zoom:137.5,trackView:{kind:'custom',trackIds:['track-b','track-a']},instrumentVisible:false,scoreDisplay:{layout:'grid',zoomMode:'fitPage'}};
  const preferences={version:1 as const,restorePreviousSession:false};
  native.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(preferences);
  await bridge.setView('stable-document',view);
  expect(await bridge.setPreferences(false)).toBe(preferences);
  expect(native.invoke.mock.calls).toEqual([
    ['workspace_set_view',{documentId:'stable-document',view:{target:{track:2,staff:1,bar:4,voice:0,beat:3},selectedString:4,selectedNoteIndex:1,zoom:137.5,trackView:{kind:'custom',trackIds:['track-b','track-a']},instrumentVisible:false,scoreDisplay:{layout:'grid',zoomMode:'fitPage'}}}],
    ['session_preferences_set',{restorePreviousSession:false}],
  ]);
  expect(native.invoke.mock.calls[0][1].view).toBe(view);
});

it('awaits native shutdown with every exact revision and discard decision and forwards resume',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  const documents:readonly CloseDocument[]=Object.freeze([
    Object.freeze({documentId:'document-b',revision:9007199254740991,discard:false}),
    Object.freeze({documentId:'document-a',revision:8,discard:true}),
  ]);
  let acknowledge!:()=>void;
  native.invoke.mockImplementationOnce(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));
  let finished=false;const closing=bridge.shutdown(documents).then(()=>{finished=true;});
  await Promise.resolve();expect(finished).toBe(false);
  expect(native.invoke.mock.calls).toEqual([['session_shutdown',{documents:[
    {documentId:'document-b',revision:9007199254740991,discard:false},
    {documentId:'document-a',revision:8,discard:true},
  ]}]]);
  expect(native.invoke.mock.calls[0][1].documents).toBe(documents);
  acknowledge();await closing;expect(finished).toBe(true);
  await bridge.resume();
  expect(native.invoke.mock.calls.at(-1)).toEqual(['session_resume']);
});

it('preserves native shutdown and view failures so callers can retain live work',async()=>{
  const {nativeSessionBridge:bridge}=await import('./session-bridge');
  const failure=new Error('Recovery commit failed');
  native.invoke.mockRejectedValue(failure);
  await expect(bridge.shutdown([{documentId:'document-a',revision:3,discard:true}])).rejects.toBe(failure);
  await expect(bridge.setView('closed-document',{target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:1,selectedNoteIndex:null,zoom:100,trackView:{kind:'selected'},instrumentVisible:true})).rejects.toBe(failure);
  expect(native.invoke.mock.calls[0]).toEqual(['session_shutdown',{documents:[{documentId:'document-a',revision:3,discard:true}]}]);
  expect(native.invoke.mock.calls[1][0]).toBe('workspace_set_view');
});
