import { appendFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync,inflateSync,strToU8,unzipSync } from 'fflate';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { OPEN_ENTRY_LIMIT,validateArchive } from './archive';

/** alphaTab keeps its ZIP reader internal, so the test loads a temporary copy of the bundle that also exports it. */
type Reader={read():{fullName:string;data:Uint8Array}[]};
let readZip:(bytes:Uint8Array)=>Reader,folder='';
beforeAll(async()=>{
  folder=mkdtempSync(join(tmpdir(),'alphatab-zip-'));
  const copy=join(folder,'alphaTab.core.mjs');
  writeFileSync(copy,readFileSync(resolve('node_modules/@coderline/alphatab/dist/alphaTab.core.mjs'),'utf8')+'\nexport { ZipReader as __ZipReader, ByteBuffer as __ByteBuffer };\n');
  const bundle=await import(/* @vite-ignore */pathToFileURL(copy).href) as {__ZipReader:new(source:unknown,limit:number)=>Reader;__ByteBuffer:{fromBuffer(bytes:Uint8Array):unknown}};
  readZip=bytes=>new bundle.__ZipReader(bundle.__ByteBuffer.fromBuffer(bytes),OPEN_ENTRY_LIMIT);
},60000);
afterAll(()=>{if(folder)rmSync(folder,{recursive:true,force:true});});

/** Writes DEFLATE bits, least significant first; Huffman codes go in most significant first. */
class Bits {
  bytes:number[]=[];private used=0;
  put(value:number,count:number){for(let bit=0;bit<count;bit++){if(this.used===0)this.bytes.push(0);this.bytes[this.bytes.length-1]|=((value>>bit)&1)<<this.used;this.used=(this.used+1)%8;}return this;}
  code(value:number,count:number){for(let bit=count-1;bit>=0;bit--)this.put((value>>bit)&1,1);return this;}
  done(){return new Uint8Array(this.bytes);}
}

/** Canonical codes, as RFC 1951 assigns them. Over-subscribed lengths simply run past the code space. */
function canonical(lengths:Map<number,number>) {
  const codes=new Map<number,[number,number]>();let code=0;
  const longest=Math.max(...lengths.values());
  for(let length=1;length<=longest;length++){
    for(const symbol of [...lengths.keys()].sort((a,b)=>a-b))if(lengths.get(symbol)===length)codes.set(symbol,[code++,length]);
    code<<=1;
  }
  return codes;
}

/** One dynamic final block over the given literal/length and distance code lengths, emitting `symbols`. */
function dynamicBlock(literals:Map<number,number>,distances:Map<number,number>,symbols:number[]) {
  const order=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  // The code-length alphabet is complete: 0, 1, 2 and 18 with two bits each.
  const clCodes=canonical(new Map([[0,2],[1,2],[2,2],[18,2]]));
  const out=new Bits().put(1,1).put(2,2).put(286-257,5).put(30-1,5).put(19-4,4);
  for(const symbol of order)out.put([0,1,2,18].includes(symbol)?2:0,3);
  const writeLengths=(lengths:Map<number,number>,count:number)=>{
    for(let symbol=0;symbol<count;){
      const length=lengths.get(symbol)??0;
      if(length===0){
        let run=0;while(symbol+run<count&&!lengths.get(symbol+run)&&run<138)run++;
        if(run>=11){const [code,bits]=clCodes.get(18)!;out.code(code,bits).put(run-11,7);symbol+=run;continue;}
      }
      const [code,bits]=clCodes.get(length)!;out.code(code,bits);symbol++;
    }
  };
  writeLengths(literals,286);writeLengths(distances,30);
  const codes=canonical(literals);
  for(const symbol of symbols){const [code,bits]=codes.get(symbol)!;out.code(code,bits);}
  return out.done();
}

const A=0x41,B=0x42,C=0x43,END=256;
const oneDistance=new Map([[0,1],[1,1]]);
/** Lengths whose code space is overfull, and one whose code space is half empty. */
const oversubscribed=dynamicBlock(new Map([[A,1],[B,1],[C,2],[END,2]]),oneDistance,[A,B,END]);
const incompleteLiterals=dynamicBlock(new Map([[A,2],[END,2]]),oneDistance,[A,END]);
const incompleteDistances=dynamicBlock(new Map([[A,1],[END,1]]),new Map([[0,1]]),[A,END]);
const unfinished=new Bits().put(0,1).put(0,2).done();

const text=strToU8('the quick brown fox jumps over the lazy dog, again and again and again. '.repeat(40));
const sound=deflateSync(text);

const crc=(data:Uint8Array)=>{let value=~0;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^(0xedb88320&-(value&1));}return ~value>>>0;};

