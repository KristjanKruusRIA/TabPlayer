import {beforeAll,describe,expect,it} from 'vitest';
import {LayoutMode,Settings,SystemsLayoutMode,model,rendering} from '@coderline/alphatab';
import type {PageLayout} from './types';
import {arrangeScreenPages,hitTestScreenPages,mapScreenRect,paginateScreenScore,resolveScreenZoom,SCREEN_PAGE_GAP,unmapScreenPoint} from './screen-pages';
import type {ScreenPagination,ScreenRect,ScreenRenderChunk} from './screen-pages';

const page:PageLayout={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1.13,profile:'document'};
const px=96/25.4;
const oversize='This score does not fit the selected paper. Display fewer staves, choose a larger page, or reduce print scale.';
const center=(r:ScreenRect)=>({x:r.x+r.w/2,y:r.y+r.h/2});
const json=(value:unknown)=>JSON.stringify(value,(_key,v)=>v instanceof Map?Object.fromEntries(v):v);

// Source references are paired by authored position, before looking at renderer bounds.
function scoreFixture(coincident=false,rests=false,blank=false) {
  const settings=new Settings();
  settings.core.engine='svg';settings.core.enableLazyLoading=false;settings.core.includeNoteBounds=true;
  settings.display.layoutMode=LayoutMode.Parchment;settings.display.systemsLayoutMode=SystemsLayoutMode.UseModelLayout;
  settings.display.scale=1.13;settings.display.padding=[0,0,0,0];
  const source=new model.Score();source.title='Screen layout geometry';
  source.systemsLayout=[2,3,1,2,2,2,2,2,2,2,2,2];
  for(let i=0;i<24;i++)source.addMasterBar(new model.MasterBar());
  source.masterBars[2].isRepeatStart=true;source.masterBars[7].repeatCount=2;
  for(let ti=0;ti<2;ti++) {
    const track=new model.Track();track.name=ti===0?'Upper':'Lower';source.addTrack(track);
    for(let si=0;si<(ti===0?2:1);si++) {
      const staff=new model.Staff();staff.showStandardNotation=true;staff.showTablature=false;track.addStaff(staff);
      for(let bi=0;bi<24;bi++) {
        const bar=new model.Bar();staff.addBar(bar);
        for(let vi=0;vi<2;vi++) {
          const voice=new model.Voice();bar.addVoice(voice);
          for(let qi=0;qi<4;qi++) {
            const beat=new model.Beat();beat.duration=model.Duration.Quarter;voice.addBeat(beat);
            if(rests&&bi===0&&qi===1){beat.isEmpty=blank;continue;}
            const note=new model.Note();note.octave=5;note.tone=coincident?4:vi===0?0:7;beat.addNote(note);
          }
        }
      }
    }
  }
  source.finish(settings);
  const sourceJson=model.JsonConverter.scoreToJson(source),rendered=model.JsonConverter.jsonToScore(sourceJson,settings);
  const sourceNotes=new Map<model.Note,model.Note>(),sourceBeats=new Map<model.Beat,model.Beat>();
  for(const track of rendered.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats) {
    const original=source.tracks[track.index].staves[staff.index].bars[bar.index].voices[voice.index].beats[beat.index];
    sourceBeats.set(beat,original);for(const note of beat.notes)sourceNotes.set(note,original.notes[note.index]);
  }
  const renderer=new rendering.ScoreRenderer(settings);renderer.width=180*px;
  const chunks:ScreenRenderChunk[]=[];
  renderer.partialRenderFinished.on(e=>{
    if(typeof e.renderResult!=='string')throw new Error('Fixture must produce eager SVG strings');
    chunks.push(Object.freeze({id:e.id,x:e.x,y:e.y,width:e.width,height:e.height,firstMasterBarIndex:e.firstMasterBarIndex,lastMasterBarIndex:e.lastMasterBarIndex,svg:e.renderResult}));
  });
  renderer.error.on(error=>{throw error;});renderer.renderScore(rendered,[0,1]);
  const bounds=renderer.boundsLookup;if(!bounds?.isFinished)throw new Error('Fixture did not finish');
  renderer.destroy();
  return {source,rendered,sourceJson,renderedJson:model.JsonConverter.scoreToJson(rendered),sourceNotes,sourceBeats,chunks:Object.freeze(chunks),bounds};
}
type Fixture=ReturnType<typeof scoreFixture>;
let fixture:Fixture,pagination:ScreenPagination;
beforeAll(()=>{fixture=scoreFixture();pagination=paginateScreenScore(fixture.chunks,fixture.bounds,page);});

