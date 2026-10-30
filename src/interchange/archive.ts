import { Inflate } from 'fflate';

const MiB=1024*1024;
/** Per-entry cap for a score opened on its own: alphaTab's default `maxDecodingBufferSize`, kept so a large embedded backing track still opens. */
export const OPEN_ENTRY_LIMIT=128_000_000;
/** Per-entry cap wherever many files are read in turn: the batch probe, the batch conversion and the library metadata worker. */
export const READ_ENTRY_LIMIT=32*MiB;
export const MAX_ARCHIVE_ENTRIES=4096;
/** All entries of one archive together, from the entry cap: 256 MB for Open, 64 MiB for reads. */
export const archiveTotalLimit=(entryLimit:number)=>2*entryLimit;

const LOCAL=0x04034b50,CENTRAL=0x02014b50,DESCRIPTOR=0x08074b50,END=0x06054b50,ZIP64_END=0x06064b50,ZIP64_LOCATOR=0x07064b50;
const ZIP64_MARK=0xffffffff,ZIP64_COUNT=0xffff;
const DEFLATE=8,ENCRYPTED=1,UNKNOWN_SIZE=8;
/** Compressed bytes per push. fflate emits only after a push, so this bounds what it can make past a limit to about 1 MiB. */
const PUSH_BYTES=1024;

interface Entry {flags:number;method:number;crc:number;compressed:number;size:number;name:number;nameLength:number;extra:number;extraLength:number;offset:number}

class Refused extends Error {}
const mib=(bytes:number)=>`${Math.round(bytes/MiB)} MiB`;
const refuse=(reason:string):never=>{throw new Refused(reason);};
function require(condition:boolean,reason='Invalid ZIP archive.'):asserts condition {if(!condition)refuse(reason);}
export const isArchive=(bytes:Uint8Array)=>bytes[0]===0x50&&bytes[1]===0x4b;

/**
 * A Zip64 extra field may repeat the sizes; when it does they must be the ones the headers give. Neither parser reads an
 * extra field while no size is marked as Zip64, so a malformed one elsewhere changes nothing and ends the walk.
 */
function checkExtra(view:DataView,start:number,length:number,entry:Entry) {
  for(let cursor=start;cursor+4<=start+length;){
    const tag=view.getUint16(cursor,true),size=view.getUint16(cursor+2,true);cursor+=4;
    if(cursor+size>start+length)return;
    if(tag===1){
      const fields=[entry.size,entry.compressed];
      for(let at=0;at+8<=size&&at<16;at+=8)require(view.getBigUint64(cursor+at,true)===BigInt(fields[at/8]),'ZIP64 size field does not match the entry.');
    }
    cursor+=size;
  }
}

/** Finds the end record exactly as fflate does and requires it to close the file. Returns where the central directory must stop. */
function readEnd(bytes:Uint8Array,view:DataView) {
  const u16=(at:number)=>view.getUint16(at,true),u32=(at:number)=>view.getUint32(at,true);
  require(bytes.length>=22);
  let end=bytes.length-22;
  // fflate takes the last signature within this window, even inside a comment, and neither it nor this code may pick another.
  while(u32(end)!==END){end--;require(end>0&&bytes.length-end<=65558);}
  require(end+22+u16(end+20)===bytes.length,'ZIP has bytes after its end record.');
  require(u16(end+4)===0&&u16(end+6)===0&&u16(end+8)===u16(end+10),'Unsupported multi-volume ZIP.');
  const count=u16(end+10),size=u32(end+12),offset=u32(end+16);
  // alphaTab reads no Zip64 sizes, so a real one cannot open however true it is.
  require(count!==ZIP64_COUNT&&size!==ZIP64_MARK&&offset!==ZIP64_MARK,'Unsupported ZIP64 archive.');
  let stop=end;
  // fflate's test: a locator here makes it take its counts from the record the locator names, whatever the end record says.
  if(end>=20&&u32(end-20)===ZIP64_LOCATOR){
    const record=u32(end-12);
    require(u32(end-8)===0&&u32(end-16)===0&&u32(end-4)===1&&record+56<=end-20,'ZIP64 locator does not match the archive.');
    require(u32(record)===ZIP64_END&&view.getBigUint64(record+4,true)===44n&&record+56===end-20,'ZIP64 record does not match the archive.');
    for(const [at,value] of [[24,count],[32,count],[40,size],[48,offset]])require(view.getBigUint64(record+at,true)===BigInt(value),'ZIP64 record does not match the archive.');
    require(u32(record+16)===0&&u32(record+20)===0,'Unsupported multi-volume ZIP.');
    stop=record;
  }
  require(count>0,'ZIP holds no entries.');
  require(count<=MAX_ARCHIVE_ENTRIES,`ZIP exceeds ${MAX_ARCHIVE_ENTRIES} entries.`);
  require(offset+size===stop,'ZIP central directory does not end where the archive says.');
  return {count,offset,stop};
}

