import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { importer,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { describe,expect,it,vi } from 'vitest';
import { MAX_ARCHIVE_ENTRIES,OPEN_ENTRY_LIMIT,READ_ENTRY_LIMIT,archiveTotalLimit,validateArchive } from './archive';
import { assertArchiveAccepted } from './archive-gate';
import { loadInterchangeScore } from './gp';

const MiB=1024*1024;
const u16=(value:number)=>{const part=Buffer.alloc(2);part.writeUInt16LE(value);return part;};
const u32=(value:number)=>{const part=Buffer.alloc(4);part.writeUInt32LE(value);return part;};
const u64=(value:number)=>{const part=Buffer.alloc(8);part.writeBigUInt64LE(BigInt(value));return part;};
const concat=(...parts:Uint8Array[])=>new Uint8Array(Buffer.concat(parts));

interface Member {name:string;data:Buffer;method:0|8;stream?:Buffer;declared?:number;flags?:number;crc?:number;descriptor?:'signed'|'bare'|'guitar-pro';localSizes?:'real'|'zero';offset?:number;localName?:string;extra?:Uint8Array;localExtra?:Uint8Array;gapBefore?:Uint8Array;storedSize?:number}
/**
 * Writes an archive byte by byte, so a test states exactly what each header says. With no overrides it is a sound
 * archive; each option makes one header say something else.
 */
function write(members:Member[],options:{centralOffsetShift?:number;trailing?:Uint8Array;comment?:Uint8Array;zip64?:Buffer;locator?:Buffer}={}) {
  const locals:Buffer[]=[],centrals:Buffer[]=[];let cursor=0;
  for(const member of members){
    const stream=member.stream??(member.method===8?deflateRawSync(member.data):member.data),size=member.declared??member.data.length,flags=member.flags??(member.descriptor?0x0808:0x0800),crc=member.crc??0x12345678;
    const name=Buffer.from(member.name),localName=Buffer.from(member.localName??member.name),extra=Buffer.from(member.extra??[]),localExtra=Buffer.from(member.localExtra??member.extra??[]);
    if(member.gapBefore){locals.push(Buffer.from(member.gapBefore));cursor+=member.gapBefore.length;}
    const hide=member.localSizes==='zero'||(member.descriptor&&member.localSizes!=='real');
    const local=Buffer.concat([u32(0x04034b50),u16(20),u16(flags),u16(member.method),u32(0),u32(hide?0:crc),u32(hide?0:stream.length),u32(hide?0:member.storedSize??size),u16(localName.length),u16(localExtra.length),localName,localExtra]);
    const tail=member.descriptor==='signed'?Buffer.concat([u32(0x08074b50),u32(crc),u32(stream.length),u32(size)]):member.descriptor==='bare'?Buffer.concat([u32(crc),u32(stream.length),u32(size)]):member.descriptor==='guitar-pro'?Buffer.concat([u32(crc),u32(size),u32(stream.length)]):Buffer.alloc(0);
    centrals.push(Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(flags),u16(member.method),u32(0),u32(crc),u32(stream.length),u32(size),u16(name.length),u16(extra.length),u16(0),u16(0),u16(0),u32(0),u32(member.offset??cursor),name,extra]));
    locals.push(local,stream,tail);cursor+=local.length+stream.length+tail.length;
  }
  const directory=Buffer.concat(centrals),comment=Buffer.from(options.comment??[]),offset=cursor+(options.centralOffsetShift??0);
  return concat(...locals,directory,options.zip64??Buffer.alloc(0),options.locator??Buffer.alloc(0),u32(0x06054b50),u16(0),u16(0),u16(members.length),u16(members.length),u32(directory.length),u32(offset),u16(comment.length),comment,options.trailing??Buffer.alloc(0));
}
const text=(name:string,body='hello hello hello hello'):Member=>({name,data:Buffer.from(body),method:8});
const accepts=(bytes:Uint8Array,limit=OPEN_ENTRY_LIMIT)=>expect(()=>validateArchive(bytes,limit)).not.toThrow();
const refuses=(bytes:Uint8Array,reason:RegExp,limit=OPEN_ENTRY_LIMIT)=>expect(()=>validateArchive(bytes,limit)).toThrow(reason);