describe('whole renderer blocks',()=>{
  it('accounts once for every real system and leading/trailing SVG, preserving music and source geometry',()=>{
    const original=json(fixture.bounds.toJson()),chunks=json(fixture.chunks);
    const result=paginateScreenScore(fixture.chunks,fixture.bounds,page);
    expect(fixture.bounds.staffSystems).toHaveLength(12);expect(fixture.chunks).toHaveLength(14);
    expect(fixture.bounds.staffSystems.map(s=>s.bars.length)).toEqual([2,3,1,2,2,2,2,2,2,2,2,2]);
    expect(result.pageCount).toBeGreaterThanOrEqual(3);expect(result.blocks).toHaveLength(14);
    expect(result.blocks.map(b=>b.chunk)).toEqual(fixture.chunks);
    expect(result.blocks.filter(b=>b.system).map(b=>b.system)).toEqual(fixture.bounds.staffSystems);
    expect(result.blocks[0].system).toBeNull();expect(result.blocks.at(-1)!.system).toBeNull();
    expect(fixture.source.systemsLayout).toEqual([2,3,1,2,2,2,2,2,2,2,2,2]);
    expect(fixture.source.masterBars[2].isRepeatStart).toBe(true);expect(fixture.source.masterBars[7].repeatCount).toBe(2);
    let expectedPage=0,used=0;
    for(const block of result.blocks) {
      const c=block.chunk,rects=[{x:c.x,y:c.y,w:c.width,h:c.height},...(block.system?[block.system.realBounds,block.system.visualBounds]:[])];
      const left=Math.min(...rects.map(r=>r.x)),top=Math.min(...rects.map(r=>r.y));
      const right=Math.max(...rects.map(r=>r.x+r.w)),bottom=Math.max(...rects.map(r=>r.y+r.h));
      expect(block.sourceBounds).toEqual({x:left,y:top,w:right-left,h:bottom-top});
      if(used+bottom-top>267*px){expectedPage++;used=0;}
      expect(block.page).toBe(expectedPage);expect(block.x).toBeCloseTo(15*px);expect(block.y).toBeCloseTo(15*px+used);used+=bottom-top;
      expect(block.x+block.sourceBounds.w).toBeLessThanOrEqual(195*px+1e-9);
      expect(block.y+block.sourceBounds.h).toBeLessThanOrEqual(282*px+1e-9);
      if(block.system)expect([c.firstMasterBarIndex,c.lastMasterBarIndex]).toEqual([block.system.bars[0].index,block.system.bars.at(-1)!.index]);
    }
    expect(result.pageCount).toBe(expectedPage+1);expect(result.pageCount).toBe(4);
    expect(json(fixture.bounds.toJson())).toBe(original);expect(json(fixture.chunks)).toBe(chunks);
  });

  it('keeps the later-system 11.3px top-padding envelope and original SVG offset',()=>{
    const block=pagination.blocks.find(b=>b.system===fixture.bounds.staffSystems[1])!;
    expect(block.system!.realBounds.y-block.chunk.y).toBeCloseTo(11.3);
    expect(block.sourceBounds.h-block.chunk.height).toBeCloseTo(11.3);
    const arranged=arrangeScreenPages(pagination,'verticalPage',1,0+pagination.paper.width);
    const svg=mapScreenRect(pagination,arranged,block.system!,{x:block.chunk.x,y:block.chunk.y,w:block.chunk.width,h:block.chunk.height})!;
    const real=mapScreenRect(pagination,arranged,block.system!,block.system!.realBounds)!;
    expect(real.y-svg.y).toBeCloseTo(11.3);
    expect(svg.y).toBeCloseTo(arranged.pages[block.page].y+block.y+block.chunk.y-block.sourceBounds.y);
  });

  it('uses raw paper content height rather than the PDF 64px reservation',()=>{
    const bounds=new rendering.BoundsLookup();bounds.finish();
    const chunks=[syntheticChunk('a',0,600),syntheticChunk('b',600,400)];
    const result=paginateScreenScore(chunks,bounds,page);
    expect(result.pageCount).toBe(1);expect(result.blocks[1].y).toBeCloseTo(15*px+600);
  });

  it('rejects real systems and synthetic leading or trailing blocks too large for the paper',()=>{
    expect(()=>paginateScreenScore(fixture.chunks,fixture.bounds,{...page,heightMm:90})).toThrow(oversize);
    for(const index of [0,fixture.chunks.length-1]) {
      const chunks=fixture.chunks.map((c,i)=>i===index?{...c,height:1100}:c);
      expect(()=>paginateScreenScore(chunks,fixture.bounds,page)).toThrow(oversize);
    }
    expect(()=>paginateScreenScore([syntheticChunk('wide',0,20,181*px)],emptyBounds(),page)).toThrow(oversize);
  });

  it('rejects missing, duplicate, mismatched and geometrically unrelated system chunks',()=>{
    const chunks=[...fixture.chunks],first=chunks[1];
    for(const invalid of [chunks.filter(c=>c!==first),[...chunks,first],[...chunks,{...first,id:'other'}],chunks.map(c=>c===first?{...c,lastMasterBarIndex:99}:c),chunks.map(c=>c===first?{...c,y:c.y+10000}:c)]) {
      expect(()=>paginateScreenScore(invalid,fixture.bounds,page)).toThrow(/chunk|system|association/i);
    }
    const duplicate=Object.assign(new rendering.BoundsLookup(),{staffSystems:[...fixture.bounds.staffSystems,fixture.bounds.staffSystems[0]]});
    expect(()=>paginateScreenScore(chunks,duplicate,page)).toThrow(/system|ambiguous/i);
    expect(()=>paginateScreenScore([],fixture.bounds,page)).toThrow(/chunk|system/i);
  });

  it('rejects a leading or trailing chunk repeated under a different ID',()=>{
    for(const chunk of [fixture.chunks[0],fixture.chunks.at(-1)!])expect(()=>paginateScreenScore([...fixture.chunks,{...chunk,id:'repeated'}],fixture.bounds,page)).toThrow(/duplicate.*chunk/i);
  });

  it('rejects repeated or inverted master-bar intervals within a system',()=>{
    const original=fixture.bounds.staffSystems[0];
    for(const bars of [[original.bars[0],original.bars[0],original.bars[1]],[original.bars[1],original.bars[0]]]) {
      const system=Object.assign(new rendering.StaffSystemBounds(),original,{bars});
      const bounds=Object.assign(new rendering.BoundsLookup(),{staffSystems:[system,...fixture.bounds.staffSystems.slice(1)]});
      expect(()=>paginateScreenScore(fixture.chunks,bounds,page)).toThrow(/bar interval|association/i);
    }
  });

  it.each([{width:0},{height:-1},{x:NaN},{y:Infinity},{width:Infinity},{id:''},{svg:''},{svg:'canvas'},{svg:null},{firstMasterBarIndex:0.5}])('rejects invalid chunk data %j',invalid=>{
    const chunks=fixture.chunks.map((c,i)=>i===0?{...c,...invalid}:c) as ScreenRenderChunk[];
    expect(()=>paginateScreenScore(chunks,fixture.bounds,page)).toThrow();
  });

  it('rejects invalid page and system bounds',()=>{
    expect(()=>paginateScreenScore(fixture.chunks,fixture.bounds,{...page,widthMm:NaN})).toThrow();
    const system=Object.assign(new rendering.StaffSystemBounds(),fixture.bounds.staffSystems[0],{realBounds:{x:0,y:0,w:NaN,h:40}});
    const bounds=Object.assign(new rendering.BoundsLookup(),{staffSystems:[system,...fixture.bounds.staffSystems.slice(1)]});
    expect(()=>paginateScreenScore(fixture.chunks,bounds,page)).toThrow(/bounds|geometry/i);
  });
});