/** Reads every central record, with nothing inflated, and refuses what the declared numbers alone show to be wrong. */
function readCentral(bytes:Uint8Array,view:DataView,directory:{count:number;offset:number;stop:number},entryLimit:number) {
  const u16=(at:number)=>view.getUint16(at,true),u32=(at:number)=>view.getUint32(at,true);
  const entries:Entry[]=[],names=new Set<string>(),latin=new TextDecoder('latin1');
  let cursor=directory.offset,compressedTotal=0,declaredTotal=0;
  for(let index=0;index<directory.count;index++){
    require(cursor+46<=directory.stop&&u32(cursor)===CENTRAL);
    const flags=u16(cursor+8),method=u16(cursor+10),compressed=u32(cursor+20),size=u32(cursor+24),nameLength=u16(cursor+28),extraLength=u16(cursor+30),commentLength=u16(cursor+32),offset=u32(cursor+42);
    require(compressed!==ZIP64_MARK&&size!==ZIP64_MARK&&offset!==ZIP64_MARK,'Unsupported ZIP64 entry.');
    require((flags&ENCRYPTED)===0,'Unsupported encrypted ZIP entry.');
    require(u16(cursor+34)===0&&(method===0||method===DEFLATE),'Unsupported ZIP entry.');
    require(method===DEFLATE||compressed===size,'ZIP stored entry declares a different size.');
    require(size<=entryLimit,`ZIP entry exceeds ${mib(entryLimit)}.`);
    const name=cursor+46,extra=name+nameLength,next=extra+extraLength+commentLength;
    require(next<=directory.stop);
    // The stock reader's local lengths are signed 16-bit, so a longer one walks backwards.
    require(nameLength<=32767,'Unsupported ZIP name length.');
    const key=latin.decode(bytes.subarray(name,extra));
    require(!names.has(key),'ZIP repeats an entry name.');names.add(key);
    const entry={flags,method,crc:u32(cursor+16),compressed,size,name,nameLength,extra,extraLength,offset};
    checkExtra(view,extra,extraLength,entry);
    entries.push(entry);compressedTotal+=compressed;declaredTotal+=size;cursor=next;
  }
  require(cursor===directory.stop,'ZIP central directory does not end where the archive says.');
  require(compressedTotal<=directory.offset,'ZIP entries do not fit in the file.');
  require(declaredTotal<=archiveTotalLimit(entryLimit),`ZIP entries exceed the ${mib(archiveTotalLimit(entryLimit))} total limit.`);
  return entries;
}

/**
 * The stock reader walks local headers from the start of the file and fflate follows the central directory, so the two
 * must describe one archive: each record in file order, with no gap, overlap or unlisted data. Returns where each entry's data starts.
 */
