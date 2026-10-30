import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { strToU8,zipSync } from 'fflate';
import { describe,expect,it,vi } from 'vitest';
import { PROBE_MAX_BYTES,PROBE_REQUEST,PROBE_RESULT,probeScoreBytes,type ProbeWorker } from './probe';

const answer=(data:unknown)=>({cmd:PROBE_RESULT,...(data as object)});
/** A Worker that never answers, or answers as told. */
function fake(respond?:(worker:ProbeWorker,message:unknown)=>void) {
  const worker:ProbeWorker={onmessage:null,onerror:null,onmessageerror:null,postMessage:vi.fn((message:unknown)=>respond?.(worker,message)),terminate:vi.fn()};
  return worker;
}

describe('probeScoreBytes with stand-in Workers',()=>{
  it('sends a request alphaTab ignores, passes what the Worker reports and terminates it',async()=>{
    const worker=fake((self,message)=>{
      const request=message as {cmd:string;bytes:Uint8Array};
      // alphaTab reads `cmd` of every message in any Worker, so a request without one makes its listener throw.
      expect(request.cmd).toBe(PROBE_REQUEST);expect(request.bytes).toEqual(new Uint8Array([1,2,3]));
      queueMicrotask(()=>self.onmessage?.({data:answer({ok:true,tracks:2,bars:9})}));
    });
    const bytes=new Uint8Array([1,2,3]);
    expect(await probeScoreBytes(bytes,{createWorker:()=>worker})).toEqual({ok:true,tracks:2,bars:9});
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(bytes).toEqual(new Uint8Array([1,2,3]));
  });
  it('reports a refusal, an invalid answer and a crash as failures, and ignores unrelated messages',async()=>{
    const reply=(data:unknown)=>fake(self=>queueMicrotask(()=>self.onmessage?.({data})));
    expect(await probeScoreBytes(new Uint8Array(1),{createWorker:()=>reply(answer({ok:false,error:'Unsupported format.'}))})).toEqual({ok:false,error:'Unsupported format.'});
    expect(await probeScoreBytes(new Uint8Array(1),{createWorker:()=>reply(answer({ok:true,tracks:'x'}))})).toEqual({ok:false,error:'The file check returned an invalid answer.'});
    // alphaTab's own traffic, or an answer without the result name, is not an answer: the deadline decides.
    expect((await probeScoreBytes(new Uint8Array(1),{deadlineMs:40,createWorker:()=>reply({ok:true,tracks:1,bars:1})})).ok).toBe(false);
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
    worker.onmessage?.({data:answer({ok:true,tracks:1,bars:1})});
    expect(result.ok).toBe(false);
    const controller=new AbortController(),pending=probeScoreBytes(new Uint8Array(1),{createWorker:()=>fake(),signal:controller.signal});
    controller.abort();expect(await pending).toEqual({ok:false,error:'The check was cancelled.'});
  });
  it('refuses a file over the size cap without starting a Worker',async()=>{
    const create=vi.fn();
    const result=await probeScoreBytes(new Uint8Array(PROBE_MAX_BYTES+1),{createWorker:create});
    expect(result).toEqual({ok:false,error:'The file is larger than 32 MiB.'});expect(create).not.toHaveBeenCalled();
  });
});

/**
 * The real worker module (probe.worker.ts, run from source) on a Node thread that behaves like a browser Worker for what
 * alphaTab looks at: `WorkerGlobalScope` exists, so alphaTab starts its own worker code and registers its own "message"
 * listeners on the global, and a listener that throws is reported as an error. It proves the module loads and answers
 * with alphaTab's listeners present, that the message names match probe.ts, and what the importer does with real and
 * damaged files. It cannot prove how a bundler packages the module (`new URL(..., import.meta.url)`), module Workers or
 * structured clone and transfer in the webview, or how the webview reports a throwing listener: the desktop driver does.
 */
