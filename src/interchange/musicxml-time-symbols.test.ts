import { expect,it,vi } from 'vitest';
import { Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { loadInterchangeScore } from './gp';
import { applyMusicXmlTimeSymbols } from './musicxml-time-symbols';

// In MusicXML a time signature, including its symbol, stays in force until the next <time>. alphaTab 1.8.4 sets
// timeSignatureCommon only on the measure whose own <time> carries the symbol, so the importer is completed here.
const settings=new Settings();
const time=(beats:number,type:number,symbol?:string)=>`<time${symbol?` symbol="${symbol}"`:''}><beats>${beats}</beats><beat-type>${type}</beat-type></time>`;
const note='<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>';
/** `body` is the content of a measure; a measure given as a string of attributes gets them before its note. */
const measure=(number:number,attributes='',after='')=>`<measure number="${number}">${attributes?`<attributes><divisions>1</divisions>${attributes}</attributes>`:number===1?'<attributes><divisions>1</divisions></attributes>':''}${note}${after}</measure>`;
const file=(...parts:string[][])=>strToU8(`<?xml version="1.0"?><score-partwise version="4.0"><part-list>${parts.map((_,index)=>`<score-part id="P${index+1}"><part-name>Part ${index+1}</part-name></score-part>`).join('')}</part-list>${parts.map((measures,index)=>`<part id="P${index+1}">${measures.join('')}</part>`).join('')}</score-partwise>`);
const flags=(xml:Uint8Array)=>loadInterchangeScore(xml,settings).masterBars.map(bar=>bar.timeSignatureCommon);
const meters=(xml:Uint8Array)=>loadInterchangeScore(xml,settings).masterBars.map(bar=>`${bar.timeSignatureNumerator}/${bar.timeSignatureDenominator}`);

it('carries a common-time symbol forward to following measures without a time of their own',()=>{
  expect(flags(file([measure(1,time(4,4,'common')),measure(2),measure(3)]))).toEqual([true,true,true]);
});
it('stops at a later time in the same meter that has no symbol, which is numeric from there',()=>{
  const xml=file([measure(1,time(4,4,'common')),measure(2,time(4,4)),measure(3)]);
  expect(flags(xml)).toEqual([true,false,false]);
});
it('does not carry the symbol into a later different meter, nor past it',()=>{
  const xml=file([measure(1,time(4,4,'common')),measure(2,time(3,4)),measure(3)]);
  expect(meters(xml)).toEqual(['4/4','3/4','3/4']);expect(flags(xml)).toEqual([true,false,false]);
  const back=file([measure(1,time(3,4)),measure(2,time(4,4,'common')),measure(3)]);
  expect(flags(back)).toEqual([false,true,true]);
});
it('carries a cut-time symbol over 2/2',()=>{
  expect(flags(file([measure(1,time(2,2,'cut')),measure(2),measure(3)]))).toEqual([true,true,true]);
});
it('applies a symbol written in any part and carries it for the whole score',()=>{
  const xml=file([measure(1,time(4,4)),measure(2),measure(3)],[measure(1,time(4,4,'common')),measure(2),measure(3)]);
  expect(flags(xml)).toEqual([true,true,true]);
});
it('ignores a time that comes after a note in its measure, as the importer does',()=>{
  const late=`<attributes>${time(3,4)}</attributes>`;
  const xml=file([measure(1,time(4,4,'common')),measure(2,'',late),measure(3)]);
  expect(meters(xml)).toEqual(['4/4','4/4','4/4']);expect(flags(xml)).toEqual([true,true,true]);
});
it('leaves a file without a symbol as imported',()=>{
  expect(flags(file([measure(1,time(4,4)),measure(2),measure(3)]))).toEqual([false,false,false]);
});
it('leaves a file it cannot follow as imported',()=>{
  const entity=strToU8(new TextDecoder().decode(file([measure(1,time(4,4,'common')),measure(2),measure(3)])).replace('Part 1','Part &unknown; 1'));
  expect(()=>flags(entity)).not.toThrow();
});

// The carry starts only from a measure the importer itself flagged, and only parses a file that really holds a symbol.
const bodyOf=(inner:string)=>strToU8(`<?xml version="1.0"?><score-partwise version="4.0">${inner}</score-partwise>`);
const listed='<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>';
it('does not start a carry from a symbol the importer did not apply (a part that is not in the part list)',()=>{
  const xml=bodyOf(`${listed}<part id="P1">${[measure(1,time(4,4)),measure(2),measure(3)].join('')}</part><part id="P9">${[measure(1,time(4,4,'common')),measure(2),measure(3)].join('')}</part>`);
  expect(flags(xml)).toEqual([false,false,false]);
});
it('carries in a file with a character reference or CDATA outside the parts, and keeps the stock import for CDATA inside a part',()=>{
  const measures=[measure(1,time(4,4,'common')),measure(2),measure(3)].join('');
  expect(flags(bodyOf(`${listed.replace('Piano','Caf&#xE9; &#233;')}<part id="P1">${measures}</part>`))).toEqual([true,true,true]);
  expect(flags(bodyOf(`<movement-title><![CDATA[Slow]]></movement-title>${listed}<part id="P1">${measures}</part>`))).toEqual([true,true,true]);
  const inside=measures.replace(note,'<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric><text><![CDATA[la]]></text></lyric></note>');
  expect(flags(bodyOf(`${listed}<part id="P1">${inside}</part>`))).toEqual([true,false,false]);
});
it('parses only a file that holds a time with a common or cut symbol, and once',()=>{
  const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
  const count=(xml:Uint8Array)=>{parse.mockClear();const score=loadInterchangeScore(xml,settings,false);parse.mockClear();applyMusicXmlTimeSymbols(score,xml,settings);return parse.mock.calls.length;};
  expect(count(file([measure(1,time(4,4,'single-number')),measure(2)]))).toBe(0);
  expect(count(file([measure(1,time(4,4)),measure(2)]))).toBe(0);
  expect(count(file([measure(1,time(4,4,'common')),measure(2),measure(3)]))).toBe(1);
  parse.mockRestore();
});