function walkLocal(bytes:Uint8Array,view:DataView,entries:Entry[],centralStart:number) {
  const u16=(at:number)=>view.getUint16(at,true),u32=(at:number)=>view.getUint32(at,true);
  const starts:number[]=[];
  let cursor=0;
  for(const entry of entries){
    require(entry.offset===cursor&&cursor+30<=centralStart&&u32(cursor)===LOCAL,'ZIP local/central declaration mismatch.');
    const localCompressed=u32(cursor+18),localSize=u32(cursor+22),nameLength=u16(cursor+26),extraLength=u16(cursor+28),descriptor=(entry.flags&UNKNOWN_SIZE)!==0;
    require(u16(cursor+6)===entry.flags&&u16(cursor+8)===entry.method&&nameLength===entry.nameLength,'ZIP local/central declaration mismatch.');
    require(extraLength<=32767,'Unsupported ZIP local-header length.');
    const name=cursor+30,extra=name+nameLength,start=extra+extraLength,stop=start+entry.compressed;
    require(stop<=centralStart,'ZIP entries do not fit in the file.');
    for(let at=0;at<nameLength;at++)require(bytes[name+at]===bytes[entry.name+at],'ZIP local/central declaration mismatch.');
    checkExtra(view,extra,extraLength,entry);
    cursor=stop;
    if(descriptor){
      // A size-less local header needs a stream that ends itself, and a stored entry has none.
      require(entry.method===DEFLATE,'Unsupported ZIP entry.');
      require((localCompressed===0||localCompressed===entry.compressed)&&(localSize===0||localSize===entry.size),'ZIP local/central declaration mismatch.');
      // The same reading as the stock reader: the signature is optional, so it decides what the next word is.
      // Guitar Pro writes the two sizes the other way round, and both parsers skip them, so either order is the truth.
      const signed=u32(cursor)===DESCRIPTOR,fields=cursor+(signed?4:0),first=fields+4,second=fields+8;
      require(fields+12<=centralStart&&u32(fields)===entry.crc,'ZIP data descriptor does not match the entry.');
      require(u32(first)===entry.compressed&&u32(second)===entry.size||u32(first)===entry.size&&u32(second)===entry.compressed,'ZIP data descriptor does not match the entry.');
      cursor=fields+12;
    }else require(u32(name-16)===entry.crc&&localCompressed===entry.compressed&&localSize===entry.size,'ZIP local/central declaration mismatch.');
    starts.push(start);
  }
  require(cursor===centralStart,'ZIP holds data its central directory does not list.');
  return starts;
}

/**
 * Inflates one entry, keeping none of it, and returns the bytes really produced. The stream must end on the entry's last
 * byte, since the stock reader ignores the compressed size and continues from where the stream stops.
 */
function inflatedSize(bytes:Uint8Array,start:number,stop:number,declared:number) {
  let produced=0;
  const inflate=new Inflate(chunk=>{produced+=chunk.length;require(produced<=declared,'ZIP declared/output size mismatch.');});
  // Pinned fflate 0.8.3 keeps unread input in `p` and its final-block and bit state in `s`; nothing public says where a stream ended.
  const state=inflate as unknown as {p:Uint8Array;s:{f:number;l:unknown;p:number}};
  for(let cursor=start;cursor<stop;){
    const next=Math.min(cursor+PUSH_BYTES,stop);
    inflate.push(bytes.subarray(cursor,next),next===stop);
    cursor=next;
    if(state.s.f===1&&!state.s.l){
      require(cursor===stop&&state.p.length===Math.ceil(state.s.p/8),'ZIP DEFLATE stream boundary mismatch.');
      require(produced===declared,'ZIP declared/output size mismatch.');
      return produced;
    }
  }
  return refuse('ZIP DEFLATE stream boundary mismatch.');
}

/**
 * The one check an archive passes before any parser sees it. Bytes that are not a ZIP pass untouched, and `entryLimit`
 * must be the `maxDecodingBufferSize` the parsers will run with. Everything else is decided from the bytes themselves:
 * the headers must agree, the entries must fit the file without overlapping, and every entry is inflated, with the
 * limits applied to what it really produces. Throws an `Error` saying why an archive was refused.
 */
export function validateArchive(bytes:Uint8Array,entryLimit:number):void {
  if(!isArchive(bytes))return;
  try{
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const directory=readEnd(bytes,view),entries=readCentral(bytes,view,directory,entryLimit),starts=walkLocal(bytes,view,entries,directory.offset);
    let total=0;
    for(const [index,entry] of entries.entries()){
      const start=starts[index];
      total+=entry.method===DEFLATE?inflatedSize(bytes,start,start+entry.compressed,entry.size):entry.compressed;
      require(total<=archiveTotalLimit(entryLimit),`ZIP entries exceed the ${mib(archiveTotalLimit(entryLimit))} total limit.`);
    }
  }catch(error){
    if(error instanceof Refused)throw new Error(error.message);
    // A read past the end of the file, or a stream fflate cannot decode.
    throw new Error(`Invalid ZIP archive: ${error instanceof Error?error.message:String(error)}`);
  }
}
