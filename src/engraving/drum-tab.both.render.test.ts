// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings } from '@coderline/alphatab';
import { defaultEngraving,projectEngraving } from './projection';
import { guardedAll } from './drum-tab-guard';

/**
 * A drum track drawn as standard notation and tablature has two staves, and alphaTab hands the bands that sit above and below a staff (dynamics,
 * fermatas, volta brackets, directions, triplet feel) to a staff that has no score renderer of its own. The tab staff must not repeat what the
 * percussion staff already shows. The marks are counted as SMuFL glyphs in the SVG.
 */
const MARKS={dynamicForte:0xE522,fermata:0xE4C0,tremolo3:0xE222,segno:0xE047};
function drumScore() {
  const score=new model.Score(),track=new model.Track();track.name='Drums';track.shortName='Dr';
  const staff=new model.Staff();staff.isPercussion=true;track.addStaff(staff);score.addTrack(track);
  for(let i=0;i<3;i++)score.addMasterBar(new model.MasterBar());
  score.masterBars[1].alternateEndings=1;score.masterBars[2].tripletFeel=model.TripletFeel.Triplet8th;
  score.masterBars[2].addDirection(model.Direction.TargetSegno);
  for(let b=0;b<3;b++){
    const bar=new model.Bar(),voice=new model.Voice();
    for(const ids of [[36,42],[38,42],[36,42,49],[91,53]]){const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;for(const id of ids){const note=new model.Note();note.percussionArticulation=id;beat.addNote(note);}voice.addBeat(beat);}
    const fermata=new model.Fermata();fermata.type=model.FermataType.Medium;fermata.length=1;voice.beats[3].fermata=fermata;
    voice.beats[1].tremoloSpeed=model.Duration.ThirtySecond;voice.beats[2].fade=model.FadeType.FadeIn;
    voice.beats[0].dynamics=model.DynamicValue.F;
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());return score;
}
function marks(score:model.Score):Record<keyof typeof MARKS|'volta',number> {
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.display.layoutMode=LayoutMode.Page;
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=900;let svg='';
  renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string')svg+=e.renderResult;});
  renderer.renderScore(score,[0]);renderer.destroy();
  const count=(code:number)=>(svg.match(new RegExp(`&#${code};`,'g'))??[]).length;
  return {dynamicForte:count(MARKS.dynamicForte),fermata:count(MARKS.fermata),tremolo3:count(MARKS.tremolo3),segno:count(MARKS.segno),volta:(svg.match(/>1\. </g)??[]).length};
}
describe('a drum track shown as standard notation and tablature',()=>{
  it('finds the alphaTab bands where the guard wraps them',()=>{expect(guardedAll).toBe(true);});
  it('draws each dynamic, fermata, tremolo, volta, direction and fade once, not again on the tab staff',()=>{
    const source=drumScore(),ids=['base/0'];
    const alone=marks(projectEngraving(source,ids,defaultEngraving()).score);
    expect(alone.dynamicForte).toBeGreaterThan(0);expect(alone.fermata).toBeGreaterThan(0);expect(alone.tremolo3).toBeGreaterThan(0);expect(alone.volta).toBeGreaterThan(0);
    const both=marks(projectEngraving(source,ids,{...defaultEngraving(),profiles:[{trackId:ids[0],profile:'standardTab'}]}).score);
    expect(both).toEqual(alone);
    // Drawn as tablature only, the one tab staff keeps all of them.
    const tab=marks(projectEngraving(source,ids,{...defaultEngraving(),profiles:[{trackId:ids[0],profile:'tablature'}]}).score);
    expect(tab.dynamicForte).toBe(alone.dynamicForte);expect(tab.fermata).toBe(alone.fermata);expect(tab.volta).toBe(alone.volta);
  });
});
