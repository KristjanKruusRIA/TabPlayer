// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { Settings } from '@coderline/alphatab';
import { accoladeMetrics } from './accolades';
import { defaultEngraving } from './projection';
import { withLongFirstShortAfter,withStaffGaps,withStaffGroups } from './staff-groups';
import { withSystemGaps } from './system-gaps';
import { threeTrackScore } from './staff-fixtures';
import { braceGlyphs,countText,exportPages,exportWithBounds,installTextMeasure,markBoxes,nameBoxes,pagesHash,stablePages,systemBoxes,trackNames,usableRight,withoutMarks } from './staff-render-helpers';
import type { StaffGroupKind } from './types';

// SHA-256 of JSON.stringify(stablePages(exportPages({engraving:defaultEngraving()}))), recorded at a04f3c3 before any export code changed.
// stablePages only renumbers alphaTab's per-beat class names (a process-wide counter); the rest of every page is hashed as it is.
const NO_GROUPS_SHA256='835470b6a122843f21a6bfd08659f6bbb75a9b629526b92386f7d0a5f6085113';

beforeEach(installTextMeasure);
afterEach(()=>vi.restoreAllMocks());

const grouped=(kind:StaffGroupKind,trackIds:string[],e=defaultEngraving())=>withStaffGroups(e,[{trackIds,kind}]);
it('exports the recorded no-groups pages byte for byte',()=>{
  expect(pagesHash(exportPages({engraving:defaultEngraving()}))).toBe(NO_GROUPS_SHA256);
  expect(stablePages(exportPages({engraving:withStaffGaps(withStaffGroups(defaultEngraving(),[]),[])}))).toEqual(stablePages(exportPages({engraving:defaultEngraving()})));
});
it('a bracket group draws one group bracket per system and turns alphaTab brackets off',()=>{
  const svg=exportPages({engraving:grouped('bracket',['base/0','base/1'])}).map(p=>p.svg).join(''),systems=systemBoxes(svg).length;
  expect(systems).toBeGreaterThan(1);
  expect(countText(svg,'data-tp-accolade="group-bracket"')).toBe(systems);
  expect(countText(svg,'data-tp-accolade="track-brace"')).toBe(systems);
  expect(countText(withoutMarks(svg),'&#57347;')).toBe(0);expect(countText(withoutMarks(svg),'&#57344;')).toBe(0);
});
it('a brace group spans guitar top to piano bottom on every system',()=>{
  const {svg,bounds}=exportWithBounds({engraving:grouped('brace',['base/0','base/1'])});
  const groups=markBoxes(svg).filter(m=>m.role==='group');
  expect(groups).toHaveLength(bounds.length);
  for(const [index,mark] of groups.entries()){expect(mark.top).toBeCloseTo(bounds[index].guitarTop,0);expect(mark.bottom).toBeCloseTo(bounds[index].pianoBottom,0);}
});
it('a brace group still spans guitar top to piano bottom after a 200% gap opens between them',()=>{
  const e=withStaffGaps(grouped('brace',['base/0','base/1']),[{trackId:'base/0',scale:2}]);
  const {svg,bounds}=exportWithBounds({engraving:e}),plain=exportWithBounds({engraving:grouped('brace',['base/0','base/1'])});
  const groups=markBoxes(svg).filter(m=>m.role==='group');
  expect(groups).toHaveLength(bounds.length);
  for(const [index,mark] of groups.entries()){
    expect(mark.top).toBeCloseTo(bounds[index].guitarTop,0);expect(mark.bottom).toBeCloseTo(bounds[index].pianoBottom,0);
    // taller than without the gap by the measured space between the guitar and the piano
    const plainMark=markBoxes(plain.svg).filter(m=>m.role==='group')[index];
    expect((mark.bottom-mark.top)-(plainMark.bottom-plainMark.top)).toBeCloseTo(plain.bounds[index].pianoTop-plain.bounds[index].guitarBottom,0);
  }
});
it('the drawn piano brace sits where alphaTab drew it',()=>{
  // Drawing the accolades ourselves removes the room alphaTab keeps above a system for its bracket spikes, so absolute page positions differ
  // (recorded limit); the brace is compared with the piano staves of its own render: same baseline offset, same height.
  const nativeEngraving=defaultEngraving();nativeEngraving.stylesheet.brackets='staves';
  const native=exportWithBounds({engraving:nativeEngraving}),drawn=exportWithBounds({engraving:grouped('bracket',['base/0','base/1'])});
  const nativeBraces=braceGlyphs(native.pages),drawnBraces=markBoxes(drawn.svg).filter(m=>m.role==='track'&&m.kind==='brace');
  const braceHeight=accoladeMetrics(new Settings()).brace.height;
  expect(nativeBraces.length).toBeGreaterThan(1);
  expect(drawnBraces).toHaveLength(nativeBraces.length);
  drawnBraces.forEach((mark,i)=>{
    expect(Math.abs((mark.bottom-drawn.bounds[i].pianoBottom)-(nativeBraces[i].y-native.bounds[i].pianoBottom))).toBeLessThanOrEqual(1);
    expect(Math.abs((mark.bottom-mark.top)-braceHeight*nativeBraces[i].scale)).toBeLessThanOrEqual(1);
  });
});
it('a single rendered member draws no group and keeps alphaTab\'s native brace',()=>{
  const svg=exportPages({engraving:grouped('bracket',['base/0','base/1']),rendered:[1]}).map(p=>p.svg).join('');
  expect(svg).not.toContain('data-tp-accolade');expect(countText(svg,'&#57344;')).toBeGreaterThan(0);
});
it('names end left of every mark and systems fit the page with the reserve',()=>{
  const {score,ids}=threeTrackScore({names:['A very long guitar part name','Grand Piano','Drums']});
  for(const direction of ['horizontal','vertical'] as const){
    const e=grouped('brace',['base/1','base/2'],withLongFirstShortAfter({...defaultEngraving(),stylesheet:{...defaultEngraving().stylesheet,firstNameDirection:direction,otherNameDirection:direction}}));
    for(const page of exportPages({engraving:e,score,ids})){const names=nameBoxes(page.svg,trackNames(score)),marks=markBoxes(page.svg);
      expect(names.length).toBeGreaterThan(0);expect(names.every(n=>trackNames(score).includes(n.text))).toBe(true);expect(marks.length).toBeGreaterThan(0);
      for(const system of new Set(names.map(n=>n.system)))
        expect(Math.max(...names.filter(n=>n.system===system).map(n=>n.right))).toBeLessThanOrEqual(Math.min(...marks.filter(m=>m.system===system).map(m=>m.x))+.5);
      for(const s of systemBoxes(page.svg))expect(s.left+s.width).toBeLessThanOrEqual(usableRight(page)+1);}
  }
});
it('a 200% gap below the guitar moves piano and drums, not the guitar, by the measured gap',()=>{
  const base=exportWithBounds({engraving:defaultEngraving()}),gapped=exportWithBounds({engraving:withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}])});
  const measured=base.bounds[0].pianoTop-base.bounds[0].guitarBottom;
  expect(measured).toBeGreaterThan(5);
  expect(gapped.systemHeights[0]-base.systemHeights[0]).toBeCloseTo(measured,0);
  expect(gapped.trackTops[0]).toEqual([base.trackTops[0][0],base.trackTops[0][1]+measured,base.trackTops[0][2]+measured].map(v=>expect.closeTo(v,0)));
});
it('staff gaps compose before system gaps',()=>{
  const e=withSystemGaps(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]),[{bar:4,scale:2}]),pages=exportWithBounds({engraving:e});
  // the third system (bars 5-8 of the fixture's [2,2,4,2,2] layout) sits below the second by the composed height of the second plus the D08 offset 20 x 1 x 1
  expect(pages.systemTops[2]-pages.systemTops[1]).toBeCloseTo(pages.systemHeights[1]+20,0);
});
it('keeps refusing text that does not fit when staff gaps are set',()=>{
  const typography={family:'serif' as const,textScale:2,titleScale:null,tabScale:null};
  const gapped=withStaffGaps({...defaultEngraving(),typography},[{trackId:'base/0',scale:2}]);
  const {score,ids}=threeTrackScore();
  expect(()=>exportPages({engraving:gapped,score,ids})).not.toThrow();
  // The same export with a long annotation: the bars fit, the text does not. It must be measured before the bands move it under <defs>.
  const long=threeTrackScore();long.score.tracks[0].staves[0].bars[0].voices[0].beats[0].text='A long annotation line that surely needs more than the room left at the end of the bar, and then some more words';
  expect(()=>exportPages({engraving:gapped,score:long.score,ids:long.ids})).toThrow(/The text .* does not fit the page width/);
  expect(()=>exportPages({engraving:withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]),score:long.score,ids:long.ids})).not.toThrow();
});

