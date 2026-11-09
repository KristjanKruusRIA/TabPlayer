// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings } from '@coderline/alphatab';
import { applyEffectBandSpacing,EFFECT_BAND_PADDING_BOTTOM } from './effect-bands';

/** THE-199: a tempo mark and a section name at the same bar start are stacked bands; the gap between them is display.effectBandPaddingBottom. */
function render(configure:(settings:Settings)=>void) {
  const score=new model.Score(),track=new model.Track();track.name='Guitar';
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=true;track.addStaff(staff);score.addTrack(track);
  const master=new model.MasterBar();score.addMasterBar(master);
  master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,108,2)];
  const section=new model.Section();section.marker='Window';section.text='Window';master.section=section;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=4;beat.isEmpty=false;
  const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  score.finish(new Settings());
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.display.layoutMode=LayoutMode.Page;
  configure(settings);
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=660;
  let svg='';renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string')svg+=e.renderResult;});
  renderer.renderScore(score,[0]);renderer.destroy();
  const y=(text:RegExp)=>{const m=svg.match(new RegExp(`<text[^>]* y="([0-9.]+)"[^>]*>${text.source}`));if(!m)throw new Error(`no ${text} in the render`);return Number(m[1]);};
  return {tempo:y(/ = 108/),marker:y(/\[Window\] Window/)};
}
describe('effect band spacing',()=>{
  it('clears the section name from the tempo mark by at least the shared padding more than alphaTab\'s default',()=>{
    const base=render(()=>{}),spaced=render(applyEffectBandSpacing);
    // The tempo band is first, so it does not move; the section band sits one padding below it.
    expect(spaced.tempo).toBeCloseTo(base.tempo);
    expect(EFFECT_BAND_PADDING_BOTTOM).toBeGreaterThan(new Settings().display.effectBandPaddingBottom);
    expect(spaced.marker-base.marker).toBeCloseTo(EFFECT_BAND_PADDING_BOTTOM-new Settings().display.effectBandPaddingBottom);
  });
  it('measures the gap between the tempo band bottom and the section name as the full padding',()=>{
    const flush=render(settings=>{settings.display.effectBandPaddingBottom=0;}),spaced=render(applyEffectBandSpacing);
    // With no padding the section name starts exactly at the tempo band bottom.
    expect(spaced.marker-flush.marker).toBeGreaterThanOrEqual(EFFECT_BAND_PADDING_BOTTOM-1e-6);
  });
});
