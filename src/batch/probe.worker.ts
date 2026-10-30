// Self-contained on purpose: no local imports, so the same file runs under a bundler and, in tests, straight from source.
// alphaTab registers its own "message" listeners in any Worker and reads `cmd` from every message, so requests must carry
// a `cmd` of their own. The values below are checked against probe.ts by a test.
import { importer,Settings } from '@coderline/alphatab';

const REQUEST='tabplayer.batch.probe';
const RESULT='tabplayer.batch.probe.result';
const DECODING_CAP=32*1024*1024;

self.addEventListener('message',(event:MessageEvent<{cmd?:string;bytes?:Uint8Array}>)=>{
  const request=event.data;
  if(!request||request.cmd!==REQUEST)return;
  let result:{ok:true;tracks:number;bars:number}|{ok:false;error:string};
  try{
    if(!(request.bytes instanceof Uint8Array))throw new Error('Invalid file check request.');
    // The importer's default allows 128 MiB per archive entry; this is the Library metadata worker's cap.
    const settings=new Settings();settings.importer.maxDecodingBufferSize=DECODING_CAP;
    const score=importer.ScoreLoader.loadScoreFromBytes(request.bytes,settings);
    result={ok:true,tracks:score.tracks.length,bars:score.masterBars.length};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage({cmd:RESULT,...result});
});
