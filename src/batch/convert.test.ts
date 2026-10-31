import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe,expect,it } from 'vitest';
import { Settings } from '@coderline/alphatab';
import { strToU8,zipSync } from 'fflate';
import { loadInterchangeScore } from '../interchange/gp';
import { convertScoreBytes,runBatch,summarize,TRUNCATED_NOTE,type BatchBridge,type BatchScan } from './convert';
import type { Probe } from './probe';

const xml=(title:string)=>strToU8(`<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`);
const folder=process.env.TABPLAYER_COMPATIBILITY_DIR??resolve('.analysis/compatibility');
const sizeOf=(value:Uint8Array)=>loadInterchangeScore(value,new Settings());

/** An in-memory folder: `files` holds the originals, `written` what the batch saved. */
function fakeBridge(files:Record<string,Uint8Array>,options:{failWrite?:string}={}) {
  const names=Object.keys(files),written:Record<string,Uint8Array>={},writes:string[]=[];
  const bridge:BatchBridge={
    pickFolder:async()=>'folder',
    reset:async()=>{},
    scan:async()=>{throw new Error('not used');},
    read:async index=>files[names[index]].slice(),
    write:async(index,bytes)=>{
      if(names[index]===options.failWrite)throw new Error('The disk is full.');
      const name=`${names[index].replace(/\.[^.]+$/,'')}.gp`;written[name]=bytes;writes.push(name);return {relative:name,renamed:false};
    },
  };
  const scan:BatchScan={files:names.map((relative,index)=>({index,relative,bytes:files[relative].length})),skipped:[],truncated:false,totalBytes:0};
  return {bridge,scan,written,writes};
}
const pass:Probe=async()=>({ok:true,tracks:1,bars:1});
const run=(bridge:BatchBridge,scan:BatchScan,cancelled=()=>false,probe:Probe=pass)=>runBatch({bridge,scan,keepFolders:true,cancelled,onProgress:()=>{},probe});

describe('convertScoreBytes',()=>{
  it('writes MusicXML as a GP file that reads back as the same score',()=>{
    const converted=convertScoreBytes(xml('Lead sheet'));
    expect(Array.from(converted.bytes.slice(0,4))).toEqual([0x50,0x4b,3,4]);
    const score=sizeOf(converted.bytes);
    expect(score.title).toMatch(/^Lead\s+sheet$/);expect(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue).toBe(60);
    expect(converted.detail).toBe('1 track, 1 bar');
  });
  it('refuses bytes that are not a score',()=>{
    expect(()=>convertScoreBytes(strToU8('not a score'))).toThrow();
    expect(()=>convertScoreBytes(new Uint8Array())).toThrow();
  });
  it.skipIf(!existsSync(resolve(folder,'guitarpro5-notes.gp5')))('converts each legacy format in the public corpus to the current GP format',()=>{
    for(const name of ['guitarpro3-notes.gp3','guitarpro4-notes.gp4','guitarpro5-notes.gp5','guitarpro6-notes.gpx','guitarpro7-notes.gp']){
      const original=new Uint8Array(readFileSync(resolve(folder,name))),before=original.slice(),converted=convertScoreBytes(original);
      expect(original).toEqual(before);
      const read=(bytes:Uint8Array)=>sizeOf(bytes).tracks[0].staves[0].bars.map(bar=>bar.voices[0].beats.map(beat=>[beat.duration,beat.notes.map(note=>`${note.string}:${note.fret}`).join(' ')]));
      expect(read(converted.bytes),name).toEqual(read(before));
      expect(Array.from(converted.bytes.slice(0,2))).toEqual([0x50,0x4b]);
    }
  });
});

