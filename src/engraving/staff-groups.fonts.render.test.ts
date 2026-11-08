// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EngravingSettings,Settings } from '@coderline/alphatab';
import { accoladeMetrics } from './accolades';
import { withFonts } from './fonts';
import { defaultEngraving } from './projection';
import { mergeSmuflMetadata } from './smufl';
import { withStaffGroups } from './staff-groups';
import { exportPages,exportWithBounds,installTextMeasure,markBoxes } from './staff-render-helpers';
import type { MusicFontData } from './font-loading';
import type { StaffGroupKind } from './types';

/**
 * Drawn accolades are sized from the music font the pages were laid out with. The expected numbers come from Leland's own SMuFL metadata
 * (bracketThickness and the brace bounding box, in staff spaces) times the staff space alphaTab lays out with (musicFontSize / 4), never from the code under test.
 */
const lelandFile=JSON.parse(readFileSync('assets/fonts/leland_metadata.json','utf8'));
const lelandMetadata=lelandFile as {engravingDefaults:{bracketThickness:number};glyphBBoxes:{brace:{bBoxNE:[number,number];bBoxSW:[number,number]}}};
const leland=():MusicFontData=>{
  const {metadata,substituted}=mergeSmuflMetadata(lelandFile,EngravingSettings.bravuraMetadata);
  return {id:'leland',families:['Leland','TabPlayer Bravura'],metadata,substituted};
};
const space=new Settings().display.resources.engravingSettings.musicFontSize/4;
const {bBoxNE,bBoxSW}=lelandMetadata.glyphBBoxes.brace;
const expected={bracket:lelandMetadata.engravingDefaults.bracketThickness*space,braceWidth:(bBoxNE[0]-bBoxSW[0])*space,braceHeight:(bBoxNE[1]-bBoxSW[1])*space};
const lelandMetrics={...accoladeMetrics(new Settings()),bracketThickness:expected.bracket,brace:{width:expected.braceWidth,height:expected.braceHeight}};

beforeEach(installTextMeasure);
afterEach(()=>vi.restoreAllMocks());
const grouped=(kind:StaffGroupKind,music?:'leland')=>{
  const groups=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind}]);
  return music?withFonts(groups,{music}):groups;
};

it('a Leland export draws group brackets as thick as Leland says and keeps Leland in the page music CSS',()=>{
  const svg=exportPages({engraving:grouped('bracket','leland'),music:leland()}).map(page=>page.svg).join('');
  expect(svg).toContain('.at{font-family:Leland,Bravura;font-size:36px}');
  const bars=[...svg.matchAll(/<g data-tp-accolade="group-bracket"><rect [^>]*width="([\d.]+)"/g)].map(match=>Number(match[1]));
  expect(bars.length).toBeGreaterThan(1);
  for(const width of bars)expect(width).toBeCloseTo(expected.bracket,2);
  // Bravura draws the same group thicker, so the thickness really came from the chosen font.
  const plain=exportPages({engraving:grouped('bracket')}).map(page=>page.svg).join('');
  const plainBars=[...plain.matchAll(/<g data-tp-accolade="group-bracket"><rect [^>]*width="([\d.]+)"/g)].map(match=>Number(match[1]));
  for(const width of plainBars)expect(width).toBeGreaterThan(expected.bracket+.3);
  expect(expected.bracket).toBeCloseTo(4.05,2);
});

it('a Leland export sizes the group brace from Leland\'s brace glyph and spans the grouped staves',()=>{
  const {svg,bounds}=exportWithBounds({engraving:grouped('brace','leland'),music:leland()});
  expect(svg).toContain('.at{font-family:Leland,Bravura;font-size:36px}');
  expect(expected.braceWidth).toBeCloseTo(2.25,2);
  const groups=markBoxes(svg,lelandMetrics).filter(mark=>mark.role==='group');
  expect(groups).toHaveLength(bounds.length);
  for(const [index,mark] of groups.entries()){
    // Read through Leland's glyph height the brace spans guitar top to piano bottom; read through Bravura's it would miss by a pixel or more.
    expect(mark.top).toBeCloseTo(bounds[index].guitarTop,0);expect(mark.bottom).toBeCloseTo(bounds[index].pianoBottom,0);
    const factor=(mark.bottom-mark.top)/expected.braceHeight;
    expect(mark.width).toBeCloseTo(expected.braceWidth*Math.min(factor,4),2);
  }
});
