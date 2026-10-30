import { validateArchive } from './archive';
import { ARCHIVE_CHECK_REQUEST,ARCHIVE_CHECK_RESULT } from './archive-gate-messages';

self.addEventListener('message',(event:MessageEvent<{cmd?:string;bytes?:Uint8Array;entryLimit?:number}>)=>{
  const request=event.data;
  if(!request||request.cmd!==ARCHIVE_CHECK_REQUEST)return;
  let result:{ok:true}|{ok:false;error:string};
  try{
    if(!(request.bytes instanceof Uint8Array)||typeof request.entryLimit!=='number')throw new Error('Invalid file check request.');
    validateArchive(request.bytes,request.entryLimit);
    result={ok:true};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage({cmd:ARCHIVE_CHECK_RESULT,...result});
});
