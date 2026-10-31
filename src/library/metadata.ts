import { importer, Settings } from '@coderline/alphatab';
import { READ_ENTRY_LIMIT,validateArchive } from '../interchange/archive';
import type { LibraryMetadata, MetadataEdit, MetadataInput, MetadataResult } from './types';

const MiB=1024*1024;
const encoder=new TextEncoder();

// Count BCFZ's byte production without allocating its decoded file system.
// The importer may not abort; the outer disposable worker enforces the deadline.
function admitGpx(bytes:Uint8Array){
  if(bytes.length<8)throw new Error('Truncated GPX compression header.');
  const expected=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true);
  if(expected>64*MiB)throw new Error('GPX expansion exceeds 64 MiB.');
  let position=64,actual=0;
  const bits=(count:number,reversed=false)=>{
    let value=0;
    for(let index=0;index<count;index++){
      if(position>=bytes.length*8)throw new Error('Truncated GPX compressed data.');
      const bit=(bytes[position>>3]>>(7-(position++&7)))&1;
      if(reversed)value|=bit<<index;else value=(value<<1)|bit;
    }
    return value;
  };
  while(actual<expected){
    if(bits(1)){
      const width=bits(4),offset=bits(width,true),size=bits(width,true);
      if(offset===0||offset>actual)throw new Error('Invalid GPX compression reference.');
      actual+=Math.min(offset,size);
    }else{const count=bits(2,true);bits(count*8);actual+=count;}
    if(actual>expected||actual>64*MiB)throw new Error('GPX declared/output size mismatch.');
  }
}

function scoreBytes(encoded:string):Uint8Array{
  if(typeof encoded!=='string'||encoded.length>Math.ceil(64*MiB/3)*4)throw new Error('Score input exceeds 64 MiB.');
  const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
  if(encoded.length/4*3-padding>64*MiB)throw new Error('Score input exceeds 64 MiB.');
  if(encoded.length%4!==0||/[^A-Za-z0-9+/]/.test(encoded.slice(0,encoded.length-padding)))throw new Error('Invalid score base64 data.');
  const binary=atob(encoded),bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  validateArchive(bytes,READ_ENTRY_LIMIT);
  if(bytes[0]===66&&bytes[1]===67&&bytes[2]===70&&bytes[3]===90)admitGpx(bytes);
  return bytes;
}

function text(value:unknown):string {
  if(typeof value!=='string')throw new Error('Invalid metadata text.');
  return value;
}

export function projectMetadata(base: LibraryMetadata, edits: readonly MetadataEdit[]): LibraryMetadata {
  const result={...base,title:text(base.title),artist:text(base.artist),album:text(base.album),trackNames:base.trackNames.map(text)};
  const track=(index:number)=>{
    if(!Number.isSafeInteger(index)||index<0||index>=result.trackNames.length)throw new Error('Invalid metadata track index.');
    return index;
  };
  for(const edit of edits)switch(edit.type){
    case 'setScoreInfo':result.title=text(edit.title);result.artist=text(edit.artist);break;
    case 'setScoreMetadata':result.album=text(edit.album);break;
    case 'setTrackInfo':result.trackNames[track(edit.track)]=text(edit.name);break;
    case 'addTrack':case 'addPitchedTrack':case 'addPercussionTrack':result.trackNames.push(text(edit.name)||'Instrument');break;
    case 'duplicateTrack':{
      const index=track(edit.track);result.trackNames.splice(index+1,0,result.trackNames[index]);break;
    }
    case 'moveTrack':{
      const index=track(edit.track),to=track(edit.to);
      if(index===to)throw new Error('Invalid metadata track move.');
      result.trackNames.splice(to,0,...result.trackNames.splice(index,1));break;
    }
    case 'removeTrack':{
      const index=track(edit.track);
      if(result.trackNames.length===1)throw new Error('Keep at least one metadata track.');
      result.trackNames.splice(index,1);break;
    }
    default:throw new Error('Unsupported metadata operation.');
  }
  const bounded=(value:string)=>{
    let bytes=0,end=0;
    for(const character of value){const size=encoder.encode(character).length;if(bytes+size>4096)break;bytes+=size;end+=character.length;}
    if(end<value.length)result.metadataTruncated=true;
    return value.slice(0,end);
  };
  result.title=bounded(result.title);result.artist=bounded(result.artist);result.album=bounded(result.album);
  if(result.trackNames.length>256)result.metadataTruncated=true;
  result.trackNames=result.trackNames.slice(0,256).map(bounded);
  return result;
}

export function extractMetadata(input: MetadataInput): MetadataResult {
  try{
    let base:LibraryMetadata;
    if(input.base.kind==='blank')base={title:input.base.title,artist:input.base.artist,album:'',trackNames:['Guitar'],metadataTruncated:false};
    else{
      const bytes=scoreBytes(input.base.bytesBase64);
      const settings=new Settings();settings.importer.maxDecodingBufferSize=READ_ENTRY_LIMIT;
      const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
      base={title:score.title,artist:score.artist,album:score.album,trackNames:score.tracks.map(track=>track.name),metadataTruncated:false};
    }
    return {sha256:input.sha256,metadata:projectMetadata(base,input.edits),error:null};
  }catch(error){return {sha256:input.sha256,metadata:null,error:error instanceof Error?error.message:'Metadata extraction failed.'};}
}
