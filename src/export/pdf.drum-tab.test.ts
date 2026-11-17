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
function print(profile:TrackProfile|null,pageProfile:'document'|'Score'|'Tab'|'ScoreTab'='document') {
  const {score,ids}=kitScore(),engraving={...defaultEngraving(),profiles:profile?[{trackId:ids[1],profile}]:[]};
  const pages=renderPdfPages(score,{tracks:[0,1],range:null},defaultPrintLayout(),{page:page(pageProfile),engraving,trackIds:ids});
  const svg=pages.map(item=>item.svg).join('\n');
  return {svg,numbers:[...svg.matchAll(/>(\d+)<\/text>/g)].map(match=>Number(match[1])).filter(value=>value>=30).sort((a,b)=>a-b)};
}
// Every hit of the kit pattern, except that the crash tied into bar 2 is drawn as a tie and not written a second time.
const kit=[36,36,36,38,38,42,42,42,45,47,49,53,91];
/** alphaTab numbers the bars it draws from a counter that moves on with every render. */
const plain=(svg:string)=>svg.replace(/class="b\d+"/g,'class="b"');

describe('printing a drum track',()=>{
  it('writes the sound numbers when its profile is tablature, or standard + tablature',()=>{
    for(const profile of ['tablature','standardTab'] as const)expect(print(profile).numbers,profile).toEqual(kit);
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
    expect(new TextDecoder().decode(ascii)).not.toMatch(/\b(?:36|91)\b/);
  });
});
