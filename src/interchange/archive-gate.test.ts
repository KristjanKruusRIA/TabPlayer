import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { strToU8,zipSync } from 'fflate';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { validateArchive,OPEN_ENTRY_LIMIT } from './archive';
import { ARCHIVE_CHECK_REQUEST,ARCHIVE_CHECK_RESULT } from './archive-gate-messages';
import { admitDocumentBase,adoptAdmittedBase,assertArchiveAccepted,checkArchiveInWorker } from './archive-gate';
import type { CheckWorker } from './worker-check';

vi.mock('./archive',async original=>{
  const actual=await original<typeof import('./archive')>();
  return {...actual,validateArchive:vi.fn(actual.validateArchive)};
});

const sound=()=>zipSync({'a.txt':strToU8('some text')});
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
function stand_in(reply:(data:{cmd:string;bytes:Uint8Array;entryLimit:number})=>unknown):CheckWorker {
  const worker:CheckWorker={onmessage:null,onerror:null,onmessageerror:null,terminate:vi.fn(),postMessage:message=>queueMicrotask(()=>{
    const answer=reply(message as {cmd:string;bytes:Uint8Array;entryLimit:number});
    if(answer!==undefined)worker.onmessage?.({data:answer});
  })};
  return worker;
}
const pass=()=>({cmd:ARCHIVE_CHECK_RESULT,ok:true});
afterEach(()=>{vi.mocked(validateArchive).mockClear();});

describe('checkArchiveInWorker',()=>{
  it('sends a copy, and bytes the Worker accepted reach the parsers with no second check',async()=>{
    const bytes=sound();let sent:Uint8Array|undefined,limit=0;
    const worker=stand_in(data=>{sent=data.bytes;limit=data.entryLimit;expect(data.cmd).toBe(ARCHIVE_CHECK_REQUEST);return pass();});
    await checkArchiveInWorker(bytes,OPEN_ENTRY_LIMIT,{createWorker:()=>worker});
    expect(sent).toEqual(bytes);expect(sent).not.toBe(bytes);expect(limit).toBe(OPEN_ENTRY_LIMIT);expect(worker.terminate).toHaveBeenCalled();
    assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT);
    expect(validateArchive).not.toHaveBeenCalled();
  });
  it('throws what the Worker refused for, and records nothing',async()=>{
    const bytes=sound();
    await expect(checkArchiveInWorker(bytes,OPEN_ENTRY_LIMIT,{createWorker:()=>stand_in(()=>({cmd:ARCHIVE_CHECK_RESULT,ok:false,error:'ZIP refused.'}))})).rejects.toThrow('ZIP refused.');
    assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT);
    expect(validateArchive).toHaveBeenCalledTimes(1);
  });
  it('ends a Worker that does not answer by the deadline, and refuses',async()=>{
    const worker=stand_in(()=>undefined);
    await expect(checkArchiveInWorker(sound(),OPEN_ENTRY_LIMIT,{deadlineMs:30,createWorker:()=>worker})).rejects.toThrow(/did not open within/);
    expect(worker.terminate).toHaveBeenCalled();
  });
  it('refuses when the Worker cannot start, rather than parsing anyway',async()=>{
    await expect(checkArchiveInWorker(sound(),OPEN_ENTRY_LIMIT,{createWorker:()=>{throw new Error('no workers');}})).rejects.toThrow(/could not start/);
  });
  it('ignores messages that are not its answer',async()=>{
    await expect(checkArchiveInWorker(sound(),OPEN_ENTRY_LIMIT,{deadlineMs:30,createWorker:()=>stand_in(()=>({ok:true}))})).rejects.toThrow(/did not open within/);
  });
});

