import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { BRACE_MAX_X_SCALE,configureAccolades,normalizedPadding,planAccolades } from './accolades';
import { defaultEngraving } from './projection';
import { withStaffGroups } from './staff-groups';
import { threeTrackScore } from './staff-fixtures';
import type { StaffGroup } from './types';

describe('accolade plan',()=>{
  const {score,ids}=threeTrackScore(),settings=new Settings();
  const unit=new Settings().display.resources.engravingSettings,braceW=unit.glyphWidths.get(model.MusicFontSymbol.Brace)!,bar=unit.bracketThickness;
  const plan=(groups:StaffGroup[],nativeMode=1,rendered=[0,1,2])=>planAccolades({engraving:withStaffGroups(defaultEngraving(),groups),trackIds:ids,rendered,score,nativeMode,settings});

  it('builds the shared fixture as systems of 2, 2, 4, 2 and 2 bars',()=>{
    expect(score.tracks.map(track=>track.name)).toEqual(['Guitar6','Grand Piano','Drums']);
    expect(score.tracks.map(track=>track.shortName)).toEqual(['Gtr.','Pno.','Dr.']);
    expect(score.tracks.map(track=>track.staves.length)).toEqual([1,2,1]);
    expect(score.masterBars.length).toBe(12);expect(score.systemsLayout).toEqual([2,2,4,2,2]);expect(ids).toEqual(['base/0','base/1','base/2']);
  });
  it('plans nothing without a drawn group',()=>{ expect(plan([])).toBeNull(); expect(plan([{trackIds:['base/0','base/1'],kind:'bracket'}],1,[1])).toBeNull(); });
  it('a bracket group over guitar and piano reserves an inner brace column and an outer bracket column',()=>{
    const p=plan([{trackIds:['base/0','base/1'],kind:'bracket'}])!;
    expect(p.groups).toEqual([{index:0,kind:'bracket',tracks:[0,1]}]);expect([...p.braceTracks]).toEqual([1]);
    expect(p.inner).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);expect(p.outer).toBeCloseTo(bar);expect(p.reserve).toBeCloseTo(3+p.inner+3+p.outer);
  });
  it('with Brackets None the inner column is empty and the reserve is still pad + inner + pad + outer',()=>{
    const p=plan([{trackIds:['base/1','base/2'],kind:'brace'}],0)!;
    expect(p.inner).toBe(0);expect(p.outer).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);expect(p.reserve).toBeCloseTo(3+0+3+p.outer);
  });
  it('a brace group over piano and drums drops the piano brace, so the two-staff guitar bracket sets the inner column',()=>{
    const p=plan([{trackIds:['base/1','base/2'],kind:'brace'}])!;
    expect(p.nativeMode).toBe(1);expect(p.inner).toBeCloseTo(bar);expect(p.outer).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);
  });
  it('a bracket group containing the piano keeps the piano brace in the inner column',()=>{
    const p=plan([{trackIds:['base/1','base/2'],kind:'bracket'}])!;
    expect(p.inner).toBeCloseTo(braceW*BRACE_MAX_X_SCALE);expect(p.outer).toBeCloseTo(bar);
  });
  it('an ungrouped one-staff track only adds an inner bracket with Single staff brackets on',()=>{
    const groups:StaffGroup[]=[{trackIds:['base/0','base/1'],kind:'brace'}],flag=score.stylesheet.showSingleStaffBrackets;
    try {
      score.stylesheet.showSingleStaffBrackets=false;const off=plan(groups)!;
      expect(off.singleStaffBrackets).toBe(false);expect(off.nativeMode).toBe(1);expect(off.inner).toBe(0);
      score.stylesheet.showSingleStaffBrackets=true;const on=plan(groups)!;
      expect(on.singleStaffBrackets).toBe(true);expect(on.inner).toBeCloseTo(bar);
    } finally {score.stylesheet.showSingleStaffBrackets=flag;}
  });
  it('configures absolute values, never accumulating across renders, and restores them without a plan',()=>{
    const p1=plan([{trackIds:['base/0','base/1'],kind:'bracket'}])!,p2=plan([{trackIds:['base/1','base/2'],kind:'brace'}])!;
    settings.display.scale=1.5;
    settings.display.padding=[35,35];configureAccolades(settings,score,p1,1);
    expect(score.stylesheet.bracketExtendMode).toBe(model.BracketExtendMode.NoBrackets);
    expect(settings.display.systemLabelPaddingRight).toBeCloseTo(3+p1.reserve);expect(settings.display.padding).toEqual([35+p1.reserve*1.5,35,35,35]);
    settings.display.padding=[0];configureAccolades(settings,score,p2,1);
    expect(settings.display.systemLabelPaddingRight).toBeCloseTo(3+p2.reserve);expect(settings.display.padding).toEqual([p2.reserve*1.5,0,0,0]);
    settings.display.padding=[0,0,0,0];configureAccolades(settings,score,null,1);
    expect(settings.display.systemLabelPaddingRight).toBe(3);expect(settings.display.padding).toEqual([0,0,0,0]);expect(score.stylesheet.bracketExtendMode).toBe(1);
    configureAccolades(settings,score,p1,1);configureAccolades(settings,score,null,2);expect(score.stylesheet.bracketExtendMode).toBe(2);
  });
  it('normalizes padding shapes',()=>{
    expect(normalizedPadding(null)).toEqual([0,0,0,0]);expect(normalizedPadding([7])).toEqual([7,7,7,7]);
    expect(normalizedPadding([5,9])).toEqual([5,9,5,9]);expect(normalizedPadding([1,2,3,4])).toEqual([1,2,3,4]);
    expect(normalizedPadding([1,2,3])).toEqual([1,2,3,2]);
  });
});