describe('validateArchive, what a sound archive looks like',()=>{
  it('leaves bytes that are not an archive alone',()=>{
    accepts(new Uint8Array([24,70,73,67,72,73,69,82]));accepts(strToU8('<score-partwise/>'));accepts(new Uint8Array());
  });
  it('accepts what fflate writes, and the same archive written by hand',()=>{
    accepts(zipSync({'a.txt':strToU8('a'),'b/c.txt':strToU8('c'.repeat(5000)),'empty':new Uint8Array()}));
    accepts(write([text('a'),{name:'stored',data:Buffer.from('plain'),method:0}]));
    accepts(write([text('a')],{comment:strToU8('made by a tool')}));
  });
  it('accepts a zero-length entry however it is written',()=>{
    accepts(write([{name:'empty',data:Buffer.alloc(0),method:0}]));accepts(write([{name:'empty',data:Buffer.alloc(0),method:8}]));
  });
  it('accepts data descriptors, with and without their signature, and with the sizes in the order Guitar Pro writes them',()=>{
    accepts(write([{...text('a'),descriptor:'signed'},{...text('b'),descriptor:'bare'},{...text('c'),descriptor:'signed',localSizes:'real'},{...text('d'),descriptor:'guitar-pro'}]));
  });
  it('accepts a Zip64 record and extra fields that tell the truth',()=>{
    const member=text('a'),stream=deflateRawSync(member.data),extra=Buffer.concat([u16(1),u16(16),u64(member.data.length),u64(stream.length)]);
    const plain=write([{...member,stream,extra}]),view=new DataView(plain.buffer);
    const end=plain.length-22,size=view.getUint32(end+12,true),offset=view.getUint32(end+16,true),record=offset+size;
    const zip64=Buffer.concat([u32(0x06064b50),u64(44),u16(45),u16(45),u32(0),u32(0),u64(1),u64(1),u64(size),u64(offset)]);
    const locator=Buffer.concat([u32(0x07064b50),u32(0),u64(record),u32(1)]);
    const honest=write([{...member,stream,extra}],{zip64,locator});
    accepts(honest);expect(Object.keys(unzipSync(honest))).toEqual(['a']);
  });
});

