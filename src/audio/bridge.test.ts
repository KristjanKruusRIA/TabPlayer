import {expect,it,vi} from 'vitest';
const nativeInvoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:nativeInvoke}));
const owner={documentId:'document-test',activationId:'activation-test'};
it('transport commands retain UI sequence while invalidation bypasses pending controls',async()=>{
  vi.resetModules();const {createDocumentAudioBridge}=await import('./bridge');const nativeAudioBridge=createDocumentAudioBridge(owner);let acknowledge!:()=>void;
  nativeInvoke.mockImplementation((name:string,args:{command:{type:string}})=>name==='audio_command'&&args.command.type==='play'?new Promise<void>(resolve=>{acknowledge=resolve;}):Promise.resolve());
  const playing=nativeAudioBridge.command({type:'play',generation:1});const paused=nativeAudioBridge.command({type:'pause',generation:1});
  await Promise.resolve();expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play']);
  await nativeAudioBridge.command({type:'invalidate',generation:2});expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play','invalidate']);
  acknowledge();await playing;await paused;expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play','invalidate','pause']);
});

it('queues the complete practice command unchanged behind earlier transport controls',async()=>{
  vi.resetModules();nativeInvoke.mockClear();const {createDocumentAudioBridge}=await import('./bridge');const nativeAudioBridge=createDocumentAudioBridge(owner);let release!:()=>void;
  nativeInvoke.mockImplementation((name:string,args:{command:{type:string}})=>name==='audio_command'&&args.command.type==='play'?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve());
  const settings={tempo:{kind:'progressive' as const,start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:1,betweenLoops:true}};
  const first=nativeAudioBridge.command({type:'play',generation:5}),second=nativeAudioBridge.command({type:'setPractice',generation:5,settings});
  await Promise.resolve();expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play']);release();await first;await second;
  expect(nativeInvoke.mock.calls).toEqual([['audio_command',{owner,command:{type:'play',generation:5}}],['audio_command',{owner,command:{type:'setPractice',generation:5,settings}}]]);
});

it('queues complete finite and nullable end playRange commands unchanged',async()=>{
  vi.resetModules();nativeInvoke.mockClear();nativeInvoke.mockResolvedValue(undefined);
  const {createDocumentAudioBridge}=await import('./bridge');const nativeAudioBridge=createDocumentAudioBridge(owner);
  const finite={type:'playRange' as const,generation:7,startTick:960,endTick:1920},ordinary={...finite,endTick:null};
  await nativeAudioBridge.command(finite);await nativeAudioBridge.command(ordinary);
  expect(nativeInvoke.mock.calls).toEqual([['audio_command',{owner,command:finite}],['audio_command',{owner,command:ordinary}]]);
});

it('sends audition requests with the owner, bypassing the transport command queue',async()=>{
  vi.resetModules();nativeInvoke.mockClear();
  const {createDocumentAudioBridge}=await import('./bridge');const nativeAudioBridge=createDocumentAudioBridge(owner);let release!:()=>void;
  nativeInvoke.mockImplementation((name:string,args:{command?:{type:string}})=>name==='audio_command'&&args.command?.type==='play'?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve(name==='audio_audition'?{played:true}:undefined));
  const request={voice:{voiceId:null,presetId:'clean' as const,effects:{} as never},program:24,percussion:false,mix:{gain:.8,pan:-.25,mute:true,solo:false},notes:[{key:40,startMs:0,velocity:96},{key:45,startMs:60,velocity:96}],durationMs:1500};
  const playing=nativeAudioBridge.command({type:'play',generation:3});await Promise.resolve();
  await expect(nativeAudioBridge.audition!(request)).resolves.toEqual({played:true});
  expect(nativeInvoke.mock.calls).toEqual([['audio_command',{owner,command:{type:'play',generation:3}}],['audio_audition',{owner,request}]]);
  release();await playing;
});

it('calls the native diagnostics and test tone commands by their registered names',async()=>{
  vi.resetModules();nativeInvoke.mockReset();nativeInvoke.mockResolvedValue({});
  const {createDocumentAudioBridge}=await import('./bridge');const nativeAudioBridge=createDocumentAudioBridge(owner);
  await nativeAudioBridge.diagnostics!();await nativeAudioBridge.testTone!();
  expect(nativeInvoke.mock.calls.map(call=>call[0])).toEqual(['audio_diagnostics','audio_test_tone']);
});
