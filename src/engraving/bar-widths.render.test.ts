import { expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings,SystemsLayoutMode } from '@coderline/alphatab';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { renderPdfPages } from '../export/pdf';
import { defaultPrintLayout } from '../document-settings';
import { withBarWidths } from './bar-widths';
import { configureEngraving,defaultEngraving,projectEngraving } from './projection';
import type { EngravingOverrides } from './types';

const widths=(...entries:Array<[number,number]>):EngravingOverrides=>withBarWidths(defaultEngraving(),entries.map(([bar,scale])=>({bar,scale})));

it('widens the bar the renderer draws and honours the widths in PDF output',()=>{
  const score=buildScore(blankProject());score.defaultSystemsLayout=4;score.systemsLayout=[4];
  const ids=score.tracks.map(trackIdentity),measure=(engraving:EngravingOverrides)=>{
    const copy=projectEngraving(score,ids,engraving).score,settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;
    configureEngraving(settings,engraving);settings.display.layoutMode=LayoutMode.Page;settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;settings.display.padding=[0];
    const renderer=new rendering.ScoreRenderer(settings);renderer.width=900;
    try{renderer.renderScore(copy,[0]);const bars=renderer.boundsLookup!.staffSystems[0].bars;return bars.map(bar=>bar.realBounds.w);}finally{renderer.destroy();}
  };
  const plain=measure(defaultEngraving()),wide=measure(widths([1,3]));
  expect(plain.length).toBeGreaterThanOrEqual(3);expect(wide[1]/wide[2]).toBeGreaterThan(plain[1]/plain[2]*1.5);expect(wide[1]).toBeGreaterThan(plain[1]);
  const before=model.JsonConverter.scoreToJson(score),page={widthMm:297,heightMm:210,marginsMm:{top:10,right:10,bottom:10,left:10},scale:1,profile:'document' as const};
  const layout=defaultPrintLayout(),render=(engraving:EngravingOverrides)=>renderPdfPages(score,{tracks:[0],range:null},layout,{page,engraving,trackIds:ids}).map(p=>p.svg).join('');
  expect(render(widths([1,3]))).not.toBe(render(defaultEngraving()));expect(render(widths([1,3]))).toBe(render(widths([1,3])));expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