describe('validateArchive, H1: entries that lie about their size or place',()=>{
  it('refuses more entries than the cap, before reading a record',()=>{
    const bytes=zipSync(Object.fromEntries(Array.from({length:MAX_ARCHIVE_ENTRIES+1},(_,index)=>[`e${index}`,new Uint8Array()])));
    refuses(bytes,/exceeds 4096 entries/);
  });
  it('refuses an archive of no entries',()=>{
    refuses(write([]),/no entries/);
  });
  it('refuses two records that point at the same data',()=>{
    const [one]=[text('x/0')],bytes=write([one,{...one,name:'x/1',offset:0}]);
    refuses(bytes,/mismatch|fit/);
  });
  it('refuses overlapping and repeating records however they are counted, in a file that holds one stream',()=>{
    const data=Buffer.alloc(MiB),stream=deflateRawSync(data),members:Member[]=[{name:'x/0',data,stream,method:8}];
    for(let index=1;index<64;index++)members.push({name:`x/${index}`,data,stream:Buffer.alloc(0),method:8,declared:1,offset:0});
    refuses(write(members),/mismatch|fit/);
  });
  it('refuses compressed sizes that together exceed the file',()=>{
    const bytes=write([text('a')]),view=new DataView(bytes.buffer);
    view.setUint32(bytes.length-22-text('a').name.length-46+20,0x7fffffff,true);
    refuses(bytes,/fit in the file/);
  });
  it('refuses a stored entry whose two sizes differ, the case fflate copies by the one it trusts',()=>{
    refuses(write([{name:'x',data:Buffer.alloc(100),method:0,declared:1}]),/stored entry declares a different size/);
  });
  it('refuses a deflate stream that makes more than it declares, and stops at once',()=>{
    const data=Buffer.alloc(120*MiB),stream=deflateRawSync(data,{level:9}),started=performance.now();
    refuses(write([{name:'bomb',data,stream,method:8,declared:1}]),/declared\/output size mismatch/);
    expect(performance.now()-started).toBeLessThan(2000);
  },10000);
  it('refuses a deflate stream that makes less than it declares',()=>{
    refuses(write([{name:'short',data:Buffer.alloc(100),method:8,declared:101}]),/declared\/output size mismatch/);
  });
  it('holds each entry to the cap on what it declares',()=>{
    refuses(write([{name:'big',data:Buffer.alloc(10),method:8,declared:33*MiB}]),/exceeds 32 MiB/,READ_ENTRY_LIMIT);
  });
  it('holds the real total to the limit when each entry fits the cap',()=>{
    const data=Buffer.alloc(24*MiB),stream=deflateRawSync(data);
    const bytes=write(['a','b','c'].map(name=>({name,data,stream,method:8})));
    expect(3*data.length).toBeGreaterThan(archiveTotalLimit(READ_ENTRY_LIMIT));
    refuses(bytes,/64 MiB total limit/,READ_ENTRY_LIMIT);accepts(bytes);
  },20000);
  it('refuses a stream cut short, and one that is not deflate',()=>{
    const stream=deflateRawSync(Buffer.alloc(1000,7));
    refuses(write([{name:'cut',data:Buffer.alloc(1000,7),stream:stream.subarray(0,stream.length-1),method:8}]),/ZIP/);
    refuses(write([{name:'noise',data:Buffer.alloc(8),stream:Buffer.from([7,255,255,255]),method:8}]),/ZIP/);
  });
  it('refuses a stream that ends before its compressed size, where the stock reader would carry on',()=>{
    const data=Buffer.from('hello'),stream=Buffer.concat([deflateRawSync(data),Buffer.alloc(2048,0x41)]);
    refuses(write([{name:'early',data,stream,method:8}]),/stream boundary mismatch/);
  });
  it('refuses encrypted entries and methods no parser reads',()=>{
    refuses(write([{...text('a'),flags:1}]),/encrypted/);
    const unknown=write([text('a')]),view=new DataView(unknown.buffer);
    view.setUint16(unknown.length-22-1-46+10,12,true);view.setUint16(8,12,true);
    refuses(unknown,/Unsupported ZIP entry/);
  });
  it('refuses a truncated file and bytes after the end',()=>{
    const bytes=write([text('a')]);
    refuses(bytes.subarray(0,bytes.length-1),/ZIP/);refuses(new Uint8Array([80,75,3,4,1,2]),/ZIP/);
    refuses(write([text('a')],{trailing:new Uint8Array(10)}),/after its end record/);
  });
  it('refuses a repeated name, which the two parsers resolve differently',()=>{
    refuses(write([text('Content/score.gpif'),text('Content/score.gpif')]),/repeats an entry name/);
  });
});

describe('validateArchive, Zip64 fields that lie',()=>{
  const member=text('a'),plain=write([member]),view=new DataView(plain.buffer);
  const end=plain.length-22,size=view.getUint32(end+12,true),offset=view.getUint32(end+16,true);
  const record=(entries:number)=>Buffer.concat([u32(0x06064b50),u64(44),u16(45),u16(45),u32(0),u32(0),u64(entries),u64(entries),u64(size),u64(offset)]);
  const locator=(at:number)=>Buffer.concat([u32(0x07064b50),u32(0),u64(at),u32(1)]);
  it('refuses a record that claims more entries than the end record, the count fflate would walk',()=>{
    refuses(write([member],{zip64:record(2**26),locator:locator(offset+size)}),/ZIP64 record/);
  });
  it('refuses a locator that points anywhere but the record before it',()=>{
    refuses(write([member],{zip64:record(1),locator:locator(0)}),/ZIP64/);
    refuses(write([member],{locator:locator(offset+size)}),/ZIP64/);
  });
  it('refuses the record placed before the central directory, which a record walk never reads as a size',()=>{
    const rec=record(2**26),local=plain.subarray(0,offset),directory=plain.subarray(offset,offset+size);
    const trailer=Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(1),u16(1),u32(size),u32(offset+rec.length),u16(0)]);
    refuses(concat(local,rec,directory,locator(offset),trailer),/ZIP/);
  });
  it('refuses the sizes and counts Zip64 marks, which the stock reader cannot follow',()=>{
    const marked=plain.slice(),markedView=new DataView(marked.buffer);markedView.setUint32(end+16,0xffffffff,true);
    refuses(marked,/ZIP64/);
    const entry=plain.slice(),entryView=new DataView(entry.buffer);entryView.setUint32(offset+24,0xffffffff,true);
    refuses(entry,/ZIP64/);
  });
  it('refuses an extra field that gives other sizes than the headers',()=>{
    const extra=Buffer.concat([u16(1),u16(16),u64(1),u64(2)]);
    refuses(write([{...member,extra}]),/ZIP64 size field/);
    refuses(write([{...member,localExtra:extra}]),/ZIP64 size field/);
  });
});