describe('runBatch',()=>{
  it('reports every file, continues past a failure and leaves the originals unchanged',async()=>{
    const originals={'a.xml':xml('A'),'bad.gp3':strToU8('garbage'),'sub/b.xml':xml('B'),'full.xml':xml('Full')};
    const snapshot=Object.fromEntries(Object.entries(originals).map(([name,bytes])=>[name,bytes.slice()]));
    const {bridge,scan,written}=fakeBridge(originals,{failWrite:'full.xml'});
    const rows=await run(bridge,{...scan,skipped:[{relative:'huge.gp5',reason:'Larger than 32 MiB.'}]});
    expect(rows.map(row=>[row.relative,row.status])).toEqual([['a.xml','Converted'],['bad.gp3','Failed'],['full.xml','Failed'],['huge.gp5','Skipped'],['sub/b.xml','Converted']]);
    expect(rows.find(row=>row.relative==='full.xml')!.detail).toBe('The disk is full.');
    expect(rows.find(row=>row.relative==='a.xml')!.detail).toBe('1 track, 1 bar. Saved as a.gp.');
    expect(Object.keys(written).sort()).toEqual(['a.gp','sub/b.gp']);
    expect(originals).toEqual(snapshot);
    expect(summarize(rows,scan)).toBe('2 converted, 2 failed, 1 skipped.');
  });
  it('stops on cancel, reports the files it did not reach and never writes them',async()=>{
    const {bridge,scan,writes}=fakeBridge({'a.xml':xml('A'),'b.xml':xml('B'),'c.xml':xml('C')});
    let done=0;
    const rows=await runBatch({bridge,scan,keepFolders:true,cancelled:()=>done>=1,probe:pass,onProgress:count=>{done=Math.max(done,count+1);}});
    expect(rows.map(row=>[row.relative,row.status])).toEqual([['a.xml','Converted'],['b.xml','Not converted'],['c.xml','Not converted']]);
    expect(writes).toEqual(['a.gp']);
    expect(summarize(rows,scan)).toBe('1 converted, 0 failed, 2 not converted.');
  });
  it('passes the folder option through and says when a limit left files out',async()=>{
    const {scan}=fakeBridge({'a.xml':xml('A')});
    const kept:boolean[]=[],bridge:BatchBridge={reset:async()=>{},pickFolder:async()=>null,scan:async()=>scan,read:async()=>xml('A'),write:async(_i,_b,keep)=>{kept.push(keep);return {relative:'x.gp',renamed:true,note:'Windows programs read this name as a device.'};}};
    const rows=await runBatch({bridge,scan:{...scan,truncated:true},keepFolders:false,cancelled:()=>false,onProgress:()=>{},probe:pass});
    expect(kept).toEqual([false]);expect(rows[0].detail).toContain('Saved as x.gp because the name was taken.');expect(rows[0].detail).toContain('read this name as a device');
    expect(summarize(rows,{...scan,truncated:true})).toContain(TRUNCATED_NOTE);
    expect(TRUNCATED_NOTE).toContain('Choose a subfolder');expect(TRUNCATED_NOTE).not.toContain('again');
  });
  it('keeps a file the probe refuses off the window thread, reports it Failed and goes on',async()=>{
    const {bridge,scan,written}=fakeBridge({'a.xml':xml('A'),'hang.gpx':xml('Hang'),'c.xml':xml('C')});
    const asked:number[]=[];
    const probe:Probe=async bytes=>{asked.push(bytes.length);return bytes.length===xml('Hang').length&&asked.length===2?{ok:false,error:'The file did not open within 15 seconds, so it was left out. It may be damaged.'}:{ok:true,tracks:1,bars:1};};
    const rows=await run(bridge,scan,()=>false,probe);
    expect(rows.map(row=>[row.relative,row.status])).toEqual([['a.xml','Converted'],['c.xml','Converted'],['hang.gpx','Failed']]);
    expect(rows.find(row=>row.relative==='hang.gpx')!.detail).toContain('did not open within');
    expect(Object.keys(written).sort()).toEqual(['a.gp','c.gp']);
  });
});

describe('the window reads under the cap the probe read with',()=>{
  // One entry between the two caps: the importer's default would take it, and the probe's cap does not.
  const oversized=()=>zipSync({'META-INF/container.xml':strToU8('<container/>'),'large.bin':new Uint8Array(33*1024*1024)},{level:1});
  it('refuses an entry over the batch cap on the window thread too',()=>{
    expect(()=>convertScoreBytes(oversized())).toThrow(/ZIP entry exceeds 32 MiB/);
    expect(()=>loadInterchangeScore(oversized(),new Settings())).not.toThrow(/ZIP/);
  });
  it('fails a file the validator refuses and goes on, even when a probe let it through',async()=>{
    const crafted=oversized();
    const {bridge,scan,writes}=fakeBridge({'crafted.gp':crafted,'good.xml':xml('Good')});
    const rows=await run(bridge,scan);
    expect(rows.map(row=>[row.relative,row.status])).toEqual([['crafted.gp','Failed'],['good.xml','Converted']]);
    expect(rows[0].detail).toMatch(/ZIP entry exceeds/);expect(writes).toEqual(['good.gp']);
  });
});

it('converts a dense score whose written score.gpif is larger than the input cap',()=>{
  const note='<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>'.repeat(4);
  const measure=(number:number)=>`<measure number="${number}">${number===1?'<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>':''}${note}</measure>`;
  const measures:string[]=[];for(let number=1;measures.length*500<12*1024*1024;number++)measures.push(measure(number));
  const dense=strToU8(`<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>G</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`);
  const {detail,bytes}=convertScoreBytes(dense);
  expect(detail).toBe(`1 track, ${measures.length} bars`);expect(bytes.length).toBeGreaterThan(0);
},60000);
