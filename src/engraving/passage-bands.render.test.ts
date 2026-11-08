// @vitest-environment jsdom
import { afterAll,describe,expect,it } from 'vitest';
import { LayoutMode,model,rendering,Settings } from '@coderline/alphatab';
import { passageBands } from './passage-bands';

/** The bands that shade a selection or a loop, with real alphaTab bounds: one band per system a passage touches, from its first edge to its last. */
function build(bars:number) {
  const score=new model.Score();
  const track=new model.Track();track.name='Guitar';
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=true;
  track.addStaff(staff);score.addTrack(track);
  for(let i=0;i<bars;i++){
    const master=new model.MasterBar();score.addMasterBar(master);
    if(i===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
    const bar=new model.Bar(),voice=new model.Voice();
    for(let b=0;b<4;b++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=6;note.fret=3;beat.addNote(note);voice.addBeat(beat);}
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());
  const settings=new Settings();settings.core.engine='svg';settings.core.useWorkers=false;settings.core.enableLazyLoading=false;settings.core.includeNoteBounds=true;settings.display.layoutMode=LayoutMode.Page;
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=660;
  renderer.renderScore(score,[0]);
  return {score,renderer,lookup:renderer.boundsLookup!};
}
const world=build(12);
afterAll(()=>world.renderer.destroy());
const whole=(...bars:number[])=>bars.map(bar=>({bar}));
const beatOf=(bar:number,index:number)=>world.score.tracks[0].staves[0].bars[bar].voices[0].beats[index];

describe('passageBands',()=>{
  it('premise: the score wraps, so some bar pair falls on two systems',()=>{
    expect(world.lookup.staffSystems.length).toBeGreaterThan(1);
    expect(world.lookup.staffSystems[0].bars.length).toBeLessThan(12);
  });
  it('is one band over whole bars on one system, as wide as those bars',()=>{
    const bars=world.lookup.staffSystems[0].bars,first=bars[0],last=bars[1];
    const [band,...rest]=passageBands(world.lookup,whole(first.index,last.index));
    expect(rest).toEqual([]);
    expect(band.system).toBe(world.lookup.staffSystems[0]);
    expect(band.x).toBeCloseTo(first.realBounds.x);
    expect(band.x+band.w).toBeCloseTo(last.realBounds.x+last.realBounds.w);
    expect(band.y).toBeCloseTo(first.visualBounds.y);expect(band.h).toBeCloseTo(first.visualBounds.h);
    expect([band.firstBar,band.lastBar]).toEqual([first.index,last.index]);
  });
  it('draws one band per system when a passage crosses a line break',()=>{
    const first=world.lookup.staffSystems[0],second=world.lookup.staffSystems[1];
    const from=first.bars.at(-1)!.index,to=second.bars[0].index;
    expect(to).toBe(from+1);
    const bands=passageBands(world.lookup,whole(from,to));
    expect(bands.map(band=>band.system)).toEqual([first,second]);
    expect(bands[0].x+bands[0].w).toBeCloseTo(first.bars.at(-1)!.realBounds.x+first.bars.at(-1)!.realBounds.w);
    expect(bands[1].x).toBeCloseTo(second.bars[0].realBounds.x);
    expect(bands[0].y).toBeLessThan(bands[1].y);
  });
  it('spans every system with the whole middle ones, and keeps a loop that skips bars as separate runs',()=>{
    const systems=world.lookup.staffSystems;
    const all=passageBands(world.lookup,whole(...Array.from({length:12},(_,bar)=>bar)));
    expect(all.length).toBe(systems.length);
    const gap=passageBands(world.lookup,whole(0,1,5));
    expect(gap.length).toBeGreaterThanOrEqual(2);
    expect(gap[0].lastBar).toBe(1);expect(gap.at(-1)!.firstBar).toBe(5);
    expect(gap.some(band=>band.firstBar<=3&&band.lastBar>=3)).toBe(false);
  });
  it('starts at a beat inside the first bar and ends at a beat inside the last one',()=>{
    const bar=world.lookup.staffSystems[0].bars[0].index,next=bar+1;
    const start=beatOf(bar,2),end=beatOf(next,1);
    const [band]=passageBands(world.lookup,[{bar,from:start},{bar:next,to:end}]);
    const startBounds=world.lookup.findBeat(start)!,endBounds=world.lookup.findBeat(end)!;
    expect(band.x).toBeCloseTo(startBounds.realBounds.x);
    expect(band.x+band.w).toBeCloseTo(endBounds.realBounds.x+endBounds.realBounds.w);
    const full=passageBands(world.lookup,whole(bar,next))[0];
    expect(band.x).toBeGreaterThan(full.x);expect(band.x+band.w).toBeLessThan(full.x+full.w);
  });
  it('lets a beat that opens or closes its bar take the bar edge, as the renderer shades a selection',()=>{
    const bar=world.lookup.staffSystems[0].bars[0],first=beatOf(bar.index,0),last=beatOf(bar.index,3);
    const [band]=passageBands(world.lookup,[{bar:bar.index,from:first,to:last}]);
    expect(band.x).toBeCloseTo(bar.realBounds.x);expect(band.x+band.w).toBeCloseTo(bar.realBounds.x+bar.realBounds.w);
  });
  it('trims the system a passage leaves, and the one it enters, at the edge beats',()=>{
    const first=world.lookup.staffSystems[0],second=world.lookup.staffSystems[1];
    const from=first.bars.at(-1)!.index,to=second.bars[0].index;
    const bands=passageBands(world.lookup,[{bar:from,from:beatOf(from,2)},{bar:to,to:beatOf(to,1)}]);
    expect(bands.length).toBe(2);
    expect(bands[0].x).toBeCloseTo(world.lookup.findBeat(beatOf(from,2))!.realBounds.x);
    const end=world.lookup.findBeat(beatOf(to,1))!.realBounds;
    expect(bands[1].x+bands[1].w).toBeCloseTo(end.x+end.w);
  });
  it('gives nothing for bars the renderer did not place, and ignores them among placed ones',()=>{
    expect(passageBands(world.lookup,whole(99))).toEqual([]);
    expect(passageBands(world.lookup,[])).toEqual([]);
    expect(passageBands(world.lookup,whole(0,99)).map(band=>[band.firstBar,band.lastBar])).toEqual([[0,0]]);
  });
  it('takes the same bar listed twice once, and bars in any order',()=>{
    expect(passageBands(world.lookup,whole(1,0,1)).map(band=>[band.firstBar,band.lastBar])).toEqual([[0,1]]);
  });
  it('names the bounds object the renderer made, so a page layout can map the band',()=>{
    for(const band of passageBands(world.lookup,whole(0,4,8)))expect(world.lookup.staffSystems).toContain(band.system);
  });
});

describe('passageBands: edges inside joined bars',()=>{
  const first=()=>world.lookup.staffSystems[0].bars[0].index;
  it('starts a new band where a bar ends at an inner beat and the next bar follows on the same system',()=>{
    const a=first(),b=a+1;
    const bands=passageBands(world.lookup,[{bar:a,to:beatOf(a,1)},{bar:b}]);
    expect(bands.map(band=>[band.firstBar,band.lastBar])).toEqual([[a,a],[b,b]]);
    const end=world.lookup.findBeat(beatOf(a,1))!.realBounds;
    expect(bands[0].x+bands[0].w).toBeCloseTo(end.x+end.w);
    expect(bands[1].x).toBeCloseTo(world.lookup.findMasterBarByIndex(b)!.realBounds.x);
  });
  it('starts a new band where a bar begins at an inner beat after a neighbour on the same system',()=>{
    const a=first(),b=a+1;
    const bands=passageBands(world.lookup,[{bar:a},{bar:b,from:beatOf(b,2)}]);
    expect(bands.map(band=>[band.firstBar,band.lastBar])).toEqual([[a,a],[b,b]]);
    expect(bands[1].x).toBeCloseTo(world.lookup.findBeat(beatOf(b,2))!.realBounds.x);
  });
  it('still joins bars whose edges are the bars own, even when edge beats are named at the bar edge',()=>{
    const a=first(),b=a+1;
    expect(passageBands(world.lookup,[{bar:a,from:beatOf(a,0)},{bar:b,to:beatOf(b,3)}]).map(band=>[band.firstBar,band.lastBar])).toEqual([[a,b]]);
  });
});

describe('passageBands: which sides continue',()=>{
  it('marks the side where the passage goes on to the next or came from the previous line',()=>{
    const [one,two]=world.lookup.staffSystems,from=one.bars.at(-1)!.index,to=two.bars[0].index;
    const [left,right]=passageBands(world.lookup,whole(from,to));
    expect([left.continuesBefore,left.continuesAfter]).toEqual([false,true]);
    expect([right.continuesBefore,right.continuesAfter]).toEqual([true,false]);
  });
  it('marks both sides of a middle system, and neither side of a passage inside one system',()=>{
    const systems=world.lookup.staffSystems;
    const bands=passageBands(world.lookup,whole(...Array.from({length:12},(_,bar)=>bar)));
    expect(bands.map(band=>[band.continuesBefore,band.continuesAfter])).toEqual(bands.map((_,index)=>[index>0,index<bands.length-1]));
    expect(bands.length).toBe(systems.length);
    const inside=passageBands(world.lookup,whole(systems[0].bars[0].index,systems[0].bars[1].index))[0];
    expect([inside.continuesBefore,inside.continuesAfter]).toEqual([false,false]);
  });
  it('does not mark a side that a skipped bar or an edge beat ends',()=>{
    const [one,two]=world.lookup.staffSystems,from=one.bars.at(-1)!.index,to=two.bars[0].index;
    const gap=passageBands(world.lookup,whole(from,to+1));
    expect(gap.map(band=>[band.continuesBefore,band.continuesAfter])).toEqual([[false,false],[false,false]]);
    const trimmed=passageBands(world.lookup,[{bar:from,from:beatOf(from,1)},{bar:to,to:beatOf(to,1)}]);
    expect([trimmed[0].continuesAfter,trimmed[1].continuesBefore]).toEqual([true,true]);
  });
});
