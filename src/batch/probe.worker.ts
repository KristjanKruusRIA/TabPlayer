import { importer,Settings } from '@coderline/alphatab';
import { PROBE_MAX_BYTES,type ProbeResult } from './probe';

// Same decoding cap as the Library's metadata worker; the importer's default allows 128 MiB per entry.
self.onmessage=(event:MessageEvent<{bytes?:Uint8Array}>)=>{
  let result:ProbeResult;
  try{
    const bytes=event.data?.bytes;
    if(!(bytes instanceof Uint8Array))throw new Error('Invalid file check request.');
    const settings=new Settings();settings.importer.maxDecodingBufferSize=PROBE_MAX_BYTES;
    const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
    result={ok:true,tracks:score.tracks.length,bars:score.masterBars.length};
  }catch(error){result={ok:false,error:error instanceof Error?error.message:'The file could not be read.'};}
  self.postMessage(result);
};
