import { describe,expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { defaultPrintLayout } from '../document-settings';
import { kitScore } from '../engraving/drum-tab-fixtures';
import { defaultEngraving,projectEngraving } from '../engraving/projection';
import type { TrackProfile } from '../engraving/types';
import { exportAsciiTab } from './ascii-tab';
import { exportGp5 } from './gp5';
import { renderPdfPages } from './pdf';

/**
 * THE-220: print goes through the engraving projection, so a drum track's tab profile prints the numbers. The default "Score and tab" page profile leaves a drum track as it
 * always printed; ASCII tab and Guitar Pro export read the source score and do not change.
 */
type PageLayout=NonNullable<Parameters<typeof renderPdfPages>[3]>['page'];
const page=(profile:'document'|'Score'|'Tab'|'ScoreTab'):PageLayout=>({widthMm:297,heightMm:210,marginsMm:{top:10,right:10,bottom:10,left:10},scale:1,profile});
function print(profile:TrackProfile|null,pageProfile:'document'|'Score'|'Tab'|'ScoreTab'='document',tracks:number[]=[0,1]) {
  const {score,ids}=kitScore(),engraving={...defaultEngraving(),profiles:profile?[{trackId:ids[1],profile}]:[]};
  const pages=renderPdfPages(score,{tracks,range:null},defaultPrintLayout(),{page:page(pageProfile),engraving,trackIds:ids});
  const svg=pages.map(item=>item.svg).join('\n');
  return {svg,numbers:[...svg.matchAll(/>(\d+)<\/text>/g)].map(match=>Number(match[1])).filter(value=>value>=30).sort((a,b)=>a-b),columns:tabColumns(svg)};
}
/** Every text of an SVG, in drawing order. */
const texts=(svg:string)=>[...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(match=>({x:Number(/\bx="([^"]+)"/.exec(match[1])?.[1]),y:Number(/\by="([^"]+)"/.exec(match[1])?.[1]),text:match[2]}));
/**
 * The drum tab numbers by where they stand: left to right by column, each column as [number, line 0-5 from the top]. The line is the rank of the number's
 * height among the tab's six lines, which are 13 px apart (a number drawn between two lines would show as a seventh height).
 */
function tabColumns(svg:string):Array<Array<[number,number]>> {
  const numbers=texts(svg).filter(item=>/^\d+$/.test(item.text)&&Number(item.text)>=30&&Number.isFinite(item.y));
  const heights=[...new Set(numbers.map(item=>item.y))].sort((a,b)=>a-b);
  if(heights.length>6)throw new Error(`Tab numbers stand at ${heights.length} heights, not on six lines.`);
  const columns=new Map<number,Array<[number,number]>>();
  for(const item of numbers)columns.set(item.x,[...columns.get(item.x)??[],[Number(item.text),Math.round((item.y-heights[0])/13)]]);
  return [...columns.entries()].sort((a,b)=>a[0]-b[0]).map(([,notes])=>notes.sort((a,b)=>a[1]-b[1]));
}
// Every hit of the kit pattern, except that the crash tied into bar 2 is drawn as a tie and not written a second time.
const kit=[36,36,36,38,38,42,42,42,45,47,49,53,91];
// The same hits column by column, each with its line from the top: crash 1, ride and bells 2, hi-hat 3, toms 4, snare 5, kick 6 (written 0-5). The 47 shares the beat's tom line with the 45
// and moves up to the hi-hat line; the tied crash at the start of bar 2 is drawn in brackets, not as a number.
const kitLines=[[[42,2],[36,5]],[[42,2],[38,4]],[[49,0],[42,2],[36,5]],[[53,1],[91,4]],[[38,4]],[[47,2],[45,3]],[[36,5]]];
/** alphaTab numbers the bars it draws from a counter that moves on with every render. */
const plain=(svg:string)=>svg.replace(/class="b\d+"/g,'class="b"');

describe('printing a drum track',()=>{
  it('writes the sound numbers when its profile is tablature, or standard + tablature',()=>{
    for(const profile of ['tablature','standardTab'] as const)expect(print(profile).numbers,profile).toEqual(kit);
  });
  it('writes each number on the line of its sound, and no tuning header, in tab only and in standard + tab',()=>{
    for(const profile of ['tablature','standardTab'] as const){
      expect(print(profile).columns,profile).toEqual(kitLines);
      // The drum track alone: a guitar track prints its tuning (checked below), a drum tab prints none.
      expect(texts(print(profile,'document',[1]).svg).filter(item=>/tuning/i.test(item.text)),profile).toEqual([]);
    }
  });
  it('would show a tuning header if one leaked: the guitar track prints one',()=>{
    expect(texts(print(null,'document',[0]).svg).some(item=>/tuning/i.test(item.text))).toBe(true);
  });
  it('writes no sound number for a drum track without such a profile',()=>{
    expect(print(null).numbers).toEqual([]);expect(print('standard').numbers).toEqual([]);
  });
  it('gives the page profile "Tab" drum tab, and leaves "Score and tab" as it always printed drums unless the track asks for tab itself',()=>{
    expect(print(null,'Tab').numbers.length).toBeGreaterThan(0);
    expect(print(null,'Score').numbers).toEqual([]);
    expect(plain(print(null,'ScoreTab').svg)).toBe(plain(print('standard','ScoreTab').svg));
    expect(print('standardTab','ScoreTab').numbers).toEqual(print('standardTab').numbers);
    expect(print('tablature','ScoreTab').numbers.length).toBeGreaterThan(0);
  });
});

describe('the other exports do not see the drum tab profile',()=>{
  const selection={tracks:[0,1],range:null};
  it('leaves the source score, the Guitar Pro bytes and the ASCII tab exactly as they were',()=>{
    const {score,ids}=kitScore(),json=model.JsonConverter.scoreToJson(score) as string;
    const gp=exportGp5(score,selection),ascii=exportAsciiTab(score,selection);
    for(const profile of ['tablature','standardTab'] as const){
      projectEngraving(score,ids,{...defaultEngraving(),profiles:[{trackId:ids[1],profile}]});
      print(profile);
      expect(model.JsonConverter.scoreToJson(score)).toBe(json);
      const after=exportGp5(score,selection);
      expect(Buffer.from(after.bytes).equals(Buffer.from(gp.bytes)),`GP5 ${profile}`).toBe(true);
      expect(after.losses).toEqual(gp.losses);
      expect(Buffer.from(exportAsciiTab(score,selection)).equals(Buffer.from(ascii)),`ASCII ${profile}`).toBe(true);
    }
    // The ASCII export writes its own six-line drum tab whatever the profile, so the numbers are there in every case.
    expect(new TextDecoder().decode(ascii)).toMatch(/\b36\b/);
  });
});