const workerUrl=pathToFileURL(resolve('src/batch/probe.worker.ts')).href;
function realWorker():ProbeWorker & {thread:NodeWorker} {
  const bootstrap=`
    const {parentPort}=require('node:worker_threads');
    globalThis.WorkerGlobalScope=function WorkerGlobalScope(){};
    globalThis.self=globalThis;
    const listeners=[];
    globalThis.addEventListener=(type,listener)=>{if(type==='message')listeners.push(listener);};
    globalThis.postMessage=value=>parentPort.postMessage(value);
    parentPort.on('message',data=>{for(const listener of listeners){try{listener({data});}catch(error){parentPort.postMessage({__workerError:String(error&&error.message)});}}});
    import(${JSON.stringify(workerUrl)}).then(()=>parentPort.postMessage({__ready:true}),error=>parentPort.postMessage({__workerError:'load failed: '+(error&&error.message)}));`;
  const thread=new NodeWorker(bootstrap,{eval:true});
  const queued:{message:unknown;transfer?:Transferable[]}[]=[];let ready=false;
  const worker:ProbeWorker&{thread:NodeWorker}={thread,onmessage:null,onerror:null,onmessageerror:null,
    postMessage:(message)=>{if(ready)thread.postMessage(message);else queued.push({message});},
    terminate:()=>{void thread.terminate();}};
  thread.on('message',(value:{__ready?:boolean;__workerError?:string})=>{
    if(value?.__ready){ready=true;for(const item of queued.splice(0))thread.postMessage(item.message);}
    else if(value?.__workerError!==undefined)worker.onerror?.({message:value.__workerError});
    else worker.onmessage?.({data:value});
  });
  thread.on('error',(error:Error)=>worker.onerror?.({message:error.message}));
  return worker;
}
const musicXml=strToU8('<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>');
const compatibility=process.env.TABPLAYER_COMPATIBILITY_DIR??resolve('.analysis/compatibility');
const stall=process.env.TABPLAYER_STALL_CASE;

describe('probeScoreBytes with the real worker module',()=>{
  it('keeps the message names in step with probe.ts',()=>{
    const source=readFileSync(resolve('src/batch/probe.worker.ts'),'utf8');
    expect(source).toContain(`'${PROBE_REQUEST}'`);expect(source).toContain(`'${PROBE_RESULT}'`);
    expect(source).toContain('settings.importer.maxDecodingBufferSize=READ_ENTRY_LIMIT');
    expect(source.indexOf('validateArchive(request.bytes')).toBeLessThan(source.indexOf('loadScoreFromBytes'));
  });
  it('is the case that failed every file: a message without a cmd makes alphaTab throw in the Worker',async()=>{
    const worker=realWorker();
    const failure=await new Promise<string>(accept=>{
      worker.onerror=event=>accept(event.message??'');
      worker.onmessage=event=>accept(`answered: ${JSON.stringify(event.data)}`);
      worker.postMessage({bytes:musicXml});
    });
    worker.terminate();
    expect(failure).toMatch(/startsWith|cmd/);
  });
  it('opens a real score through the worker while alphaTab\'s own listeners are present',async()=>{
    const result=await probeScoreBytes(musicXml,{createWorker:realWorker});
    expect(result).toMatchObject({ok:true,tracks:1,bars:1});
  },20000);
  it('reports bytes that are not a score as a failure, not a crash',async()=>{
    const result=await probeScoreBytes(strToU8('not a score'),{createWorker:realWorker});
    expect(result.ok).toBe(false);expect(!result.ok&&result.error.length).toBeGreaterThan(0);
  },20000);
  it('refuses a lying archive in the Worker, with the validator ahead of the importer',async()=>{
    const crafted=zipSync({'Content/score.gpif':strToU8('<GPIF/>')},{level:0}),view=new DataView(crafted.buffer,crafted.byteOffset,crafted.byteLength);
    // The stored entry now declares one byte in its local header only.
    view.setUint32(22,1,true);
    const result=await probeScoreBytes(crafted,{createWorker:realWorker});
    expect(result).toEqual({ok:false,error:'ZIP local/central declaration mismatch.'});
  },20000);
  it.skipIf(!existsSync(resolve(compatibility,'guitarpro5-notes.gp5')))('opens each public legacy file through the worker',async()=>{
    for(const name of ['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx','guitarpro7-notes.gp','guitarpro7-bends.gp','guitarpro8-beat-tempo-change.gp']){
      const result=await probeScoreBytes(new Uint8Array(readFileSync(resolve(compatibility,name))),{createWorker:realWorker});
      expect(result,name).toMatchObject({ok:true});
    }
  },60000);
  // The saved case from the security review: the GPX reader spins forever on this archive.
  it.skipIf(!stall||!existsSync(stall))('returns Failed for a corrupt GPX that hangs the importer, and ends the thread',async()=>{
    let created:ProbeWorker&{thread:NodeWorker};
    const result=await probeScoreBytes(new Uint8Array(readFileSync(stall!)),{deadlineMs:2500,createWorker:()=>created=realWorker()});
    expect(result.ok).toBe(false);expect(!result.ok&&result.error).toContain('did not open within');
    await new Promise<void>(accept=>created.thread.on('exit',()=>accept()));
  },30000);
});
