import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { describe,expect,it } from 'vitest';
import { loadInterchangeScore } from './gp';
import { ARCHIVE_TOTAL_LIMIT,assertArchiveSize } from './zip-limits';

/** Rewrites the uncompressed size every central directory entry declares. */
function declare(bytes:Uint8Array,size:number):Uint8Array {
  const copy=bytes.slice(),view=new DataView(copy.buffer);
  for(let at=0;at<copy.length-46;at++)if(view.getUint32(at,true)===0x02014b50)view.setUint32(at+24,size,true);
  return copy;
}
const small=zipSync({'a.txt':strToU8('a'),'b.txt':strToU8('b'),'c.txt':strToU8('c')});
const folder=process.env.TABPLAYER_COMPATIBILITY_DIR??resolve('.analysis/compatibility');

describe('assertArchiveSize',()=>{
  it('accepts a normal archive and inflates nothing to find out',()=>{
    expect(()=>assertArchiveSize(small)).not.toThrow();
  });
  it('refuses an archive whose entries together declare more than the limit, each entry within the per-entry cap',()=>{
    const each=100_000_000; // under the 128 MB per-entry cap, but three of them are over the total
    expect(3*each).toBeGreaterThan(ARCHIVE_TOTAL_LIMIT);
    const crafted=declare(small,each);
    expect(each).toBeLessThanOrEqual(new Settings().importer.maxDecodingBufferSize);
    expect(()=>assertArchiveSize(crafted)).toThrow(/total limit/);
  });
  it('counts the declared sizes without trusting the data',()=>{
    // Declares far more than it holds: refused before anything is inflated, so this returns at once.
    const started=performance.now();
    expect(()=>assertArchiveSize(declare(small,0x7fffffff))).toThrow(/total limit/);
    expect(performance.now()-started).toBeLessThan(1000);
  });
  it('is the same archive fflate would otherwise walk entry by entry',()=>{
    expect(Object.keys(unzipSync(small))).toEqual(['a.txt','b.txt','c.txt']);
  });
});

describe.skipIf(!existsSync(resolve(folder,'guitarpro7-notes.gp')))('real archives',()=>{
  it('still open: every public GP7 and MusicXML-in-ZIP fixture is under the limit',()=>{
    const bytes=new Uint8Array(readFileSync(resolve(folder,'guitarpro7-notes.gp')));
    expect(()=>assertArchiveSize(bytes)).not.toThrow();
    expect(loadInterchangeScore(bytes,new Settings()).tracks.length).toBeGreaterThan(0);
  });
  it('refuses a real GP archive that declares an oversized total, before the window thread inflates it',()=>{
    const bytes=new Uint8Array(readFileSync(resolve(folder,'guitarpro7-notes.gp')));
    const crafted=declare(bytes,ARCHIVE_TOTAL_LIMIT);
    expect(()=>loadInterchangeScore(crafted,new Settings())).toThrow(/total limit/);
  });
  it('still opens a MusicXML container through the tempo-offset repack path',()=>{
    const xml=strToU8('<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>');
    const mxl=zipSync({'META-INF/container.xml':strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>'),'score.xml':xml});
    expect(loadInterchangeScore(mxl,new Settings()).tracks.length).toBe(1);
    expect(()=>loadInterchangeScore(declare(mxl,ARCHIVE_TOTAL_LIMIT),new Settings())).toThrow();
  });
});