describe('validateArchive, M1: local headers and central directory must be one archive',()=>{
  it('refuses a local entry the central directory never lists',()=>{
    const bytes=write([{...text('a'),gapBefore:write([text('hidden')]).subarray(0,40)}]);
    refuses(bytes,/mismatch/);
    const real=write([text('a')]),view=new DataView(real.buffer),end=real.length-22,start=view.getUint32(end+16,true);
    // A whole unlisted entry in front of the listed ones, as the walk8 file has.
    const hidden=write([text('walk')]),hiddenEnd=new DataView(hidden.buffer).getUint32(hidden.length-22+16,true);
    const moved=concat(hidden.subarray(0,hiddenEnd),real);const movedView=new DataView(moved.buffer);
    movedView.setUint32(hiddenEnd+end+16,start+hiddenEnd,true);movedView.setUint32(hiddenEnd+start+42,hiddenEnd,true);
    refuses(moved,/mismatch/);
  });
  it('refuses an unlisted entry after the listed ones',()=>{
    const bytes=write([text('a')],{centralOffsetShift:0}),view=new DataView(bytes.buffer),start=view.getUint32(bytes.length-22+16,true);
    const extra=new Uint8Array(30).fill(0x41),with_=concat(bytes.subarray(0,start),extra,bytes.subarray(start));
    new DataView(with_.buffer).setUint32(with_.length-22+16,start+extra.length,true);
    refuses(with_,/does not list/);
  });
  it('refuses a score the central directory alone points at',()=>{
    refuses(write([{...text('Content/score.gpif'),localName:'Content/score.gpiX'}]),/mismatch/);
  });
  it.each([
    ['method',(view:DataView)=>view.setUint16(8,0,true)],
    ['crc',(view:DataView)=>view.setUint32(14,1,true)],
    ['compressed size',(view:DataView)=>view.setUint32(18,1,true)],
    ['size',(view:DataView)=>view.setUint32(22,1,true)],
    ['flags',(view:DataView)=>view.setUint16(6,0,true)],
  ] as const)('refuses a local %s that differs from the central one',(_,change)=>{
    const bytes=write([text('a')]);change(new DataView(bytes.buffer));
    refuses(bytes,/mismatch/);
  });
  it('refuses a data descriptor that differs from the central directory',()=>{
    const bytes=write([{...text('a'),descriptor:'signed'}]),view=new DataView(bytes.buffer),start=view.getUint32(bytes.length-22+16,true);
    view.setUint32(start-8,3,true);
    refuses(bytes,/data descriptor/);
  });
  it('refuses local sizes that are neither real nor absent when a descriptor follows',()=>{
    const bytes=write([{...text('a'),descriptor:'signed'}]);new DataView(bytes.buffer).setUint32(22,7,true);
    refuses(bytes,/mismatch/);
  });
  it('refuses a stored entry with a data descriptor, whose end nothing marks',()=>{
    refuses(write([{name:'a',data:Buffer.from('plain'),method:0,descriptor:'signed'}]),/Unsupported ZIP entry/);
  });
  it('refuses a local name or extra length the stock reader takes as negative',()=>{
    refuses(zipSync({entry:[new Uint8Array([1]),{extra:{1234:new Uint8Array(32764)}}]}),/local-header length/);
  });
});

const container='<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
const score='<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>';
/** What Java's ZipOutputStream writes, the path of the Dolet and Sibelius exporters: a stored mimetype first, then deflated entries with no size in the local header and a signed descriptor after the data, plus a folder entry. */
const javaMxl=()=>write([
  {name:'mimetype',data:Buffer.from('application/vnd.recordare.musicxml'),method:0},
  {name:'META-INF/',data:Buffer.alloc(0),method:0},
  {name:'META-INF/container.xml',data:Buffer.from(container),method:8,descriptor:'signed'},
  {name:'score.xml',data:Buffer.from(score),method:8,descriptor:'signed'},
]);

