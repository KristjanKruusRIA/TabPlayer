// @vitest-environment jsdom
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { LayoutMode,model,rendering,Settings } from '@coderline/alphatab';
import { defaultEngraving,projectEngraving } from './projection';
import { withStaffGaps,withStaffGroups } from './staff-groups';
import { threeTrackScore } from './staff-fixtures';
import { exportPages,exportWithBounds,installTextMeasure,markBoxes,nameBoxes,systemBoxes,systemTexts,trackNames } from './staff-render-helpers';
import type { EngravingOverrides,TrackProfile } from './types';

/**
 * THE-220: a drum track drawn as tab is laid out with everything else the print path and the screen share: several tracks, staff groups and gaps, track names, bar numbers.
 * The shared three-track fixture is guitar, piano and drums ("base/2"), twelve bars; real alphaTab layout, jsdom text measure.
 */
beforeEach(installTextMeasure);
afterEach(()=>vi.restoreAllMocks());

const drums=(profile:TrackProfile|null,base:EngravingOverrides=defaultEngraving()):EngravingOverrides=>({...base,profiles:profile?[{trackId:'base/2',profile}]:[]});
const numbers=(texts:string[][])=>texts.map(system=>system.filter(text=>/^\d+$/.test(text)).map(Number));

describe('a drum track shown as tab among other tracks, on the print path',()=>{
  it('writes the kick and snare numbers in every system, and keeps the bar numbers and track names it had',()=>{
    const plain=systemTexts({engraving:drums(null)}),both=systemTexts({engraving:drums('standardTab')}),only=systemTexts({engraving:drums('tablature')});
    expect(both).toHaveLength(plain.length);
    for(const [index,system] of numbers(both).entries()){
      expect(system.filter(value=>value===36).length,`system ${index}`).toBeGreaterThan(0);expect(system.filter(value=>value===38).length).toBeGreaterThan(0);
      expect(numbers(only)[index].filter(value=>value===36).length).toBe(system.filter(value=>value===36).length);
      // Everything below 30 (bar numbers and the guitar's frets) is what it was.
      expect(system.filter(value=>value<30)).toEqual(numbers(plain)[index].filter(value=>value<30));
    }
    expect(numbers(plain).flat().filter(value=>value>=30)).toEqual([]);
    const score=threeTrackScore().score,names=trackNames(score);
    const nameCount=(profile:TrackProfile|null)=>nameBoxes(exportPages({engraving:drums(profile)}).map(page=>page.svg).join(''),names).map(box=>box.text).sort();
    expect(nameCount('standardTab')).toEqual(nameCount(null));expect(nameCount('tablature')).toEqual(nameCount(null));
  });
  it('lays the systems out with the same bars in each, and gives the drum track the room of its second staff',()=>{
    const plain=exportWithBounds({engraving:drums(null)}),both=exportWithBounds({engraving:drums('standardTab')}),only=exportWithBounds({engraving:drums('tablature')});
    expect(both.systemTops.length).toBe(plain.systemTops.length);expect(only.systemTops.length).toBe(plain.systemTops.length);
    // The percussion staff stays; the tab under it makes every system taller, and the tab alone makes the drum staff six lines instead of five.
    both.systemHeights.forEach((height,index)=>expect(height).toBeGreaterThan(plain.systemHeights[index]));
    expect(systemBoxes(both.svg).length).toBe(systemBoxes(plain.svg).length);
  });
  it('draws a bracket group over the guitar, piano and drums down to the drum tab, and a staff gap under the drums moves nothing else',()=>{
    const grouped=(profile:TrackProfile|null)=>withStaffGroups(drums(profile),[{trackIds:['base/0','base/1','base/2'],kind:'bracket'}]);
    const plain=exportWithBounds({engraving:grouped(null)}),both=exportWithBounds({engraving:grouped('standardTab')});
    const bracket=(svg:string)=>markBoxes(svg).filter(mark=>mark.role==='group');
    expect(bracket(both.svg)).toHaveLength(systemBoxes(both.svg).length);
    bracket(both.svg).forEach((mark,index)=>{expect(mark.bottom-mark.top).toBeGreaterThan(bracket(plain.svg)[index].bottom-bracket(plain.svg)[index].top);});
    // Per-track brackets are drawn once per track, so the drum track's own two staves get theirs too (as the guitar's standard staff and tab do).
    const withGap=exportWithBounds({engraving:withStaffGaps(grouped('standardTab'),[{trackId:'base/1',scale:2}])});
    expect(withGap.systemTops.length).toBe(both.systemTops.length);
    expect(bracket(withGap.svg)).toHaveLength(bracket(both.svg).length);
  });
});

describe('a drum track shown as tab in the continuous and the page layouts alphaTab draws',()=>{
  function drawn(profile:TrackProfile,layout:LayoutMode) {
    const {score,ids}=threeTrackScore(),projection=projectEngraving(score,ids,drums(profile));
    const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.core.includeNoteBounds=true;settings.display.layoutMode=layout;
    const renderer=new rendering.ScoreRenderer(settings);renderer.width=900;let failure:Error|undefined;renderer.error.on(error=>{failure=error;});
    renderer.renderScore(projection.score,[0,1,2]);const bounds=renderer.boundsLookup!;renderer.destroy();
    return {projection,bounds,failure,score};
  }
  for(const [name,layout] of [['page',LayoutMode.Page],['horizontal',LayoutMode.Horizontal]] as const) {
    for(const profile of ['tablature','standardTab'] as const) {
      it(`${name}, ${profile}: every drum beat of every bar has bounds on the tab, and every written note has a box that leads to its source note`,()=>{
        const {projection,bounds,failure,score}=drawn(profile,layout);
        expect(failure).toBeUndefined();
        // (alphaTab's horizontal layout lists each bar's bounds twice; the bars themselves are the twelve of the tab staff.)
        const tabBars=bounds.staffSystems.flatMap(system=>system.bars.flatMap(master=>master.bars)).filter(box=>box.bar.staff.track.index===2&&!box.bar.staff.isPercussion);
        expect(new Set(tabBars.map(box=>box.bar)).size).toBe(12);
        const drawnNotes=new Set<model.Note>();
        for(const box of tabBars)for(const beat of box.beats){expect(beat.realBounds.w).toBeGreaterThan(0);for(const noteBox of beat.notes??[]){expect(noteBox.noteHeadBounds.w).toBeGreaterThan(0);drawnNotes.add(noteBox.note);}}
        // 12 bars, a kick on beat 1 and a snare on beat 3 in each.
        expect(drawnNotes.size).toBe(24);
        for(const note of drawnNotes){const source=projection.renderedNotes!.get(note)!;expect(source.percussionArticulation).toBe(note.fret);expect(source.beat.voice.bar.staff.track.score).toBe(score);}
      });
    }
  }
});
