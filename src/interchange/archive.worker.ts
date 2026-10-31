// @ts-expect-error TS5097: the compiler is not configured for extensions, and Node needs one to run this file from source.
import { ARCHIVE_CHECK_REQUEST,ARCHIVE_CHECK_RESULT } from './archive-gate-messages.ts';
// @ts-expect-error TS5097: as above.
import { validateArchive } from './archive.ts';
// @ts-expect-error TS5097: as above.
import { readInWorker } from './worker-read.ts';

self.addEventListener('message',(event:MessageEvent<{cmd?:string;bytes?:Uint8Array;entryLimit?:number;read?:boolean}>)=>{
  const request=event.data;
  if(!request||request.cmd!==ARCHIVE_CHECK_REQUEST)return;
  let result:{ok:true}|{ok:false;error:string};
  try{
    if(!(request.bytes instanceof Uint8Array)||typeof request.entryLimit!=='number')throw new Error('Invalid file check request.');
    if(request.read===true)readInWorker(request.bytes,request.entryLimit);else validateArchive(request.bytes,request.entryLimit);
    result={ok:true};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage({cmd:ARCHIVE_CHECK_RESULT,...result});
});
