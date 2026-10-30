import { existsSync,readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { describe,expect,it,vi } from 'vitest';
import { PROBE_MAX_BYTES,probeScoreBytes,type ProbeWorker } from './probe';

/** A Worker that never answers, or answers as told. */
function fake(answer?:(worker:ProbeWorker,message:unknown)=>void) {
  const worker:ProbeWorker={onmessage:null,onerror:null,onmessageerror:null,postMessage:vi.fn((message:unknown)=>answer?.(worker,message)),terminate:vi.fn()};
  return worker;
}

describe('probeScoreBytes',()=>{
  it('passes what the Worker reports and terminates it',async()=>{
    const worker=fake((self,message)=>{expect((message as {bytes:Uint8Array}).bytes).toEqual(new Uint8Array([1,2,3]));queueMicrotask(()=>self.onmessage?.({data:{ok:true,tracks:2,bars:9}}));});
    const bytes=new Uint8Array([1,2,3]);
    expect(await probeScoreBytes(bytes,{createWorker:()=>worker})).toEqual({ok:true,tracks:2,bars:9});
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(bytes).toEqual(new Uint8Array([1,2,3]));
  });
  it('reports a refusal, an invalid answer and a crash as failures',async()=>{
    const answer=(data:unknown)=>fake((self)=>queueMicrotask(()=>self.onmessage?.({data})));
    expect(await probeScoreBytes(new Uint8Array(1),{createWorker:()=>answer({ok:false,error:'Unsupported format.'})})).toEqual({ok:false,error:'Unsupported format.'});
    expect(await probeScoreBytes(new Uint8Array(1),{createWorker:()=>answer({ok:true,tracks:'x'})})).toEqual({ok:false,error:'The file check returned an invalid answer.'});
    const crash=fake(self=>queueMicrotask(()=>self.onerror?.({message:'boom'})));
    expect(await probeScoreBytes(new Uint8Array(1),{createWorker:()=>crash})).toEqual({ok:false,error:'The file check failed: boom'});
    expect(crash.terminate).toHaveBeenCalled();
    expect((await probeScoreBytes(new Uint8Array(1),{createWorker:()=>{throw new Error('no workers');}}))).toEqual({ok:false,error:'The file check could not start: no workers'});
  });
  it('terminates a Worker that does not answer by the deadline',async()=>{
    const worker=fake();
    const started=performance.now(),result=await probeScoreBytes(new Uint8Array(1),{deadlineMs:60,createWorker:()=>worker});
    expect(result.ok).toBe(false);expect(!result.ok&&result.error).toContain('did not open within');
    expect(worker.terminate).toHaveBeenCalledTimes(1);expect(performance.now()-started).toBeLessThan(2000);
  });
  it('ignores a late answer after the deadline and honours cancel',async()=>{
    const worker=fake();
    const result=await probeScoreBytes(new Uint8Array(1),{deadlineMs:20,createWorker:()=>worker});
    worker.onmessage?.({data:{ok:true,tracks:1,bars:1}});
    expect(result.ok).toBe(false);
    const controller=new AbortController(),pending=probeScoreBytes(new Uint8Array(1),{createWorker:()=>fake(),signal:controller.signal});
    controller.abort();expect(await pending).toEqual({ok:false,error:'The check was cancelled.'});
  });
  it('refuses a file over the size cap without starting a Worker',async()=>{
    const create=vi.fn();
    const result=await probeScoreBytes(new Uint8Array(PROBE_MAX_BYTES+1),{createWorker:create});
    expect(result).toEqual({ok:false,error:'The file is larger than 32 MiB.'});expect(create).not.toHaveBeenCalled();
  });

  // The saved case from the security review: the GPX reader spins forever on this archive. A real thread runs the
  // importer, as the probe Worker does; the probe must come back Failed by its deadline and the thread must be gone.
  const stall=process.env.TABPLAYER_STALL_CASE??resolve('.analysis/stall.bin');
  it.skipIf(!existsSync(stall))('returns Failed for a corrupt GPX that hangs the importer, and ends its thread',async()=>{
    const require=createRequire(resolve('package.json')),alphaTab=require.resolve('@coderline/alphatab').replaceAll('\\','/');
    const bytes=new Uint8Array(readFileSync(stall));
    let thread:NodeWorker|null=null,accept=()=>{};
    const exited=new Promise<void>(resolveExit=>{accept=resolveExit;});
    const create=():ProbeWorker=>{
      thread=new NodeWorker(`const {parentPort}=require('node:worker_threads');import('file:///${alphaTab}').then(({importer,Settings})=>{parentPort.on('message',({bytes})=>{try{const s=new Settings();s.importer.maxDecodingBufferSize=32*1024*1024;const score=importer.ScoreLoader.loadScoreFromBytes(bytes,s);parentPort.postMessage({ok:true,tracks:score.tracks.length,bars:score.masterBars.length});}catch(e){parentPort.postMessage({ok:false,error:String(e&&e.message)});}});parentPort.postMessage('ready');});`,{eval:true});
      thread.on('exit',()=>accept());
      const worker:ProbeWorker={onmessage:null,onerror:null,onmessageerror:null,
        // The importer module loads first; the request goes in once the thread says it is ready.
        postMessage:message=>{thread!.on('message',value=>{if(value==='ready')thread!.postMessage(message);else worker.onmessage?.({data:value});});},
        terminate:()=>{void thread!.terminate();}};
      return worker;
    };
    const result=await probeScoreBytes(bytes,{deadlineMs:1500,createWorker:create});
    expect(result.ok).toBe(false);expect(!result.ok&&result.error).toContain('did not open within');
    await exited;
  },20000);
});
