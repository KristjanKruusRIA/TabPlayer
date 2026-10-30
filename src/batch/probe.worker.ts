// alphaTab registers its own "message" listeners in any Worker and reads `cmd` from every message, so requests must carry
// a `cmd` of their own. The values below are checked against probe.ts by a test. The explicit `.ts` lets the same file run
// under a bundler and, in tests, straight from source.
// @ts-expect-error TS5097: the compiler is not configured for extensions, and Node needs one to run this file from source.
import { READ_ENTRY_LIMIT } from '../interchange/archive.ts';
// @ts-expect-error TS5097: as above.
import { readInWorker } from '../interchange/worker-read.ts';

const REQUEST='tabplayer.batch.probe';
const RESULT='tabplayer.batch.probe.result';

self.addEventListener('message',(event:MessageEvent<{cmd?:string;bytes?:Uint8Array}>)=>{
  const request=event.data;
  if(!request||request.cmd!==REQUEST)return;
  let result:{ok:true;tracks:number;bars:number}|{ok:false;error:string};
  try{
    if(!(request.bytes instanceof Uint8Array))throw new Error('Invalid file check request.');
    // The window parses under the same cap.
    result={ok:true,...readInWorker(request.bytes,READ_ENTRY_LIMIT)};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage({cmd:RESULT,...result});
});
