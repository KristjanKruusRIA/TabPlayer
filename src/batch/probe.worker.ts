// alphaTab registers its own "message" listeners in any Worker and reads `cmd` from every message, so requests must carry
// a `cmd` of their own. The values below are checked against probe.ts by a test. The explicit `.ts` lets the same file run
// under a bundler and, in tests, straight from source.
import { importer,Settings } from '@coderline/alphatab';
// @ts-expect-error TS5097: the compiler is not configured for extensions, and Node needs one to run this file from source.
import { READ_ENTRY_LIMIT,validateArchive } from '../interchange/archive.ts';

const REQUEST='tabplayer.batch.probe';
const RESULT='tabplayer.batch.probe.result';

self.addEventListener('message',(event:MessageEvent<{cmd?:string;bytes?:Uint8Array}>)=>{
  const request=event.data;
  if(!request||request.cmd!==REQUEST)return;
  let result:{ok:true;tracks:number;bars:number}|{ok:false;error:string};
  try{
    if(!(request.bytes instanceof Uint8Array))throw new Error('Invalid file check request.');
    // Nothing reads an archive until the validator has accepted its real bytes; the window parses under the same cap.
    validateArchive(request.bytes,READ_ENTRY_LIMIT);
    const settings=new Settings();settings.importer.maxDecodingBufferSize=READ_ENTRY_LIMIT;
    const score=importer.ScoreLoader.loadScoreFromBytes(request.bytes,settings);
    result={ok:true,tracks:score.tracks.length,bars:score.masterBars.length};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage({cmd:RESULT,...result});
});
