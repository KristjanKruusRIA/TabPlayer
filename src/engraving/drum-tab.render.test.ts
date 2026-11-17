// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { convertDrumTabJson,hideDrumTabTuning,type DrumTabMode } from './drum-tab';

/**
 * THE-220: a drum track drawn as tablature. A small authored kit pattern goes through the converter on the JSON a projection would clone,
 * and alphaTab's own renderer draws the result. Everything is read back from the SVG and from alphaTab's bounds.
 */
const pattern=[[36,42],[38,42],[36,42,49],[91,53]];
function drumScore() {
  const score=new model.Score(),track=new model.Track();track.name='Drums';track.shortName='Dr';
  const staff=new model.Staff();staff.isPercussion=true;track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());
  const bar=new model.Bar(),voice=new model.Voice();
  for(const ids of pattern){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;for(const id of ids){const note=new model.Note();note.percussionArticulation=id;beat.addNote(note);}voice.addBeat(beat);}
  bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());return score;
}
function render(score:model.Score) {
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.display.layoutMode=LayoutMode.Page;settings.core.includeNoteBounds=true;
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=660;let svg='';
  renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string')svg+=e.renderResult;});
  renderer.renderScore(score,[0]);const bounds=renderer.boundsLookup!;renderer.destroy();
  const texts=[...svg.matchAll(/<text[^>]*? y="([0-9.]+)"[^>]*>([^<]*)</g)].map(m=>({y:Number(m[1]),text:m[2]}));
  // Staff lines are the thin rectangles that start at the system's left edge.
  const thin=[...svg.matchAll(/<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/g)].map(m=>({x:Number(m[1]),y:Number(m[2]),height:Number(m[4])})).filter(r=>r.height<2);
  const left=Math.min(...thin.map(r=>r.x)),lineYs=[...new Set(thin.filter(r=>r.x===left).map(r=>r.y))].sort((a,b)=>a-b);
  return {svg,bounds,texts,lineYs};
}
function converted(mode:DrumTabMode) {
  const source=drumScore(),before=model.JsonConverter.scoreToJson(source),json=JSON.parse(before) as Record<string,unknown>;
  const report=convertDrumTabJson(json,source,new Map([[0,mode]]));
  const copy=scoreFromJson(JSON.stringify(json) as never,new Settings());hideDrumTabTuning(copy,report.hiddenTuningTracks);
  const result=render(copy);
  expect(model.JsonConverter.scoreToJson(source)).toBe(before);
  return {...result,report,copy};
}
const digits=(texts:{text:string}[])=>texts.map(t=>t.text).filter(text=>/^\d+$/.test(text));

describe('drum tab rendering',()=>{
  it('tab mode draws one six-line staff with the written numbers on their lines',()=>{
    const {texts,lineYs,copy}=converted('tab');
    expect(copy.tracks[0].staves).toHaveLength(1);
    expect(lineYs).toHaveLength(6);
    const numbers=texts.filter(t=>/^\d+$/.test(t.text));
    expect(numbers.map(t=>t.text).sort()).toEqual(['36','36','38','42','42','42','49','53','91']);
    // The number sits on its line: kick lowest (line 6), snare family on 5, hi-hat on 3, ride bell on 2, crash on 1.
    const lineOf=(text:string)=>{const found=numbers.filter(t=>t.text===text);return found.map(t=>lineYs.findIndex(y=>Math.abs(t.y-(y+0.585))<2)+1);};
    const rowOf=(text:string)=>new Set(numbers.filter(t=>t.text===text).map(t=>t.y));
    expect(rowOf('36').size).toBe(1);expect(rowOf('42').size).toBe(1);
    expect(lineOf('36')).toEqual([6,6]);expect(lineOf('38')).toEqual([5]);expect(lineOf('91')).toEqual([5]);expect(lineOf('42')).toEqual([3,3,3]);expect(lineOf('53')).toEqual([2]);expect(lineOf('49')).toEqual([1]);
    // No "= C" tuning label above the tab.
    expect(texts.some(t=>/=/.test(t.text))).toBe(false);
  });
  it('both mode draws the percussion staff and the tab together',()=>{
    const {texts,lineYs,copy,bounds}=converted('both');
    expect(copy.tracks[0].staves.map(staff=>[staff.isPercussion,staff.showTablature,staff.tuning.length])).toEqual([[true,false,0],[false,true,6]]);
    // Five lines of the percussion staff and six of the tab.
    expect(lineYs).toHaveLength(11);
    expect(digits(texts).sort()).toEqual(['36','36','38','42','42','42','49','53','91']);
    const bars=bounds.staffSystems[0].bars[0].bars;
    expect(bars).toHaveLength(2);
    expect(bars.map(bar=>bar.bar.staff.isPercussion)).toEqual([true,false]);
  });
  it('gives every tab note bounds, so the rendered notes can be mapped back to their source notes',()=>{
    for(const mode of ['tab','both'] as const){
      const {bounds,report}=converted(mode);
      const tabBar=bounds.staffSystems[0].bars[0].bars.find(bar=>!bar.bar.staff.isPercussion)!;
      const boxes=tabBar.beats.flatMap(beat=>beat.notes??[]);
      expect(boxes).toHaveLength(9);
      for(const box of boxes){expect(box.noteHeadBounds.w).toBeGreaterThan(0);expect(report.notes.has(box.note.id)).toBe(true);}
      // Each box's source note is a note of the original kit pattern with the number it shows.
      expect(boxes.map(box=>box.note.fret).sort((a,b)=>a-b)).toEqual(pattern.flat().sort((a,b)=>a-b));
    }
  });
});
