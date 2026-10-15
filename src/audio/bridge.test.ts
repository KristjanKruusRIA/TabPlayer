import {expect,it,vi} from 'vitest';
const nativeInvoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:nativeInvoke}));
it('transport commands retain UI sequence while invalidation bypasses pending controls',async()=>{
  vi.resetModules();const {nativeAudioBridge}=await import('./bridge');let acknowledge!:()=>void;
  nativeInvoke.mockImplementation((name:string,args:{command:{type:string}})=>name==='audio_command'&&args.command.type==='play'?new Promise<void>(resolve=>{acknowledge=resolve;}):Promise.resolve());
  const playing=nativeAudioBridge.command({type:'play',generation:1});const paused=nativeAudioBridge.command({type:'pause',generation:1});
  await Promise.resolve();expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play']);
  await nativeAudioBridge.command({type:'invalidate',generation:2});expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play','invalidate']);
  acknowledge();await playing;await paused;expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play','invalidate','pause']);
});

it('queues the complete practice command unchanged behind earlier transport controls',async()=>{
  vi.resetModules();nativeInvoke.mockClear();const {nativeAudioBridge}=await import('./bridge');let release!:()=>void;
  nativeInvoke.mockImplementation((name:string,args:{command:{type:string}})=>name==='audio_command'&&args.command.type==='play'?new Promise<void>(resolve=>{release=resolve;}):Promise.resolve());
  const settings={tempo:{kind:'progressive' as const,start:.5,end:1,step:.2,repetitions:2},metronome:{enabled:true,volume:0,visual:true},countIn:{bars:1,betweenLoops:true}};
  const first=nativeAudioBridge.command({type:'play',generation:5}),second=nativeAudioBridge.command({type:'setPractice',generation:5,settings});
  await Promise.resolve();expect(nativeInvoke.mock.calls.map(call=>call[1].command.type)).toEqual(['play']);release();await first;await second;
  expect(nativeInvoke.mock.calls).toEqual([['audio_command',{command:{type:'play',generation:5}}],['audio_command',{command:{type:'setPractice',generation:5,settings}}]]);
});