function syntheticChunk(id:string,y:number,height:number,width=100):ScreenRenderChunk {
  return {id,x:0,y,width,height,firstMasterBarIndex:-1,lastMasterBarIndex:-1,svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'};
}
function emptyBounds(){const bounds=new rendering.BoundsLookup();bounds.finish();return bounds;}

describe('arrangement and shared coordinates',()=>{
  it('centers columns and row-major grids, keeps rows left-aligned and spans every sheet and gap',()=>{
    const small:ScreenPagination={paper:{width:200.5,height:300.25,left:10,top:10,right:10,bottom:10},pageCount:5,blocks:[]};
    expect(SCREEN_PAGE_GAP).toBe(24);
    const v=arrangeScreenPages(small,'verticalPage',2,1000);
    expect(v.pages.map(p=>[p.x,p.y])).toEqual([[299.5,0],[299.5,624.5],[299.5,1249],[299.5,1873.5],[299.5,2498]]);
    expect([v.width,v.height]).toEqual([1000,3098.5]);
    const h=arrangeScreenPages(small,'horizontalPage',2,1000);
    expect(h.pages.map(p=>[p.x,p.y])).toEqual([[0,0],[425,0],[850,0],[1275,0],[1700,0]]);expect([h.width,h.height]).toEqual([2101,600.5]);
    const grid=arrangeScreenPages(small,'grid',2,1000);
    expect(grid.pages.map(p=>[p.x,p.y])).toEqual([[87,0],[512,0],[87,624.5],[512,624.5],[87,1249]]);
    expect([grid.width,grid.height]).toEqual([1000,1849.5]);
    expect(arrangeScreenPages(small,'grid',2,100).pages[0].x).toBe(0);
    expect(arrangeScreenPages(small,'grid',2,10000).pages[0].x).toBe((10000-2101)/2);
  });

  it('rejects unusable arrangement dimensions and nonfinite mapping inputs',()=>{
    for(const scale of [0,-1,NaN,Infinity])expect(()=>arrangeScreenPages(pagination,'grid',scale,800)).toThrow();
    for(const width of [-1,NaN,Infinity])expect(()=>arrangeScreenPages(pagination,'grid',1,width)).toThrow();
    const arrangement=arrangeScreenPages(pagination,'grid',1,800),system=fixture.bounds.staffSystems[0];
    expect(()=>mapScreenRect(pagination,arrangement,system,{x:NaN,y:0,w:0,h:10})).toThrow();
    expect(()=>mapScreenRect(pagination,arrangement,system,{x:0,y:0,w:-1,h:10})).toThrow();
    expect(()=>unmapScreenPoint(pagination,arrangement,{x:0,y:Infinity})).toThrow();
    expect(mapScreenRect(pagination,arrangement,new rendering.StaffSystemBounds(),{x:0,y:0,w:0,h:10})).toBeNull();
  });

  for(const scale of [0.25,1.375,3])for(const mode of ['verticalPage','horizontalPage','grid'] as const)for(const columns of mode==='grid'?[1,2,3]:[1]) {
    it(`maps every distinct rendered note exactly at ${scale}, ${mode}, ${columns} column(s)`,()=>{
      const original=json(fixture.bounds.toJson()),assignment=pagination.blocks.map(b=>b.page);
      const arrangement=arrangeScreenPages(pagination,mode,scale,columns*(pagination.paper.width*scale+24)-24+13);
      const lanes=new Set<string>();let notes=0;
      for(const system of fixture.bounds.staffSystems)for(const master of system.bars)for(const bar of master.bars)for(const beat of bar.beats)for(const note of beat.notes??[]) {
        const sourceRect={...note.noteHeadBounds},p=center(sourceRect),block=pagination.blocks.find(b=>b.system===system)!,sheet=arrangement.pages[block.page];
        const expected={x:sheet.x+(block.x+p.x-block.sourceBounds.x)*scale,y:sheet.y+(block.y+p.y-block.sourceBounds.y)*scale};
        const mapped=mapScreenRect(pagination,arrangement,system,sourceRect)!;
        expect(center(mapped).x).toBeCloseTo(expected.x,8);expect(center(mapped).y).toBeCloseTo(expected.y,8);
        const wrapper={left:43.75,top:81.125,scrollX:137.5,scrollY:289.25};
        const client={x:expected.x+wrapper.left-wrapper.scrollX,y:expected.y+wrapper.top-wrapper.scrollY};
        const local={x:client.x-wrapper.left+wrapper.scrollX,y:client.y-wrapper.top+wrapper.scrollY};
        const inverse=unmapScreenPoint(pagination,arrangement,local)!;
        expect(inverse.system).toBe(system);expect(inverse.point.x).toBeCloseTo(p.x,8);expect(inverse.point.y).toBeCloseTo(p.y,8);
        const hit=hitTestScreenPages(pagination,arrangement,local)!;
        expect(hit.note).toBe(note.note);expect(hit.beat).toBe(beat.beat);expect(hit.system).toBe(system);
        const voice=beat.beat.voice,staff=voice.bar.staff;
        expect(fixture.sourceNotes.get(hit.note!)).toBe(fixture.source.tracks[staff.track.index].staves[staff.index].bars[voice.bar.index].voices[voice.index].beats[beat.beat.index].notes[note.note.index]);
        expect(fixture.sourceBeats.get(hit.beat)).toBe(fixture.sourceNotes.get(hit.note!)!.beat);
        expect(note.noteHeadBounds).toEqual(sourceRect);lanes.add(`${staff.track.index}/${staff.index}/${voice.index}`);notes++;
      }
      expect(notes).toBe(576);expect(lanes.size).toBe(6);expect(json(fixture.bounds.toJson())).toBe(original);expect(pagination.blocks.map(b=>b.page)).toEqual(assignment);
      expect(model.JsonConverter.scoreToJson(fixture.source)).toBe(fixture.sourceJson);expect(model.JsonConverter.scoreToJson(fixture.rendered)).toBe(fixture.renderedJson);
      for(const sheet of arrangement.pages) {
        for(const point of [{x:sheet.x+1,y:sheet.y+1},{x:sheet.x+sheet.width-1,y:sheet.y+sheet.height-1},{x:sheet.x+sheet.width+12,y:sheet.y+sheet.height/2},{x:sheet.x+sheet.width/2,y:sheet.y+sheet.height+12}])expect(hitTestScreenPages(pagination,arrangement,point)).toBeNull();
      }
    });
  }

  it('maps zero-width cursor rectangles and excludes the final right/bottom boundary',()=>{
    const system=fixture.bounds.staffSystems.at(-1)!,block=pagination.blocks.find(b=>b.system===system)!,a=arrangeScreenPages(pagination,'verticalPage',1.375,1200);
    const rect={x:system.realBounds.x,y:system.realBounds.y,w:0,h:system.realBounds.h},mapped=mapScreenRect(pagination,a,system,rect)!;
    expect(mapped.w).toBe(0);expect(mapped.h).toBeCloseTo(rect.h*1.375);expect(rect.w).toBe(0);
    const sheet=a.pages[block.page],x=sheet.x+(block.x+block.sourceBounds.w)*a.scale,y=sheet.y+(block.y+block.sourceBounds.h)*a.scale;
    expect(unmapScreenPoint(pagination,a,{x,y:y-1})).toBeNull();expect(unmapScreenPoint(pagination,a,{x:x-1,y})).toBeNull();
  });
});

describe('voice and blank-beat targeting',()=>{
  it('prefers the requested staff lane only for coincident noteheads and otherwise falls back deterministically',()=>{
    const f=scoreFixture(true),p=paginateScreenScore(f.chunks,f.bounds,page),a=arrangeScreenPages(p,'grid',1.375,2500);
    const system=f.bounds.staffSystems[0],bar=system.bars[0].bars[1],first=bar.beats.find(b=>b.beat.voice.index===0)!,second=bar.beats.find(b=>b.beat.voice.index===1)!;
    expect(first.notes![0].noteHeadBounds).toEqual(second.notes![0].noteHeadBounds);
    const point=center(mapScreenRect(p,a,system,first.notes![0].noteHeadBounds)!);
    const staff=first.beat.voice.bar.staff;
    expect(hitTestScreenPages(p,a,point)?.note).toBe(first.notes![0].note);
    expect(hitTestScreenPages(p,a,point,{track:staff.track.index,staff:staff.index,voice:1})?.note).toBe(second.notes![0].note);
    expect(hitTestScreenPages(p,a,point,{track:99,staff:staff.index,voice:1})?.note).toBe(first.notes![0].note);
    expect(hitTestScreenPages(p,a,point,{track:staff.track.index,staff:99,voice:1})?.note).toBe(first.notes![0].note);
  });

  it('uses note index rather than candidate enumeration order for indistinguishable chord notes',()=>{
    const f=scoreFixture(true),system=f.bounds.staffSystems[0],beat=system.bars[0].bars[0].beats[0];
    const original=beat.notes![0],other=new model.Note();other.octave=original.note.octave;other.tone=original.note.tone;beat.beat.addNote(other);
    const bounds=new rendering.NoteBounds();bounds.note=other;bounds.noteHeadBounds=original.noteHeadBounds;bounds.beatBounds=beat;
    beat.notes!.unshift(bounds);
    const p=paginateScreenScore(f.chunks,f.bounds,page),a=arrangeScreenPages(p,'verticalPage',1,900),point=center(mapScreenRect(p,a,system,original.noteHeadBounds)!);
    expect(hitTestScreenPages(p,a,point)?.note).toBe(original.note);
  });

  it('lets distinct noteheads win over a preferred voice with a broad beat rectangle',()=>{
    const system=fixture.bounds.staffSystems[0],bar=system.bars[0].bars[0],beat=bar.beats.find(b=>b.beat.voice.index===1)!,a=arrangeScreenPages(pagination,'verticalPage',1,900),staff=beat.beat.voice.bar.staff;
    const point=center(mapScreenRect(pagination,a,system,beat.notes![0].noteHeadBounds)!);
    expect(hitTestScreenPages(pagination,a,point,{track:staff.track.index,staff:staff.index,voice:0})?.note).toBe(beat.notes![0].note);
  });

  it.each([false,true])('returns the exact note-free beat in the clicked staff with lane preference (empty=%s)',blank=>{
    const f=scoreFixture(false,true,blank),p=paginateScreenScore(f.chunks,f.bounds,page),a=arrangeScreenPages(p,'horizontalPage',1,900);
    for(const bar of f.bounds.staffSystems[0].bars[0].bars) {
      const rest=bar.beats.find(b=>b.beat.index===1&&b.beat.voice.index===1)!;
      expect(rest.notes??[]).toHaveLength(0);
      const point=mapScreenRect(p,a,f.bounds.staffSystems[0],{x:rest.onNotesX,y:bar.realBounds.y+bar.realBounds.h/2,w:0,h:0})!;
      const staff=rest.beat.voice.bar.staff,hit=hitTestScreenPages(p,a,point,{track:staff.track.index,staff:staff.index,voice:1});
      expect(hit?.beat).toBe(rest.beat);expect(hit?.note).toBeNull();expect(f.sourceBeats.get(hit!.beat)).toBe(f.source.tracks[staff.track.index].staves[staff.index].bars[0].voices[1].beats[1]);
    }
  });
});

describe('zoom arithmetic',()=>{
  it.each([
    ['manual',137.5,0,0,NaN,undefined,137.5,false],
    ['fitWidth',100,400,0,800,undefined,50,false],
    ['fitPage',100,600,600,800,1200,50,false],
    ['fitWidth',100,100,600,800,undefined,25,true],
    ['fitWidth',100,400,600,100,undefined,300,true],
    ['fitWidth',100,200,600,800,undefined,25,false],
    ['fitWidth',100,2400,600,800,undefined,300,false]
  ] as const)('resolves %s without changing manual zoom', (zoomMode,manualPercent,width,height,naturalWidth,naturalHeight,percent,limited)=>{
    expect(resolveScreenZoom({zoomMode,manualPercent,available:{width,height},natural:{width:naturalWidth,height:naturalHeight}})).toEqual({percent,limited});
  });
  it('rejects unmeasured or nonfinite required fit dimensions and invalid manual values',()=>{
    for(const value of [0,-1,NaN,Infinity]) {
      expect(()=>resolveScreenZoom({zoomMode:'fitWidth',manualPercent:100,available:{width:value,height:600},natural:{width:800}})).toThrow();
      expect(()=>resolveScreenZoom({zoomMode:'fitWidth',manualPercent:100,available:{width:600,height:600},natural:{width:value}})).toThrow();
      expect(()=>resolveScreenZoom({zoomMode:'fitPage',manualPercent:100,available:{width:600,height:value},natural:{width:800,height:1200}})).toThrow();
      expect(()=>resolveScreenZoom({zoomMode:'fitPage',manualPercent:100,available:{width:600,height:600},natural:{width:800,height:value}})).toThrow();
    }
    expect(()=>resolveScreenZoom({zoomMode:'fitPage',manualPercent:100,available:{width:600,height:600},natural:{width:800}})).toThrow();
    for(const manualPercent of [24,301,NaN,Infinity])expect(()=>resolveScreenZoom({zoomMode:'manual',manualPercent,available:{width:0,height:0},natural:{width:0}})).toThrow();
  });
});
