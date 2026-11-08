// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { defaultEngraving } from './projection';
import { withLongFirstShortAfter } from './staff-groups';
import { threeTrackScore } from './staff-fixtures';
import { systemTexts } from './staff-render-helpers';

// Real renderer, A4 export: the fixture's 12 bars break into at least three systems.
it('multi-track: full names on system 0, short names on later systems',()=>{
  const systems=systemTexts({engraving:withLongFirstShortAfter(defaultEngraving())});
  expect(systems.length).toBeGreaterThanOrEqual(3);
  expect(systems[0]).toEqual(expect.arrayContaining(['Guitar6','Grand Piano','Drums']));
  for(const later of systems.slice(1)){expect(later).toEqual(expect.arrayContaining(['Gtr.','Pno.','Dr.']));expect(later).not.toContain('Guitar6');}
});
it('single-track render follows the same rule',()=>{
  const systems=systemTexts({engraving:withLongFirstShortAfter(defaultEngraving()),rendered:[0]});
  expect(systems.length).toBeGreaterThanOrEqual(2);
  expect(systems[0]).toContain('Guitar6');
  for(const later of systems.slice(1)){expect(later).toContain('Gtr.');expect(later).not.toContain('Guitar6');}
});
it('an empty short name falls back to the first 10 characters of the name',()=>{
  const {score,ids}=threeTrackScore({names:['Rhythm guitar two','Grand Piano','Drums'],shortNames:['','Pno.','Dr.']});
  expect(systemTexts({engraving:withLongFirstShortAfter(defaultEngraving()),score,ids})[1]).toContain('Rhythm gui');
});
it('without the option, names keep the source policy',()=>{
  const systems=systemTexts({engraving:defaultEngraving()});
  // The source policy is first system only, in alphaTab's own mode (short names), so later systems carry no names at all.
  expect(systems[0]).toContain('Gtr.');
  expect(systems[1]).not.toContain('Gtr.');
});
