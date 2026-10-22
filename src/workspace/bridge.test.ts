import {afterEach,expect,it,vi} from 'vitest';
import type {PlaybackPlan} from '../audio/types';
import type {DocumentSettings} from '../edit-types';
import type {NativeAudioExportPayload} from '../export/bridge';

const native=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),message:vi.fn(),confirm:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
vi.mock('@tauri-apps/plugin-dialog',()=>({message:native.message,confirm:native.confirm}));
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});

async function bridges(desktopTest=false){
  vi.stubEnv('VITE_DESKTOP_TEST',desktopTest?'1':'0');vi.resetModules();native.invoke.mockResolvedValue(undefined);
  return {document:await import('../bridge'),audio:await import('../audio/bridge'),exports:await import('../export/bridge')};
}

it('addresses every document mutation with the captured document and supplied revision',async()=>{
  const {document:api}=await bridges(),bridge=api.createDocumentBridge('document-a');
  const command={type:'setRest' as const,target:{track:0,staff:0,bar:0,voice:0,beat:0}};
  await bridge.snapshot();await bridge.applyEdit(command,3,'asset-a');await bridge.undo(4);await bridge.redo(5);await bridge.saveProject(true,6);await bridge.exportGp(new Uint8Array([8,9]),7);await bridge.exportGp(new Uint8Array([1]),8,'Song');await bridge.cancelAsset('asset-a');
  expect(bridge.documentId).toBe('document-a');
  expect(native.invoke.mock.calls).toEqual([
    ['project_snapshot',{documentId:'document-a'}],
    ['apply_edit',{document:{documentId:'document-a',revision:3},command,assetToken:'asset-a'}],
    ['undo_edit',{document:{documentId:'document-a',revision:4}}],
    ['redo_edit',{document:{documentId:'document-a',revision:5}}],
    ['save_project',{document:{documentId:'document-a',revision:6},saveAs:true}],
    ['export_gp',{document:{documentId:'document-a',revision:7},bytes:[8,9],fileName:null}],['export_gp',{document:{documentId:'document-a',revision:8},bytes:[1],fileName:'Song'}],
    ['cancel_asset',{documentId:'document-a',token:'asset-a'}],
  ]);
  expect(api).not.toHaveProperty('nativeBridge');
});

it('keeps intake and close decisions on the explicit workspace bridge',async()=>{
  const {document:api}=await bridges(),bridge=api.nativeWorkspaceBridge,documents=[{documentId:'document-a',revision:8,discard:true}];
  await bridge.snapshot();await bridge.readDocument();await bridge.createBlankDocument();await bridge.cancelDocument('candidate-a');await bridge.addDocument('candidate-a');await bridge.activateDocument('document-b');await bridge.closeDocuments(documents);
  expect(native.invoke.mock.calls).toEqual([
    ['workspace_snapshot'],['read_document'],['new_document'],['cancel_document',{token:'candidate-a'}],['workspace_add',{token:'candidate-a'}],['workspace_activate',{documentId:'document-b'}],['workspace_close',{documents}],
  ]);
  native.message.mockResolvedValue('Cancel');expect(await api.createDocumentBridge('document-a').askUnsaved('Study','C:/scores/study.tabplayer')).toBe('cancel');
  expect(native.message.mock.calls[0][0]).toContain('Study');expect(native.message.mock.calls[0][0]).toContain('C:/scores/study.tabplayer');
});

it('requires document addresses in gated desktop-test writes too',async()=>{
  const {document:api}=await bridges(true),bridge=api.createDocumentBridge('document-b');
  await api.nativeWorkspaceBridge.readDocument();await bridge.saveProject(false,2);await bridge.exportGp(new Uint8Array([3]),3);
  expect(native.invoke.mock.calls).toEqual([
    ['desktop_test_io',{action:'read'}],['desktop_test_io',{action:'save',documentId:'document-b',revision:2}],['desktop_test_io',{action:'export',documentId:'document-b',revision:3,bytes:[3]}],
  ]);
});

it('captures activation identity for all audio mutations and stable identity for assets',async()=>{
  const {audio:api}=await bridges(),owner={documentId:'document-a',activationId:'activation-a'},bridge=api.createDocumentAudioBridge(owner);
  owner.activationId='activation-b';const captured={documentId:'document-a',activationId:'activation-a'},plan={generation:7} as PlaybackPlan,settings={} as DocumentSettings;
  await bridge.prepare(plan,settings,new Uint8Array([1]),'source-a');await bridge.setMix(settings,7);
  const commands=[{type:'play' as const,generation:7},{type:'pause' as const,generation:7},{type:'stop' as const,generation:7},{type:'clearLoop' as const,generation:7},{type:'invalidate' as const,generation:8},{type:'selectDevice' as const,generation:8,deviceId:null},{type:'seekTick' as const,generation:8,tick:960},{type:'playRange' as const,generation:8,startTick:960,endTick:null},{type:'setLoop' as const,generation:8,startTick:960,endTick:1920}];
  for(const command of commands)await bridge.command(command);
  await bridge.stageBacking();await bridge.stageEmbeddedBacking(new Uint8Array([2]));
  expect(native.invoke.mock.calls).toEqual([
    ['audio_prepare',{owner:captured,plan,settings,embeddedBytes:[1],sourceKey:'source-a',practice:null}],['audio_set_mix',{owner:captured,settings,generation:7}],
    ...commands.map(command=>['audio_command',{owner:captured,command}]),['stage_backing',{documentId:'document-a'}],['stage_embedded_backing',{documentId:'document-a',bytes:[2]}],
  ]);
  expect(api).not.toHaveProperty('nativeAudioBridge');
});

