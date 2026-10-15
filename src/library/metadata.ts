import { importer, Settings } from '@coderline/alphatab';
import { Inflate } from 'fflate';
import type { LibraryMetadata, MetadataEdit, MetadataInput, MetadataResult } from './types';

const MiB=1024*1024;
const encoder=new TextEncoder();

// Admission discards output. A 1 KiB compressed push also bounds fflate's
// temporary emitted chunk; no complete expanded entry/archive is retained.
function admitZip(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u16=(offset:number)=>view.getUint16(offset,true),u32=(offset:number)=>view.getUint32(offset,true);
  const require=(condition:boolean,message='Invalid ZIP metadata input.')=>{if(!condition)throw new Error(message);};
  let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(u32(offset)===0x06054b50&&offset+22+u16(offset+20)===bytes.length){end=offset;break;}
  require(end>=0);
  require(u16(end+4)===0&&u16(end+6)===0&&u16(end+8)===u16(end+10),'Unsupported multi-volume ZIP.');
  const count=u16(end+10),centralSize=u32(end+12),centralStart=u32(end+16);
  require(count!==65535&&centralSize!==0xffffffff&&centralStart!==0xffffffff,'Unsupported ZIP64 metadata input.');
  require(count<=4096,'ZIP exceeds 4096 entries.');
  require(centralStart+centralSize===end);
  let central=centralStart,local=0,total=0;
  for(let index=0;index<count;index++){
    require(central+46<=end&&u32(central)===0x02014b50);
    const flags=u16(central+8),method=u16(central+10),compressed=u32(central+20),declared=u32(central+24),nameLength=u16(central+28),extraLength=u16(central+30),commentLength=u16(central+32),offset=u32(central+42);
    require(u16(central+6)<45&&compressed!==0xffffffff&&declared!==0xffffffff&&offset!==0xffffffff,'Unsupported ZIP64 metadata input.');
    require((flags&9)===0,'Unsupported encrypted or unknown-size ZIP entry.');
    require(u16(central+34)===0&&(method===0||method===8),'Unsupported ZIP entry.');
    require(declared<=32*MiB,'ZIP entry exceeds 32 MiB.');
    require(central+46+nameLength+extraLength+commentLength<=end);
    require(offset===local&&offset+30<=centralStart&&u32(offset)===0x04034b50);
    require(u16(offset+4)<45&&u16(offset+6)===flags&&u16(offset+8)===method&&u32(offset+14)===u32(central+16)&&u32(offset+18)===compressed&&u32(offset+22)===declared,'ZIP local/central declaration mismatch.');
    require(u16(offset+26)===nameLength);
    const localExtra=u16(offset+28),dataStart=offset+30+nameLength+localExtra,dataEnd=dataStart+compressed;
    // The installed importer's local header reader uses signed 16-bit lengths.
    require(nameLength<=32767&&localExtra<=32767,'Unsupported ZIP local-header length.');
    require(dataStart<=centralStart&&dataEnd<=centralStart);
    for(let character=0;character<nameLength;character++)require(bytes[offset+30+character]===bytes[central+46+character]);
    // ZIP64 extra fields are unsupported even when legacy size slots are filled.
    for(const [start,length] of [[offset+30+nameLength,localExtra],[central+46+nameLength,extraLength]]){
      let cursor=start;
      while(cursor<start+length){require(cursor+4<=start+length);require(u16(cursor)!==1,'Unsupported ZIP64 metadata input.');cursor+=4+u16(cursor+2);require(cursor<=start+length);}
    }
    let actual=0;
    const output=(chunk:Uint8Array)=>{
      actual+=chunk.length;total+=chunk.length;
      require(actual<=32*MiB,'ZIP actual entry output exceeds 32 MiB.');
      require(total<=64*MiB,'ZIP actual aggregate output exceeds 64 MiB.');
    };
    if(method===0)output(bytes.subarray(dataStart,dataEnd));
    else{
      const inflate=new Inflate(output);
      if(dataStart===dataEnd)inflate.push(new Uint8Array(),true);
      // Pinned fflate 0.8.3 retains unread compressed input in p and its final
      // block/bit state in s. AlphaTab ignores compressedSize, so accepting
      // trailing bytes here could expose local entries absent from our pass.
      const state=inflate as unknown as {p:Uint8Array;s:{f:number;l:unknown;p:number}};
      for(let cursor=dataStart;cursor<dataEnd;cursor+=1024){
        const end=Math.min(cursor+1024,dataEnd);
        inflate.push(bytes.subarray(cursor,end),end===dataEnd);
        if(state.s.f===1&&!state.s.l)require(end===dataEnd&&state.p.length===Math.ceil(state.s.p/8),'ZIP DEFLATE stream boundary mismatch.');
      }
      require(state.s.f===1&&!state.s.l&&state.p.length===Math.ceil(state.s.p/8),'ZIP DEFLATE stream boundary mismatch.');
    }
    require(actual===declared,'ZIP declared/output size mismatch.');
    local=dataEnd;central+=46+nameLength+extraLength+commentLength;
  }
  require(local===centralStart&&central===end);
}

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
  if(bytes[0]===0x50&&bytes[1]===0x4b)admitZip(bytes);
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
      const settings=new Settings();settings.importer.maxDecodingBufferSize=32*MiB;
      const score=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
      base={title:score.title,artist:score.artist,album:score.album,trackNames:score.tracks.map(track=>track.name),metadataTruncated:false};
    }
    return {sha256:input.sha256,metadata:projectMetadata(base,input.edits),error:null};
  }catch(error){return {sha256:input.sha256,metadata:null,error:error instanceof Error?error.message:'Metadata extraction failed.'};}
}