/** An archive of the entry under test followed by a stored marker entry, so a reader that stops early loses the marker. */
function archive(stream:Uint8Array,size:number) {
  const marker=strToU8('marker');
  const entries=[{name:strToU8('a.bin'),data:stream,method:8,size,sum:0},{name:strToU8('b.txt'),data:marker,method:0,size:marker.length,sum:crc(marker)}];
  const parts:Uint8Array[]=[],records:Uint8Array[]=[];let offset=0;
  for(const entry of entries){
    const local=new Uint8Array(30+entry.name.length),view=new DataView(local.buffer);
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(8,entry.method,true);view.setUint32(14,entry.sum,true);view.setUint32(18,entry.data.length,true);view.setUint32(22,entry.size,true);view.setUint16(26,entry.name.length,true);
    local.set(entry.name,30);
    const record=new Uint8Array(46+entry.name.length),out=new DataView(record.buffer);
    out.setUint32(0,0x02014b50,true);out.setUint16(4,20,true);out.setUint16(6,20,true);out.setUint16(10,entry.method,true);out.setUint32(16,entry.sum,true);out.setUint32(20,entry.data.length,true);out.setUint32(24,entry.size,true);out.setUint16(28,entry.name.length,true);out.setUint32(42,offset,true);
    record.set(entry.name,46);
    parts.push(local,entry.data);records.push(record);offset+=local.length+entry.data.length;
  }
  const directory=records.reduce((sum,record)=>sum+record.length,0),end=new Uint8Array(22),tail=new DataView(end.buffer);
  tail.setUint32(0,0x06054b50,true);tail.setUint16(8,2,true);tail.setUint16(10,2,true);tail.setUint32(12,directory,true);tail.setUint32(16,offset,true);
  const whole=new Uint8Array(offset+directory+22);let at=0;
  for(const part of [...parts,...records,end]){whole.set(part,at);at+=part.length;}
  return whole;
}

type Seen={ok:boolean;bytes?:string;detail:string};
const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex');
function run(action:()=>Uint8Array|void):Seen {
  try{const bytes=action();return {ok:true,bytes:bytes?hex(bytes):undefined,detail:''};}
  catch(error){return {ok:false,detail:error instanceof Error?error.message:String(error)};}
}
/** What each decoder makes of the entry: the validator, fflate alone, and alphaTab reading the local headers. */
function decoders(stream:Uint8Array,size:number) {
  const bytes=archive(stream,size);
  const validator=run(()=>validateArchive(bytes,OPEN_ENTRY_LIMIT));
  const fflate=run(()=>inflateSync(stream,{out:new Uint8Array(Math.max(size,1))}).subarray(0,size));
  const unzip=run(()=>unzipSync(bytes)['a.bin']);
  const alphaTab=run(()=>{
    const entries=readZip(bytes).read();
    if(entries.length!==2||entries[1].fullName!=='b.txt')throw new Error(`the reader saw ${entries.length} entries`);
    return entries[0].data;
  });
  return {validator,fflate,unzip,alphaTab};
}
const report=process.env.TABPLAYER_DECODER_REPORT;
const note=(name:string,seen:ReturnType<typeof decoders>)=>{if(report)appendFileSync(report,`${name}: validator=${seen.validator.ok||seen.validator.detail} fflate=${seen.fflate.ok||seen.fflate.detail} unzip=${seen.unzip.ok||seen.unzip.detail} alphaTab=${seen.alphaTab.ok||seen.alphaTab.detail} same=${seen.unzip.bytes===seen.alphaTab.bytes} ${seen.unzip.bytes?.slice(0,24)} ${seen.alphaTab.bytes?.slice(0,24)}\n`);};

const plus=(stream:Uint8Array,...extra:number[])=>new Uint8Array([...stream,...extra]);
const cases:[string,Uint8Array,number][]=[
  ['a sound stream',sound,text.length],
  ['a stream cut one byte short',sound.subarray(0,sound.length-1),text.length],
  ['a stream cut in half',sound.subarray(0,sound.length>>1),text.length],
  ['a stream of one byte',sound.subarray(0,1),text.length],
  ['one trailing byte after the final block',plus(sound,0),text.length],
  ['eight trailing bytes after the final block',plus(sound,1,2,3,4,5,6,7,8),text.length],
  ['a local header signature after the final block',plus(sound,0x50,0x4b,3,4),text.length],
  ['over-subscribed literal codes',oversubscribed,2],
  ['over-subscribed literal codes declaring no output',oversubscribed,0],
  ['incomplete literal codes',incompleteLiterals,1],
  ['one distance code, as fflate itself writes',incompleteDistances,1],
  ['a stored block that is not final, with nothing after it',unfinished,0],
];

describe('fflate and alphaTab on the same crafted archives',()=>{
  // The gate is the validator (fflate) and then the stock reader (alphaTab) in one Worker, so a file passes only if both
  // decoders take it, and the stricter one decides. Sound or crafted, what both take must read the same.
  it.each(cases)('%s: the stricter decoder decides',(name,stream,size)=>{
    const seen=decoders(stream,size);note(name,seen);
    if(name==='a sound stream')expect(seen.validator.ok&&seen.alphaTab.ok).toBe(true);
    else expect(seen.validator.ok&&seen.alphaTab.ok).toBe(false);
    if(seen.validator.ok&&seen.alphaTab.ok)expect(seen.alphaTab.bytes).toBe(seen.unzip.bytes);
  });
  it('shows the validator alone is not enough: fflate takes bad Huffman tables that alphaTab refuses',()=>{
    for(const [stream,size] of [[oversubscribed,0],[incompleteLiterals,1],[incompleteDistances,1]] as const){
      const seen=decoders(stream,size);
      expect(seen.validator.ok).toBe(true);expect(seen.alphaTab.ok).toBe(false);
    }
  });
  it('accepts a sound stream in both',()=>{
    const seen=decoders(sound,text.length);
    expect(seen.validator.ok).toBe(true);expect(seen.alphaTab.ok).toBe(true);expect(seen.alphaTab.bytes).toBe(hex(text));
  });
});
