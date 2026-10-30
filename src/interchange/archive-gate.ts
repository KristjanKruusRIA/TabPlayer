import { OPEN_ENTRY_LIMIT,isArchive,validateArchive } from './archive';
import { ARCHIVE_CHECK_REQUEST,ARCHIVE_CHECK_RESULT } from './archive-gate-messages';
import { runWorkerCheck,type CheckFailure,type CheckOptions,type CheckWorker } from './worker-check';

/**
 * The window-side half of the archive check. Every way a score reaches the window first awaits `admitDocumentBase`, which
 * validates in a Worker under the deadline. The parsers then call `assertArchiveAccepted` on those exact bytes. Bytes
 * that skipped a Worker, such as a converted file read back, are validated there and then, so no parser ever runs on
 * bytes the validator has not accepted, and a route that forgets to admit costs a bounded check instead of an open door.
 */
const accepted=new WeakMap<Uint8Array,number>();
/** Base files a Worker accepted, by the SHA-256 native verifies for every project it hands over. A project replays its base on each edit. */
const admitted=new Set<string>();

/** Records that a Worker accepted these bytes under this entry limit. */
export function acceptArchive(bytes:Uint8Array,entryLimit:number):void {accepted.set(bytes,entryLimit);}

/** Throws unless these bytes passed the validator under a limit at least as strict as `entryLimit`. */
export function assertArchiveAccepted(bytes:Uint8Array,entryLimit:number):void {
  if(!isArchive(bytes))return;
  const known=accepted.get(bytes);
  if(known!==undefined&&known<=entryLimit)return;
  validateArchive(bytes,entryLimit);
  accepted.set(bytes,entryLimit);
}

const realWorker=():CheckWorker=>new Worker(new URL('./archive.worker.ts',import.meta.url),{type:'module'}) as unknown as CheckWorker;

/** Runs the validator in a Worker under the deadline. Throws why the bytes were refused. */
export async function checkArchiveInWorker(bytes:Uint8Array,entryLimit:number,options:CheckOptions={}):Promise<void> {
  const result=await runWorkerCheck<{ok:true}|CheckFailure>({
    createWorker:options.createWorker??realWorker,
    request:()=>{const copy=bytes.slice();return {message:{cmd:ARCHIVE_CHECK_REQUEST,bytes:copy,entryLimit},transfer:[copy.buffer]};},
    read:data=>{
      const answer=data as {cmd?:string;ok?:boolean;error?:unknown}|null;
      if(!answer||answer.cmd!==ARCHIVE_CHECK_RESULT)return undefined;
      if(answer.ok===true)return {ok:true};
      return {ok:false,error:typeof answer.error==='string'?answer.error:'The file check returned an invalid answer.'};
    },
    deadlineError:seconds=>`The file did not open within ${seconds} seconds. It may be damaged.`,
  },options);
  if(!result.ok)throw new Error(result.error);
  acceptArchive(bytes,entryLimit);
}

const decode=(encoded:string)=>Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
const startsAsArchive=(encoded:string)=>{try{return isArchive(decode(encoded.slice(0,4)));}catch{return false;}};

/** Validates a project's base file in a Worker, once per file, before anything builds the document. */
export async function admitDocumentBase(project:{base?:{kind:string;bytesBase64?:string;sha256?:string}},options:CheckOptions={}):Promise<void> {
  const base=project.base;
  if(base?.kind!=='file'||typeof base.bytesBase64!=='string'||typeof base.sha256!=='string'||admitted.has(base.sha256)||!startsAsArchive(base.bytesBase64))return;
  // Only a test environment has no Worker; the parsers then validate on the calling thread.
  if(!options.createWorker&&typeof Worker==='undefined')return;
  await checkArchiveInWorker(decode(base.bytesBase64),OPEN_ENTRY_LIMIT,options);
  admitted.add(base.sha256);
}

/** Marks freshly decoded base bytes as accepted when a Worker has already validated that file. */
export function adoptAdmittedBase(sha256:string,bytes:Uint8Array):void {
  if(admitted.has(sha256))acceptArchive(bytes,OPEN_ENTRY_LIMIT);
}