it('isolates owner command queues and preserves prompt invalidation plus global read-only status',async()=>{
  const {audio:api}=await bridges();let release!:()=>void;
  native.invoke.mockImplementation((name,args)=>name==='audio_command'&&args.command.type==='play'&&args.command.generation===1?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve());
  const a=api.createDocumentAudioBridge({documentId:'a',activationId:'a1'}),b=api.createDocumentAudioBridge({documentId:'b',activationId:'b1'});
  const first=a.command({type:'play',generation:1}),second=a.command({type:'pause',generation:1});await Promise.resolve();
  await b.command({type:'play',generation:2});await a.command({type:'invalidate',generation:3});
  expect(native.invoke.mock.calls.map(([,args])=>args.command.type)).toEqual(['play','play','invalidate']);release();await first;await second;
  expect(native.invoke.mock.calls.at(-1)).toEqual(['audio_command',{owner:{documentId:'a',activationId:'a1'},command:{type:'pause',generation:1}}]);
  native.invoke.mockClear();await b.devices();await b.status();expect(native.invoke.mock.calls).toEqual([['audio_devices'],['audio_status']]);
  const listener=vi.fn();native.listen.mockImplementation(async(_name,callback)=>{callback({payload:{generation:2}});return ()=>{};});await b.subscribe(listener);
  expect(native.listen.mock.calls[0][0]).toBe('native-audio-status');expect(listener).toHaveBeenCalledWith({generation:2});
});

it('freezes export origin and sends the captured revision with every export kind',async()=>{
  const {exports:api}=await bridges(),bridge=api.createDocumentExportBridge('document-a'),payload={stems:true} as NativeAudioExportPayload;
  await bridge.exportPdf([],true,2,null);await bridge.exportMidi(new Uint8Array([4]),3,'Song');await bridge.exportMusicXml(new Uint8Array([60]),5,'Song');await bridge.exportSvg([{svg:'<svg/>',widthMm:210,heightMm:297}],6,'Song');await bridge.exportPng([{svg:'<svg/>',widthMm:210,heightMm:297}],150,8,'Song');await bridge.exportAudio(payload,4,'Song');await bridge.exportTrackFiles('png',[{name:'1 Lead',pages:[{svg:'<svg/>',widthMm:210,heightMm:297}]}],150,9);await bridge.status('job-a');await bridge.cancel('job-a');
  expect(native.invoke.mock.calls).toEqual([
    ['export_pdf',{document:{documentId:'document-a',revision:2},pages:[],print:true,fileName:null}],['export_midi',{document:{documentId:'document-a',revision:3},bytes:[4],fileName:'Song'}],['export_musicxml',{document:{documentId:'document-a',revision:5},bytes:[60],fileName:'Song'}],['export_svg',{document:{documentId:'document-a',revision:6},pages:[{svg:'<svg/>',widthMm:210,heightMm:297}],fileName:'Song'}],['export_png',{document:{documentId:'document-a',revision:8},pages:[{svg:'<svg/>',widthMm:210,heightMm:297}],dpi:150,fileName:'Song'}],['export_audio',{document:{documentId:'document-a',revision:4},...payload,fileName:'Song'}],['export_track_files',{document:{documentId:'document-a',revision:9},format:'png',files:[{name:'1 Lead',pages:[{svg:'<svg/>',widthMm:210,heightMm:297}]}],dpi:150}],['export_status',{documentId:'document-a',id:'job-a'}],['cancel_export',{documentId:'document-a',id:'job-a'}],
  ]);
  expect(api).not.toHaveProperty('nativeExportBridge');
});

it.each([false,true])('notifies the exact successful native save response in production or desktop mode %s without changing save outcome',async desktopTest=>{
  const {document:api}=await bridges(desktopTest),record={documentId:'saved',revision:8,snapshot:{path:'C:/scores/saved.tabplayer'}},failure=new Error('History unavailable.'),saved=vi.fn().mockRejectedValue(failure),failed=vi.fn();
  const bridge=api.createDocumentBridge('saved',{saved,failed});native.invoke.mockResolvedValueOnce(record);
  expect(await bridge.saveProject(true,7)).toBe(record);await vi.waitFor(()=>expect(failed).toHaveBeenCalledWith(failure));expect(saved).toHaveBeenCalledExactlyOnceWith(record);
  saved.mockClear();native.invoke.mockResolvedValueOnce(null);expect(await bridge.saveProject(false,8)).toBeNull();expect(saved).not.toHaveBeenCalled();
  native.invoke.mockRejectedValueOnce(new Error('Write failed.'));await expect(bridge.saveProject(false,8)).rejects.toThrow('Write failed.');expect(saved).not.toHaveBeenCalled();
});
it('a response for a different document cannot trigger successful-save metadata notification',async()=>{
  const {document:api}=await bridges(),saved=vi.fn(),failed=vi.fn(),bridge=api.createDocumentBridge('requested',{saved,failed});native.invoke.mockResolvedValueOnce({documentId:'other',revision:9,snapshot:{}});await bridge.saveProject(false,8);await Promise.resolve();expect(saved).not.toHaveBeenCalled();
});