describe('admitDocumentBase',()=>{
  const project=(bytes:Uint8Array,sha256:string)=>({base:{kind:'file',bytesBase64:encode(bytes),sha256}});
  it('asks a Worker once per file, and later copies of the bytes need no check',async()=>{
    const bytes=sound(),create=vi.fn(()=>stand_in(pass));
    await admitDocumentBase(project(bytes,'a'.repeat(64)),{createWorker:create});
    await admitDocumentBase(project(bytes,'a'.repeat(64)),{createWorker:create});
    expect(create).toHaveBeenCalledTimes(2);
    const again=bytes.slice();adoptAdmittedBase('a'.repeat(64),again);assertArchiveAccepted(again,OPEN_ENTRY_LIMIT);
    expect(validateArchive).not.toHaveBeenCalled();
  });
  it('does not admit a file the Worker refused',async()=>{
    const bytes=sound(),refuse=()=>stand_in(()=>({cmd:ARCHIVE_CHECK_RESULT,ok:false,error:'ZIP refused.'}));
    await expect(admitDocumentBase(project(bytes,'b'.repeat(64)),{createWorker:refuse})).rejects.toThrow('ZIP refused.');
    const again=bytes.slice();adoptAdmittedBase('b'.repeat(64),again);assertArchiveAccepted(again,OPEN_ENTRY_LIMIT);
    expect(validateArchive).toHaveBeenCalledTimes(1);
  });
  it('starts no Worker for a blank document',async()=>{
    const create=vi.fn(()=>stand_in(pass));
    await admitDocumentBase({base:{kind:'blank'}},{createWorker:create});
    expect(create).not.toHaveBeenCalled();
  });
  it.each([['MusicXML',strToU8('<score-partwise/>')],['a binary score',new Uint8Array([24,70,73,67])]])('sends %s to the stock reader in a Worker',async(_name,bytes)=>{
    const seen:{read?:boolean}[]=[];
    await admitDocumentBase(project(bytes,bytes.length.toString(16).padStart(64,'0')),{createWorker:()=>stand_in(data=>{seen.push(data as {read?:boolean});return pass();})});
    expect(seen.map(data=>data.read)).toEqual([true]);
  });
  it('validates an archive first, then has the stock reader read it',async()=>{
    const seen:{read?:boolean}[]=[];
    await admitDocumentBase(project(sound(),'f'.repeat(64)),{createWorker:()=>stand_in(data=>{seen.push(data as {read?:boolean});return pass();})});
    expect(seen.map(data=>data.read)).toEqual([false,true]);
  });
  it('cuts off a file that keeps the reader busy, ends the Worker and admits nothing',async()=>{
    const worker=stand_in(()=>undefined),bytes=new Uint8Array([0x42,0x43,0x46,0x53,1,2,3,4]);
    await expect(admitDocumentBase(project(bytes,'1'.repeat(64)),{deadlineMs:30,createWorker:()=>worker})).rejects.toThrow('The file did not open within 0 seconds. It may be damaged.');
    expect(worker.terminate).toHaveBeenCalled();
    vi.stubGlobal('Worker',class {});
    try{expect(()=>adoptAdmittedBase('1'.repeat(64),bytes)).toThrow('This file has not passed the file check.');}
    finally{vi.unstubAllGlobals();}
  });
  it('refuses a base larger than any score native reads, before decoding it',async()=>{
    const create=vi.fn(()=>stand_in(pass));
    await expect(admitDocumentBase({base:{kind:'file',bytesBase64:'A'.repeat(90*1024*1024),sha256:'2'.repeat(64)}},{createWorker:create})).rejects.toThrow('The file is larger than 64 MiB.');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('assertArchiveAccepted',()=>{
  it('validates bytes that skipped a Worker before any parser can run',()=>{
    expect(()=>assertArchiveAccepted(new Uint8Array([80,75,3,4,9,9]),OPEN_ENTRY_LIMIT)).toThrow(/ZIP/);
    const bytes=sound();assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT);assertArchiveAccepted(bytes,OPEN_ENTRY_LIMIT);
    expect(validateArchive).toHaveBeenCalledTimes(2);
  });
});

describe('the real Worker module',()=>{
  it('keeps its message names in step and imports nothing from the window side',()=>{
    const source=readFileSync(resolve('src/interchange/archive.worker.ts'),'utf8');
    expect(source).not.toMatch(/archive-gate'/);expect(source).toContain('validateArchive(request.bytes,request.entryLimit)');
  });
  it('is the same validator on a real thread, with the deadline ending a Worker that spins',async()=>{
    const spin=new NodeWorker('for(;;);',{eval:true});
    const exited=new Promise<void>(accept=>spin.on('exit',()=>accept()));
    const worker:CheckWorker={onmessage:null,onerror:null,onmessageerror:null,postMessage:()=>{},terminate:()=>{void spin.terminate();}};
    await expect(checkArchiveInWorker(sound(),OPEN_ENTRY_LIMIT,{deadlineMs:50,createWorker:()=>worker})).rejects.toThrow(/did not open within/);
    await exited;
  });
});
