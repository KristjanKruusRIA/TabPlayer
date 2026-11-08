import { expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings,SystemsLayoutMode,EngravingSettings } from '@coderline/alphatab';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { defaultPrintLayout } from '../document-settings';
import { configureEngraving,defaultEngraving,projectEngraving } from '../engraving/projection';
import { musicFontCss } from '../engraving/page';
import { paginateSystems,renderPdfPages } from './pdf';

const scoreWithQuarter=()=>{
  const score=buildScore(blankProject()),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],note=new model.Note();
  note.string=6;note.fret=0;beat.addNote(note);beat.isEmpty=false;
  return score;
};

// The regexes below depend on alphaTab's SVG output; an upgrade that changes it fails loudly here (null match or wrong count).
it('layout_uses_alphatab_music_font_size',()=>{
  const score=scoreWithQuarter(),ids=score.tracks.map(trackIdentity),engraving=defaultEngraving();
  const copy=projectEngraving(score,ids,engraving).score,settings=new Settings();
  settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;
  configureEngraving(settings,engraving);settings.display.layoutMode=LayoutMode.Page;settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;settings.display.padding=[0];
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=900;
  let svg='';renderer.partialRenderFinished.on(e=>{if(typeof e.renderResult==='string')svg+=e.renderResult;});
  try{renderer.renderScore(copy,[0]);}finally{renderer.destroy();}
  const head=/<g transform="translate\(([\d.]+) [\d.]+\)" class="at" ><text[^>]*>&#57508;<\/text>/.exec(svg);
  expect(head).not.toBeNull();
  const stems=[...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" fill="#000000"/g)].filter(m=>Number(m[3])>15);
  expect(stems).toHaveLength(1);
  const musicFontSize=settings.display.resources.engravingSettings.musicFontSize,anchor=EngravingSettings.bravuraMetadata.glyphsWithAnchors.noteheadBlack.stemUpSE![0];
  expect(musicFontSize).toBe(36);
  const stemRight=Number(stems[0][1])+Number(stems[0][2]);
  expect(Math.abs(stemRight-(Number(head![1])+anchor*musicFontSize/4*settings.display.scale))).toBeLessThan(0.2);
});

it('export_page_css_matches_layout_size',()=>{
  const score=scoreWithQuarter(),ids=score.tracks.map(trackIdentity),page={widthMm:297,heightMm:210,marginsMm:{top:10,right:10,bottom:10,left:10},scale:1,profile:'document' as const};
  const pages=renderPdfPages(score,{tracks:[0],range:null},defaultPrintLayout(),{page,engraving:defaultEngraving(),trackIds:ids});
  expect(pages.length).toBeGreaterThan(0);
  for(const p of pages)expect(p.svg).toContain('.at{font-family:Bravura;font-size:36px}');
});

it('musicFontCss joins families and sizes',()=>{expect(musicFontCss(40,['A','B'])).toBe('.at{font-family:A,B;font-size:40px}');});
it('legacy paginateSystems defaults the music size to 36px',()=>{
  const pages=paginateSystems([{width:500,height:100,svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}],'T',defaultPrintLayout());
  expect(pages[0].svg).toContain('.at{font-family:Bravura;font-size:36px}');
});
