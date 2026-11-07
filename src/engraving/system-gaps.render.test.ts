import { expect,it } from 'vitest';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { renderPdfPages } from '../export/pdf';
import { defaultPrintLayout } from '../document-settings';
import { defaultEngraving } from './projection';
import { withSystemGaps } from './system-gaps';
import type { EngravingOverrides,SystemGap } from './types';

const basePage={widthMm:297,heightMm:400,marginsMm:{top:10,right:10,bottom:10,left:10},scale:1,profile:'document' as const};

const run=(pageScale:number)=>it(`exports the extra gap at page scale ${pageScale} before one system and leaves every other distance unchanged`,()=>{
  const page={...basePage,scale:pageScale};
  const score=buildScore(blankProject());score.defaultSystemsLayout=1;score.systemsLayout=[1];
  const ids=score.tracks.map(trackIdentity),layout=defaultPrintLayout();
  // The y of every system group on each page, from the page SVG's translate(x y).
  const positions=(engraving:EngravingOverrides)=>renderPdfPages(score,{tracks:[0],range:null},layout,{page,engraving,trackIds:ids}).map(p=>[...p.svg.matchAll(/<g transform="translate\(([\d.]+) ([\d.-]+)\)">/g)].map(m=>Number(m[2])));
  const plain=positions(defaultEngraving());
  expect(plain.flat().length).toBeGreaterThanOrEqual(3);
  expect(positions(withSystemGaps(defaultEngraving(),[]))).toEqual(plain);
  // The first page holds the first systems, systems here are bars 0-2 and bar 3, so the gap on bar 3 stays on the page.
  const withGap=(gaps:SystemGap[],spacing:number|null=null)=>positions({...withSystemGaps(defaultEngraving(),gaps),systemSpacing:spacing});
  const spaced=(spacing:number)=>positions({...defaultEngraving(),systemSpacing:spacing});
  for(const [scale,spacing,offset] of [[2,null,20*pageScale],[.5,null,-10*pageScale],[2,2,40*pageScale]] as const) {
    const base=spacing===null?plain:spaced(spacing),got=withGap([{bar:3,scale}],spacing);
    expect(got.length).toBe(base.length);
    const flatBase=base[0],flatGot=got[0];
    const differing=flatGot.findIndex((y,i)=>Math.abs(y-flatBase[i])>1e-9);
    expect(differing).toBeGreaterThan(0);
    // Everything before the chosen system is unchanged; it and the later ones on the page move by the same offset.
    for(let i=0;i<flatGot.length;i++)expect(flatGot[i]-flatBase[i]).toBeCloseTo(i<differing?0:offset,6);
    // Distances between systems after the chosen one are unchanged.
    for(let i=differing+1;i<flatGot.length;i++)expect(flatGot[i]-flatGot[i-1]).toBeCloseTo(flatBase[i]-flatBase[i-1],6);
    expect(flatGot[differing]-flatGot[differing-1]).toBeCloseTo(flatBase[differing]-flatBase[differing-1]+offset,6);
  }
  // A gap before the score's first system is ignored.
  expect(withGap([{bar:0,scale:4}])).toEqual(plain);
});

run(1);run(1.5);
