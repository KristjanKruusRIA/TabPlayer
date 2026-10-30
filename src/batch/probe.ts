import { READ_ENTRY_LIMIT } from '../interchange/archive';
import { acceptArchive } from '../interchange/archive-gate';
import { CHECK_DEADLINE_MS,runWorkerCheck,type CheckFailure,type CheckOptions,type CheckWorker } from '../interchange/worker-check';

/**
 * Reads a score file in a Worker first, under a deadline, so a file that makes the importer spin or allocate
 * without end costs a terminated Worker instead of a frozen window. Callers parse on the window thread
 * only after a probe passes. The Worker uses the importer alone (the GP reader needs `DOMParser`, which Workers
 * lack), so a pass means the stock reader accepts the file, not that conversion succeeds.
 */
export const PROBE_DEADLINE_MS=CHECK_DEADLINE_MS;
export const PROBE_MAX_BYTES=32*1024*1024;
/** Message names shared with probe.worker.ts. alphaTab listens in every Worker and reads `cmd`, so a message without one makes it throw. */
export const PROBE_REQUEST='tabplayer.batch.probe';
export const PROBE_RESULT='tabplayer.batch.probe.result';

export type ProbeResult={ok:true;tracks:number;bars:number}|CheckFailure;
export type ProbeWorker=CheckWorker;
export type ProbeOptions=CheckOptions;
export type Probe=(bytes:Uint8Array,options?:ProbeOptions)=>Promise<ProbeResult>;

const realWorker=():ProbeWorker=>new Worker(new URL('./probe.worker.ts',import.meta.url),{type:'module'}) as unknown as ProbeWorker;

export const probeScoreBytes:Probe=async(bytes,options={})=>{
  if(bytes.length>PROBE_MAX_BYTES)return {ok:false,error:`The file is larger than ${PROBE_MAX_BYTES/(1024*1024)} MiB.`};
  const result=await runWorkerCheck<ProbeResult>({
    createWorker:options.createWorker??realWorker,
    // The Worker gets its own copy, so the caller keeps the bytes it will parse.
    request:()=>{const copy=bytes.slice();return {message:{cmd:PROBE_REQUEST,bytes:copy},transfer:[copy.buffer]};},
    read:answer=>{
      const data=answer as (Partial<ProbeResult>&{cmd?:string})|null;
      // Anything else a Worker posts, such as alphaTab's own traffic, is not an answer.
      if(!data||data.cmd!==PROBE_RESULT)return undefined;
      if(data.ok===true&&Number.isSafeInteger((data as {tracks?:number}).tracks)&&Number.isSafeInteger((data as {bars?:number}).bars))return {ok:true,tracks:(data as {tracks:number}).tracks,bars:(data as {bars:number}).bars};
      if(data.ok===false&&typeof data.error==='string')return {ok:false,error:data.error};
      return {ok:false,error:'The file check returned an invalid answer.'};
    },
    deadlineError:seconds=>`The file did not open within ${seconds} seconds, so it was left out. It may be damaged.`,
  },options);
  // The Worker ran the archive validator before the importer, on a copy of these bytes.
  if(result.ok)acceptArchive(bytes,READ_ENTRY_LIMIT);
  return result;
};