describe('MusicXML containers as real tools write them',()=>{
  it('reads the Java form through both parsers',()=>{
    const bytes=javaMxl();accepts(bytes);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['META-INF/','META-INF/container.xml','mimetype','score.xml']);
    expect(loadInterchangeScore(bytes,new Settings()).tracks.length).toBe(1);
  });
  it('reads the bare-descriptor form some writers use',()=>{
    const bytes=write([{name:'META-INF/container.xml',data:Buffer.from(container),method:8,descriptor:'bare'},{name:'score.xml',data:Buffer.from(score),method:8,descriptor:'bare'}]);
    accepts(bytes);expect(loadInterchangeScore(bytes,new Settings()).tracks.length).toBe(1);
  });
  it('reads the form a Python or Qt writer leaves, with sizes in the local header',()=>{
    const bytes=write([{name:'META-INF/container.xml',data:Buffer.from(container),method:8},{name:'score.xml',data:Buffer.from(score),method:8}]);
    accepts(bytes);expect(loadInterchangeScore(bytes,new Settings()).tracks.length).toBe(1);
  });
});

describe('the parsers run only after the validator',()=>{
  it('refuses a real-looking archive before the stock reader runs, on the same cap as the settings',()=>{
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes');
    const crafted=write([{name:'Content/score.gpif',data:Buffer.alloc(40),method:0,declared:1}]);
    expect(()=>loadInterchangeScore(crafted,new Settings())).toThrow(/stored entry/);
    const limited=new Settings();limited.importer.maxDecodingBufferSize=10;
    expect(()=>loadInterchangeScore(write([{name:'a',data:Buffer.alloc(40),method:8}]),limited)).toThrow(/ZIP entry exceeds/);
    expect(load).not.toHaveBeenCalled();load.mockRestore();
  });
  it('uses the importer default as the Open cap',()=>{
    expect(new Settings().importer.maxDecodingBufferSize).toBe(OPEN_ENTRY_LIMIT);
  });
  it('validates once per array, and again for a stricter limit',()=>{
    const bytes=write([text('a')]);
    assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT);
    // Checked before: a change to the array would be missed, which is why only arrays this code owns are recorded.
    bytes[bytes.length-1]=1;
    expect(()=>assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT)).not.toThrow();
    expect(()=>assertArchiveAccepted(bytes,READ_ENTRY_LIMIT)).toThrow(/ZIP/);
  });
});

const folder=process.env.TABPLAYER_COMPATIBILITY_DIR??resolve('.analysis/compatibility');
const fixtures=['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx','guitarpro7-notes.gp','guitarpro7-bends.gp','guitarpro8-beat-tempo-change.gp'];
describe.skipIf(!existsSync(resolve(folder,fixtures[0])))('the real fixtures',()=>{
  it.each(fixtures)('%s passes under both caps and still opens',name=>{
    const bytes=new Uint8Array(readFileSync(resolve(folder,name)));
    accepts(bytes);accepts(bytes,READ_ENTRY_LIMIT);
    expect(loadInterchangeScore(bytes,new Settings()).tracks.length).toBeGreaterThan(0);
  });
  it('still refuses a real GP archive once one header lies',()=>{
    const bytes=new Uint8Array(readFileSync(resolve(folder,'guitarpro7-notes.gp')));
    new DataView(bytes.buffer).setUint32(22,0x7fffffff,true);
    refuses(bytes,/mismatch/);
  });
});

describe('compressed GPX',()=>{
  const header=(size:number)=>{const bytes=new Uint8Array(16);bytes.set([0x42,0x43,0x46,0x5a]);new DataView(bytes.buffer).setInt32(4,size,true);return bytes;};
  it('refuses a declared size past the limit, which the stock reader would inflate to',()=>{
    expect(()=>validateArchive(header(READ_ENTRY_LIMIT+1),READ_ENTRY_LIMIT)).toThrow('GPX data exceeds 32 MiB.');
    expect(()=>validateArchive(header(READ_ENTRY_LIMIT),READ_ENTRY_LIMIT)).not.toThrow();
  });
});