// alphaTab ends a chunk at the last bar of a multi-bar rest but records the rest in its bounds under the first bar.
const multiRestScore=()=>{
  const fixture=threeTrackScore();
  for(const track of fixture.score.tracks)for(const staff of track.staves)for(const bar of staff.bars.slice(6))for(const voice of bar.voices)for(const beat of voice.beats)beat.notes.length=0;
  return fixture;
};
const multiRests=()=>{const e=defaultEngraving();e.stylesheet.multiRests='on';return e;};
it('composes staff gaps and groups when a multi-bar rest ends a system',()=>{
  const {score,ids}=multiRestScore(),plain=exportWithBounds({engraving:multiRests(),score,ids});
  // Bars 6 and 7 close the third system as one rest, so that system's chunk ends past the bar its bounds end on.
  expect(plain.systemHeights.length).toBeGreaterThan(2);
  const gapped=exportWithBounds({engraving:withStaffGaps(multiRests(),[{trackId:'base/0',scale:2}]),score,ids});
  const measured=plain.bounds.map(b=>b.pianoTop-b.guitarBottom);
  gapped.systemHeights.forEach((height,i)=>expect(height-plain.systemHeights[i]).toBeCloseTo(measured[i],0));
  const group=exportPages({engraving:grouped('bracket',['base/0','base/1'],multiRests()),score,ids}).map(p=>p.svg).join('');
  expect(countText(group,'data-tp-accolade="group-bracket"')).toBe(systemBoxes(group).length);
});
