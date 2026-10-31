import { Settings } from '@coderline/alphatab';
import { OPEN_ENTRY_LIMIT,isArchive,validateArchive } from './archive';
import { ARCHIVE_CHECK_REQUEST,ARCHIVE_CHECK_RESULT } from './archive-gate-messages';
import { prepareMusicXmlLoaderBytes } from './musicxml-tempo-offsets';
import { runWorkerCheck,type CheckFailure,type CheckOptions,type CheckWorker } from './worker-check';

/**
 * The window-side half of the file check. Every way a score reaches the window first awaits `admitDocumentBase`, which
 * runs the validator and the stock reader in a Worker under the deadline, whatever the format. `adoptAdmittedBase` then
 * refuses a base that did not pass, so a route that forgets to admit fails instead of parsing here. The parsers also call
 * `assertArchiveAccepted`, so an archive that skipped a Worker, such as a converted file read back, is validated first.
 */
/** Native reads a score of at most this size, so a larger base did not come from a file it opened. */
export const BASE_FILE_LIMIT=64*1024*1024;
const accepted=new WeakMap<Uint8Array,number>();
/** Base files a Worker read, by the SHA-256 native verifies for every project it hands over. A project replays its base on each edit. */
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

function runCheck(bytes:Uint8Array,entryLimit:number,read:boolean,options:CheckOptions):Promise<{ok:true}|CheckFailure> {
  return runWorkerCheck<{ok:true}|CheckFailure>({
    createWorker:options.createWorker??realWorker,
    request:()=>{const copy=bytes.slice();return {message:{cmd:ARCHIVE_CHECK_REQUEST,bytes:copy,entryLimit,read},transfer:[copy.buffer]};},
    read:data=>{
      const answer=data as {cmd?:string;ok?:boolean;error?:unknown}|null;
      if(!answer||answer.cmd!==ARCHIVE_CHECK_RESULT)return undefined;
      if(answer.ok===true)return {ok:true};
      return {ok:false,error:typeof answer.error==='string'?answer.error:'The file check returned an invalid answer.'};
    },
    deadlineError:seconds=>`The file did not open within ${seconds} seconds. It may be damaged.`,
  },options);
}

/** Runs the validator in a Worker under the deadline. Throws why the bytes were refused. */
export async function checkArchiveInWorker(bytes:Uint8Array,entryLimit:number,options:CheckOptions={}):Promise<void> {
  const result=await runCheck(bytes,entryLimit,false,options);
  if(!result.ok)throw new Error(result.error);
  acceptArchive(bytes,entryLimit);
}

const decode=(encoded:string)=>Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
/**
 * Reads a project's base file in a Worker, once per file, before anything builds the document. An archive is validated
 * first, because the MusicXML preparation unzips it on this thread. The stock reader then gets the prepared bytes, which
 * are exactly what the window's parser will give it. Throws why the file was refused, and nothing has been built.
 */
export async function admitDocumentBase(project:{base?:{kind:string;bytesBase64?:string;sha256?:string}},options:CheckOptions={}):Promise<void> {
  const base=project.base;
  if(base?.kind!=='file'||typeof base.bytesBase64!=='string'||typeof base.sha256!=='string'||admitted.has(base.sha256))return;
  // Only a test environment has no Worker; such a run has no thread to spare the parsers from.
  if(!options.createWorker&&typeof Worker==='undefined')return;
  if(Math.floor(base.bytesBase64.length/4)*3>BASE_FILE_LIMIT+3)throw new Error(`The file is larger than ${BASE_FILE_LIMIT/(1024*1024)} MiB.`);
  const bytes=decode(base.bytesBase64);
  if(isArchive(bytes))await checkArchiveInWorker(bytes,OPEN_ENTRY_LIMIT,options);
  const result=await runCheck(prepareMusicXmlLoaderBytes(bytes,new Settings()),OPEN_ENTRY_LIMIT,true,options);
  if(!result.ok)throw new Error(result.error);
  admitted.add(base.sha256);
}

/** Lets freshly decoded base bytes reach the parsers. Refuses a base no Worker has read, wherever Workers exist. */
export function adoptAdmittedBase(sha256:string,bytes:Uint8Array):void {
  if(admitted.has(sha256))acceptArchive(bytes,OPEN_ENTRY_LIMIT);
  else if(typeof Worker!=='undefined')throw new Error('This file has not passed the file check.');
}
