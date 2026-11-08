// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { LayoutMode,rendering,Settings } from '@coderline/alphatab';
import { configureEngraving,defaultEngraving,projectEngraving } from './projection';
import { threeTrackScore } from './staff-fixtures';
import { paginateScreenScore,type ScreenRenderChunk } from './screen-pages';

const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const};

/** Bars 6 to 11 are empty and multi-bar rests are on, so alphaTab closes the third system with one rest. */
function render() {
  const {score:source,ids}=threeTrackScore();
  for(const track of source.tracks)for(const staff of track.staves)for(const bar of staff.bars.slice(6))for(const voice of bar.voices)for(const beat of voice.beats)beat.notes.length=0;
  const engraving=defaultEngraving();engraving.stylesheet.multiRests='on';
  const score=projectEngraving(source,ids,engraving).score;
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.display.layoutMode=LayoutMode.Page;configureEngraving(settings,engraving);
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=660;
  const chunks:ScreenRenderChunk[]=[];
  renderer.partialRenderFinished.on(e=>{chunks.push({id:e.id,x:e.x,y:e.y,width:e.width,height:e.height,firstMasterBarIndex:e.firstMasterBarIndex,lastMasterBarIndex:e.lastMasterBarIndex,svg:e.renderResult as string});});
  renderer.renderScore(score,[0,1,2]);
  const bounds=renderer.boundsLookup!;
  return {renderer,chunks,bounds};
}

it('paginates a system that ends in a multi-bar rest, whose chunk runs past the last bar its bounds record',()=>{
  const {renderer,chunks,bounds}=render();
  try {
    const rest=chunks.find(chunk=>chunk.firstMasterBarIndex===4)!,system=bounds.staffSystems.find(candidate=>candidate.bars[0].index===4)!;
    expect(rest.lastMasterBarIndex).toBeGreaterThan(system.bars.at(-1)!.index); // the premise: the rest makes the chunk end later than its bounds
    const pagination=paginateScreenScore(chunks,bounds,page);
    expect(pagination.blocks.map(block=>block.system?.bars[0].index??null)).toEqual([null,0,2,4,null]);
    expect(pagination.blocks.find(block=>block.chunk===rest)!.system).toBe(system);
  } finally {renderer.destroy();}
});

it('still refuses a chunk whose first bar starts no system',()=>{
  const {renderer,chunks,bounds}=render();
  try {
    const moved=chunks.map(chunk=>chunk.firstMasterBarIndex===2?{...chunk,firstMasterBarIndex:3,lastMasterBarIndex:3}:chunk);
    expect(()=>paginateScreenScore(moved,bounds,page)).toThrow(/chunk association/);
  } finally {renderer.destroy();}
});
