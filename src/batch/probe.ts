/**
 * Reads a score file in a Worker first, under a deadline, so a file that makes the importer spin or allocate
 * without end costs a terminated Worker instead of a frozen window. Callers parse on the window thread
 * only after a probe passes. The Worker uses the importer alone (the GP reader needs `DOMParser`, which Workers
 * lack), so a pass means the stock reader accepts the file, not that conversion succeeds.
 */
export const PROBE_DEADLINE_MS=15000;
export const PROBE_MAX_BYTES=32*1024*1024;

export type ProbeResult={ok:true;tracks:number;bars:number}|{ok:false;error:string};
export interface ProbeWorker{
  onmessage:((event:{data:unknown})=>void)|null;
  onerror:((event:{message?:string;preventDefault?:()=>void})=>void)|null;
  onmessageerror:((event:unknown)=>void)|null;
  postMessage(message:unknown,transfer?:Transferable[]):void;
  terminate():void;
}
export interface ProbeOptions{
  deadlineMs?:number;
  signal?:AbortSignal;
  /** Replaces the real Worker, for tests. */
  createWorker?:()=>ProbeWorker;
}
export type Probe=(bytes:Uint8Array,options?:ProbeOptions)=>Promise<ProbeResult>;

const realWorker=():ProbeWorker=>new Worker(new URL('./probe.worker.ts',import.meta.url),{type:'module'}) as unknown as ProbeWorker;

export const probeScoreBytes:Probe=(bytes,options={})=>{
  const {deadlineMs=PROBE_DEADLINE_MS,signal,createWorker=realWorker}=options;
  if(bytes.length>PROBE_MAX_BYTES)return Promise.resolve({ok:false,error:`The file is larger than ${PROBE_MAX_BYTES/(1024*1024)} MiB.`});
  return new Promise<ProbeResult>(resolve=>{
    let worker:ProbeWorker|null=null,timer:ReturnType<typeof setTimeout>|undefined,finished=false;
    const finish=(result:ProbeResult)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
      resolve(result);
    };
    const cancel=()=>finish({ok:false,error:'The check was cancelled.'});
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>finish({ok:false,error:`The file did not open within ${Math.round(deadlineMs/1000)} seconds, so it was left out. It may be damaged.`}),deadlineMs);
    try{
      worker=createWorker();
      worker.onmessage=event=>{
        const data=event.data as Partial<ProbeResult>|null;
        if(data&&data.ok===true&&Number.isSafeInteger((data as {tracks?:number}).tracks)&&Number.isSafeInteger((data as {bars?:number}).bars))finish(data as ProbeResult);
        else if(data&&data.ok===false&&typeof data.error==='string')finish({ok:false,error:data.error});
        else finish({ok:false,error:'The file check returned an invalid answer.'});
      };
      worker.onerror=event=>{event.preventDefault?.();finish({ok:false,error:event.message?`The file check failed: ${event.message}`:'The file check failed.'});};
      worker.onmessageerror=()=>finish({ok:false,error:'The file check answer could not be read.'});
      // The Worker gets its own copy, so the caller keeps the bytes it will parse.
      const copy=bytes.slice();worker.postMessage({bytes:copy},[copy.buffer]);
    }catch(error){finish({ok:false,error:`The file check could not start: ${error instanceof Error?error.message:String(error)}`});}
  });
};
