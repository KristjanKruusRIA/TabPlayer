// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {StrictMode} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LayoutMode,Settings,SystemsLayoutMode,model,rendering,type PlaybackHighlightChangeEventArgs} from '@coderline/alphatab';
import {ScoreView} from './ScoreView';
import {music} from './editor/fixtures';
import type {EngravingOverrides,PageLayout} from './engraving/types';
import type {SystemSpan} from './engraving/system-gaps';
import type {ScoreLayoutMode} from './engraving/screen-view';
import {defaultEngraving,projectEngraving,type EngravingProjection} from './engraving/projection';
import {planAccolades} from './engraving/accolades';
import {withStaffGaps,withStaffGroups} from './engraving/staff-groups';
import {threeTrackScore} from './engraving/staff-fixtures';
import {engravingRenderKey,withSystemGaps} from './engraving/system-gaps';
const state=vi.hoisted(()=>({fonts:(()=>new Promise<void>(()=>{})) as ()=>Promise<void>,api:null as unknown,width:900,height:700,resize:()=>{},loads:vi.fn(),renders:vi.fn(),chunkTops:[] as number[]}));
function event<T>(){const handlers=new Set<(e:T)=>void>();return {on:(fn:(e:T)=>void)=>{handlers.add(fn);return()=>handlers.delete(fn);},emit:(e:T)=>{for(const fn of handlers)fn(e);}};}
vi.mock('./export/pdf',async original=>({...await original<typeof import('./export/pdf')>(),loadExportFonts:()=>state.fonts()}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
 settings=new Settings();score:model.Score|null=null;tracks:number[]=[0];constructor(){state.api=this;}
 beatMouseDown=event<model.Beat>();noteMouseDown=event<model.Note>();beatMouseMove=event<model.Beat>();beatMouseUp=event<void>();renderStarted=event<void>();postRenderFinished=event<void>();playbackRangeHighlightChanged=event<PlaybackHighlightChangeEventArgs>();
 renderer={width:0,partialRenderFinished:event<unknown>()};boundsLookup={staffSystems:[] as rendering.StaffSystemBounds[],findBeats:(beat:model.Beat)=>this.boundsLookup.staffSystems.flatMap(s=>s.bars.flatMap(m=>m.bars.flatMap(b=>b.beats))).filter(b=>b.beat===beat),findBeat:(beat:model.Beat)=>this.boundsLookup.findBeats(beat)[0],getBeatAtPos:()=>null};
 uiFacade={getOffset:()=>({x:0,y:0}),highlightElements(){},removeHighlights(){}};canvasElement={};customCursorHandler=undefined;customScrollHandler=undefined;
 updateSettings(){} destroy(){}
 highlightPlaybackRange(start:model.Beat,end:model.Beat){const first=this.boundsLookup.findBeat(start),last=this.boundsLookup.findBeat(end);if(first&&last)this.playbackRangeHighlightChanged.emit({startBeat:start,endBeat:end,startBeatBounds:first,endBeatBounds:last,highlightBlocks:this.boundsLookup.staffSystems.filter(s=>s.bars[0].index>=start.voice.bar.index&&s.bars[0].index<=end.voice.bar.index).map(s=>s.realBounds)});}
 clearPlaybackRangeHighlight(){this.playbackRangeHighlightChanged.emit({});}
 renderScore(score:model.Score,tracks?:number[]){state.loads();this.score=score;this.tracks=tracks??[0];this.render();}
 render(){state.renders();this.renderStarted.emit();const score=this.score;if(!score)return;this.boundsLookup.staffSystems=[];state.chunkTops=[];
 for(let i=0;i<3;i++){
 const s=new rendering.StaffSystemBounds(),m=new rendering.MasterBarBounds(),b=new rendering.BarBounds(),beat=new rendering.BeatBounds(),note=new rendering.NoteBounds();
 s.realBounds=s.visualBounds=new rendering.Bounds(0,i*450,500,400);s.bars=[m];m.index=i;m.staffSystemBounds=s;m.realBounds=m.visualBounds=s.realBounds;
 // A one-track score keeps one bar covering the system; a multi-track score gets one BarBounds per staff of each rendered track (guitar, piano treble and bass, drums).
 const rows:Array<[number,number,number,number]>=[[0,0,100,60],[1,0,200,40],[1,1,260,40],[2,0,340,40]];
 const bars=score.tracks.length<2?[b]:rows.filter(([t])=>this.tracks.includes(t)).map(([t,st,y,h],k)=>{const x=k?new rendering.BarBounds():b;x.realBounds=x.visualBounds=new rendering.Bounds(0,i*450+y,500,h);x.bar=score.tracks[t].staves[st].bars[i];x.masterBarBounds=m;x.beats=k?[]:[beat];return x;});
 if(score.tracks.length<2){b.realBounds=b.visualBounds=s.realBounds;b.bar=score.tracks[0].staves[0].bars[i];b.masterBarBounds=m;b.beats=[beat];}
 m.bars=bars;beat.barBounds=b;beat.beat=score.tracks[0].staves[0].bars[i].voices[0].beats[0];beat.realBounds=beat.visualBounds=new rendering.Bounds(50,i*450+40,60,60);note.note=beat.beat.notes[0];note.noteHeadBounds=new rendering.Bounds(60,i*450+50,12,12);beat.notes=[note];this.boundsLookup.staffSystems.push(s);state.chunkTops.push(i*450);
 this.renderer.partialRenderFinished.emit({id:`chunk-${i}`,x:0,y:i*450,width:500,height:400,firstMasterBarIndex:i,lastMasterBarIndex:i,renderResult:'<svg><text>Notes</text></svg>'});
 }this.postRenderFinished.emit();}
}}));
const page:PageLayout={widthMm:210,heightMm:210,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document'};
function setup(layout:ScoreLayoutMode='verticalPage',zoom=100,extra:{page?:PageLayout;engraving?:EngravingOverrides;onSystems?:(systems:SystemSpan[]|null)=>void;score?:model.Score;projection?:EngravingProjection;trackIds?:readonly string[];visibleTracks?:number[]}={}){
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.width:0;});
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.height:0;});
 vi.stubGlobal('ResizeObserver',class {constructor(fn:()=>void){state.resize=fn;}observe(){}disconnect(){}});
 const props={score:music(),track:0,zoom,profile:'ScoreTab',playback:null,onSelect:vi.fn(),page,display:{layout,zoomMode:'manual' as const},onDisplayStatus:vi.fn(),...extra};
 const tree=(p=props)=><div className="paper-scroll" style={{padding:10}}><div className="paper score-paper-host"><ScoreView {...p}/></div></div>;
 const result=render(tree());return {...result,props,tree,api:state.api as {settings:Settings;renderer:{width:number}}};
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();state.loads.mockClear();state.renders.mockClear();state.width=900;state.height=700;state.fonts=()=>new Promise<void>(()=>{});});
it.each(['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'] as const)('renders %s without a playback controller',layout=>{
 const {api}=setup(layout);expect(state.loads).toHaveBeenCalledTimes(1);
 expect(api.settings.display.layoutMode).toBe(layout==='horizontalScreen'?LayoutMode.Horizontal:layout==='verticalScreen'?LayoutMode.Page:LayoutMode.Parchment);
 if(layout==='verticalScreen')expect(api.settings.display.systemsLayoutMode).toBe(SystemsLayoutMode.Automatic);
 if(['verticalPage','horizontalPage','grid'].includes(layout)){expect(screen.getAllByLabelText(/^Score page \d/)).toHaveLength(3);expect(screen.getByTestId('score-source').getAttribute('aria-hidden')).toBe('true');}
});
it('changes physical zoom and arrangement without reloading or rerendering notation',()=>{
 const {props,tree,rerender}=setup();const calls=state.renders.mock.calls.length;
 rerender(tree({...props,zoom:137.5,display:{layout:'horizontalPage',zoomMode:'manual'}}));
 expect(state.loads).toHaveBeenCalledTimes(1);expect(state.renders).toHaveBeenCalledTimes(calls);
 expect(screen.getAllByLabelText(/^Score page \d/)[0].style.width).toBe(`${210*96/25.4*1.375}px`);
});
it('maps exact physical note hits, ignores gutters, and keeps canonical identities',()=>{
 const {props}=setup(),pages=screen.getByTestId('score-pages');const margin=15*96/25.4,center=(880-210*96/25.4)/2;
 fireEvent.mouseDown(pages,{clientX:center+margin+66,clientY:margin+56,button:0});expect(props.onSelect).toHaveBeenLastCalledWith({track:0,staff:0,bar:0,voice:0,beat:0},6,0);
 props.onSelect.mockClear();fireEvent.mouseDown(pages,{clientX:1,clientY:1,button:0});expect(props.onSelect).not.toHaveBeenCalled();
});
it('fits measured host padding locally and preserves the last manual percent on resize',()=>{
 const {props,tree,rerender}=setup('verticalPage',137.5);
 rerender(tree({...props,display:{layout:'verticalPage',zoomMode:'fitWidth'} as never}));
 expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:880/(210*96/25.4)*100,fitLimited:false,pageError:null});
 state.width=500;act(()=>state.resize());expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:480/(210*96/25.4)*100,fitLimited:false,pageError:null});expect(state.loads).toHaveBeenCalledTimes(1);
});
it('shows an explicit manual continuous fallback for indivisible oversized systems',()=>{
 const {props,tree,rerender}=setup('verticalPage',137.5),small={...page,widthMm:150,heightMm:150};
 rerender(tree({...props,page:small,display:{layout:'verticalPage',zoomMode:'fitPage'} as never}));
 expect(screen.getByRole('alert').textContent).toMatch(/fewer staves.*Continuous view is shown at 137.5%/);
 expect(screen.queryByTestId('score-pages')).toBeNull();expect(screen.getByTestId('score-source').getAttribute('aria-hidden')).toBeNull();
 expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:137.5,fitLimited:false,pageError:expect.stringContaining('does not fit')});
 rerender(tree(props));expect(screen.getAllByLabelText(/^Score page \d/)).toHaveLength(3);
});
it.each([25,137.5,300])('uses %s percent magnification without changing physical source density',zoom=>{
 const {api,props,tree,rerender}=setup();rerender(tree({...props,zoom}));expect(api.settings.display.scale).toBe(1);expect(api.renderer.width).toBeCloseTo(180*96/25.4);expect(state.loads).toHaveBeenCalledTimes(1);
});
it('preserves canonical Shift, toggle and triple-click actions through physical hits',()=>{
 const {props,tree,rerender}=setup(),selection=vi.fn();rerender(tree({...props,onEditorSelection:selection} as never));
 const pages=screen.getByTestId('score-pages'),margin=15*96/25.4,x=(880-210*96/25.4)/2+margin+66,y=margin+56,step=210*96/25.4+24;
 fireEvent.mouseDown(pages,{clientX:x,clientY:y,button:0});fireEvent.mouseUp(document);
 fireEvent.mouseDown(pages,{clientX:x,clientY:y+step,shiftKey:true,button:0});expect(selection).toHaveBeenLastCalledWith({kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:960},lanes:[{track:0,staff:0,voice:0}]}});
 fireEvent.mouseDown(pages,{clientX:x,clientY:y+step,ctrlKey:true,button:0});expect(selection.mock.calls.at(-1)![0].kind).toBe('notes');
 fireEvent.mouseDown(pages,{clientX:x,clientY:y,detail:3,button:0});expect(selection).toHaveBeenLastCalledWith({kind:'bars',tracks:[0],firstBar:0,lastBar:3});
});
it('drags a range across page boundaries and ignores blank gutters',()=>{
 const {props,tree,rerender}=setup(),selection=vi.fn();rerender(tree({...props,onEditorSelection:selection} as never));
 const pages=screen.getByTestId('score-pages'),margin=15*96/25.4,x=(880-210*96/25.4)/2+margin+66,y=margin+56,step=210*96/25.4+24;
 fireEvent.mouseDown(pages,{clientX:x,clientY:y,button:0});const calls=selection.mock.calls.length;
 fireEvent.mouseMove(document,{clientX:1,clientY:step-10});expect(selection).toHaveBeenCalledTimes(calls);
 fireEvent.mouseMove(document,{clientX:x,clientY:y+2*step});expect(selection.mock.calls.at(-1)![0].range.end).toEqual({bar:2,tick:960});fireEvent.mouseUp(document);
});
it.each(['verticalScreen','horizontalScreen'] as const)('retains the base fit measurement in %s across the final render',layout=>{
 const {props,tree,rerender}=setup(layout);state.width=300;act(()=>state.resize());const prior=state.renders.mock.calls.length;
 rerender(tree({...props,display:{layout,zoomMode:'fitWidth'} as never}));
 expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:56.00000000000001,fitLimited:false,pageError:null});
 expect(state.renders.mock.calls.length-prior).toBeLessThanOrEqual(2);expect(state.loads).toHaveBeenCalledTimes(1);
});
it('maps separate public range blocks and resizes a handle across page boundaries',()=>{
 const {props,tree,rerender}=setup(),selection=vi.fn();rerender(tree({...props,editorSelection:{kind:'range',range:{start:{bar:0,tick:0},end:{bar:2,tick:960},lanes:[{track:0,staff:0,voice:0}]}},onEditorSelection:selection} as never));
 expect(document.querySelectorAll('.score-range-block')).toHaveLength(3);
 const end=screen.getByRole('button',{name:'Resize selection end'}),margin=15*96/25.4,step=210*96/25.4+24;
 expect(parseFloat(end.style.top)).toBeGreaterThan(step*2);
 fireEvent.mouseDown(end,{button:0});fireEvent.mouseMove(document,{clientX:(880-210*96/25.4)/2+margin+66,clientY:step+margin+56});fireEvent.mouseUp(document);
 expect(selection).toHaveBeenLastCalledWith({kind:'range',range:{start:{bar:0,tick:0},end:{bar:1,tick:960},lanes:[{track:0,staff:0,voice:0}]}});
});
it('reports truthful lower fit limits and keeps vertical screen at at most 100 percent',()=>{
 const {props,tree,rerender}=setup('verticalScreen',137.5);
 rerender(tree({...props,display:{layout:'verticalScreen',zoomMode:'fitWidth'} as never}));expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:100,fitLimited:false,pageError:null});
 state.width=100;act(()=>state.resize());expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:25,fitLimited:true,pageError:null});
 expect(state.loads).toHaveBeenCalledTimes(1);
});
it('reflows grid columns at host resize without regenerating notation',()=>{
 const {props,tree,rerender}=setup('grid',50),calls=state.renders.mock.calls.length;
 expect(screen.getAllByLabelText(/^Score page \d/)[1].style.top).toBe('0px');
 state.width=500;act(()=>state.resize());expect(parseFloat(screen.getAllByLabelText(/^Score page \d/)[1].style.top)).toBeGreaterThan(0);expect(state.renders).toHaveBeenCalledTimes(calls);
 rerender(tree({...props,score:music()}));expect(state.loads).toHaveBeenCalledTimes(2);
});

it('loads the current score into a fresh API during React lifecycle remount',()=>{
 const prepared=setup();prepared.unmount();state.loads.mockClear();
 render(<StrictMode>{prepared.tree()}</StrictMode>);
 expect(state.loads).toHaveBeenCalledTimes(2);expect((state.api as {score:model.Score}).score).toBe(prepared.props.score);expect(screen.getAllByLabelText(/^Score page \d/)).toHaveLength(3);
});
it('measures screen fit at base scale even when host height is not available yet',()=>{
 state.height=0;const {props,tree,rerender}=setup('horizontalScreen',137.5);
 rerender(tree({...props,display:{layout:'horizontalScreen',zoomMode:'fitWidth'} as never}));
 expect(props.onDisplayStatus).toHaveBeenLastCalledWith({zoomPercent:176,fitLimited:false,pageError:null});
});
const overlays=()=>Array.from(document.querySelectorAll<SVGSVGElement>('.score-page-text'));
const texts=(svg:SVGSVGElement)=>Array.from(svg.querySelectorAll('text')).map(t=>t.textContent);
function titled(layout:ScoreLayoutMode='verticalPage'){const s=setup(layout);s.props.score.title='Etude';s.rerender(s.tree({...s.props,score:s.props.score}));return s;}
it('draws the default header title and N / total footer on every page sheet',()=>{
 titled();const svgs=overlays();expect(svgs).toHaveLength(3);
 svgs.forEach((svg,i)=>{expect(texts(svg)).toEqual(['Etude',`${i+1} / 3`]);expect(svg.getAttribute('aria-hidden')).toBe('true');expect(svg.getAttribute('class')).toBe('score-page-text');});
});
it('uses the first-page and other-page bands from the page layout',()=>{
 const {props,tree,rerender}=titled(),bands=(h:string,f:string)=>({header:{left:h,center:'',right:''},footer:{left:'',center:f,right:''}});
 rerender(tree({...props,page:{...page,headerFooter:{first:bands('First','F%PAGE%'),other:bands('Other','O%PAGE%/%PAGES%')}}}));
 const svgs=overlays();expect(texts(svgs[0])).toEqual(['First','F1']);expect(texts(svgs[1])).toEqual(['Other','O2/3']);expect(texts(svgs[2])).toEqual(['Other','O3/3']);
});
it('redraws a header-only edit without rendering notation again',()=>{
 const {props,tree,rerender}=titled(),calls=state.renders.mock.calls.length,bands=(h:string)=>({header:{left:h,center:'',right:''},footer:{left:'',center:'',right:''}});
 rerender(tree({...props,page:{...page,headerFooter:{first:bands('One'),other:bands('Two')}}}));
 expect(texts(overlays()[0])).toEqual(['One']);expect(state.renders).toHaveBeenCalledTimes(calls);expect(state.loads).toHaveBeenCalledTimes(1);
});
it('is click-through via CSS and only resizes with zoom',()=>{
 const {props,tree,rerender}=titled();const css=require('node:fs').readFileSync('src/ScoreView.css','utf8') as string;
 expect(css).toMatch(/\.score-page-text\s*\{[^}]*pointer-events:\s*none/);
 const before=overlays()[0],calls=state.renders.mock.calls.length,width=before.getAttribute('width'),view=before.getAttribute('viewBox');
 rerender(tree({...props,zoom:200}));const after=overlays()[0];
 expect(after.getAttribute('viewBox')).toBe(view);expect(Number(after.getAttribute('width'))).toBeCloseTo(Number(width)*2);expect(state.renders).toHaveBeenCalledTimes(calls);
});
it.each(['parchment','verticalScreen','horizontalScreen'] as const)('draws no page text in %s',layout=>{titled(layout);expect(overlays()).toHaveLength(0);});

it('re-fits page text when the fonts resolve and ignores a font failure',async()=>{
 const measure={k:.3};
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation((()=>({font:'',measureText(this:{font:string},text:string){return {width:text.length*(parseFloat(this.font)||18)*measure.k};}})) as never);
 let resolve=()=>{};state.fonts=()=>new Promise<void>(done=>{resolve=done;});
 const s=setup();s.props.score.title='T'.repeat(40);s.rerender(s.tree({...s.props,score:s.props.score}));
 const size=()=>Number(overlays()[0].querySelector('text')!.getAttribute('font-size')),calls=state.renders.mock.calls.length;
 expect(size()).toBe(18);
 measure.k=1.2;await act(async()=>{resolve();});
 expect(size()).toBeLessThan(18);expect(state.renders).toHaveBeenCalledTimes(calls);
 cleanup();state.fonts=()=>Promise.reject(new Error('no fonts'));
 const failed=setup();await act(async()=>{});
 expect(screen.queryByRole('alert')).toBeNull();expect(overlays()).toHaveLength(3);failed.unmount();
});

// System gaps: a tall page keeps all three one-bar systems on one sheet so a gap moves the blocks that follow it.
const tallPage:PageLayout={...page,heightMm:600};
const tops=()=>Array.from(document.querySelectorAll<HTMLElement>('.score-svg-chunk')).map(chunk=>parseFloat(chunk.style.top));
function gapped(layout:ScoreLayoutMode='verticalPage'){
 const engraving=defaultEngraving(),onSystems=vi.fn(),s=setup(layout,100,{page:tallPage,engraving,onSystems});
 return {...s,props:{...s.props,onSystems},engraving};
}
it('moves the following blocks for a gap-only change without rendering or loading again, and restores them',()=>{
 const {props,tree,rerender,engraving}=gapped(),calls=state.renders.mock.calls.length,loads=state.loads.mock.calls.length,before=tops();
 expect(before).toHaveLength(3);
 rerender(tree({...props,engraving:withSystemGaps(engraving,[{bar:1,scale:3}])}));
 const moved=tops();expect(moved[0]).toBe(before[0]);expect(moved[1]-before[1]).toBeCloseTo(40);expect(moved[2]-before[2]).toBeCloseTo(40);
 expect(state.renders).toHaveBeenCalledTimes(calls);expect(state.loads).toHaveBeenCalledTimes(loads);
 rerender(tree({...props,engraving}));
 expect(tops()).toEqual(before);expect(state.renders).toHaveBeenCalledTimes(calls);expect(state.loads).toHaveBeenCalledTimes(loads);
});
it('still renders again for a non-gap engraving change',()=>{
 const {props,tree,rerender,engraving}=gapped(),calls=state.renders.mock.calls.length;
 rerender(tree({...props,engraving:{...engraving,systemSpacing:2}}));
 expect(state.renders.mock.calls.length).toBeGreaterThan(calls);
});
it('reports the rendered systems in a page layout and null in parchment',()=>{
 const {props}=gapped();
 expect(props.onSystems).toHaveBeenLastCalledWith([{first:0,last:0},{first:1,last:1},{first:2,last:2}]);
 cleanup();
 const parchment=gapped('parchment');expect(parchment.props.onSystems).toHaveBeenLastCalledWith(null);
});
it('does not report systems again for a gap-only change',()=>{
 const {props,tree,rerender,engraving}=gapped(),reports=props.onSystems.mock.calls.length;
 rerender(tree({...props,engraving:withSystemGaps(engraving,[{bar:1,scale:3}])}));
 rerender(tree({...props,engraving}));
 expect(props.onSystems).toHaveBeenCalledTimes(reports);
});
it('reports null and then the new intervals when the system spacing renders again',()=>{
 const {props,tree,rerender,engraving}=gapped();props.onSystems.mockClear();
 rerender(tree({...props,engraving:{...engraving,systemSpacing:2}}));
 expect(props.onSystems.mock.calls.map(([v])=>v)).toEqual([null,[{first:0,last:0},{first:1,last:1},{first:2,last:2}]]);
});
it('gives a newly attached handler the current value and reports null on unmount',()=>{
 const {props,tree,rerender,unmount}=gapped(),late=vi.fn();
 rerender(tree({...props,onSystems:late}));
 expect(late).toHaveBeenLastCalledWith([{first:0,last:0},{first:1,last:1},{first:2,last:2}]);
 unmount();expect(late).toHaveBeenLastCalledWith(null);
});
it('hit-tests the moved third block after a gap-only change',()=>{
 const {props,tree,rerender,engraving}=gapped(),pages=screen.getByTestId('score-pages'),margin=15*96/25.4,center=(880-210*96/25.4)/2;
 rerender(tree({...props,engraving:withSystemGaps(engraving,[{bar:2,scale:3}])}));
 // The third block moved down 40px: this point lies below where the block used to end.
 props.onSelect.mockClear();fireEvent.mouseDown(pages,{clientX:center+margin+66,clientY:margin+1230,button:0});
 expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({bar:2}),undefined,undefined);
 props.onSelect.mockClear();rerender(tree({...props,engraving}));fireEvent.mouseDown(pages,{clientX:center+margin+66,clientY:margin+1230,button:0});
 expect(props.onSelect).not.toHaveBeenCalled();
});

// Staff groups and staff gaps on a three-track score (guitar, two-staff piano, drums).
const {ids}=threeTrackScore();
type Mount={projection?:EngravingProjection;trackIds?:readonly string[];score?:model.Score};
function mountThree(layout:ScoreLayoutMode,engraving:EngravingOverrides,over:Mount={}){
 const fixture=threeTrackScore(),source=over.score??fixture.score;
 // Like App: a new projection whenever a field the notation depends on changes, and none for a gap-only edit.
 let key=engravingRenderKey(engraving),made=projectEngraving(source,ids,engraving);
 const projection=()=>Object.hasOwn(over,'projection')?over.projection:made,trackIds=()=>Object.hasOwn(over,'trackIds')?over.trackIds:ids;
 const result=setup(layout,100,{page:tallPage,engraving,score:source,projection:projection(),trackIds:trackIds(),visibleTracks:[0,1,2]});
 const view=()=>state.api as {settings:Settings;score:model.Score};
 return {...result,view,projection:()=>made,renders:()=>state.renders.mock.calls.length,blockTops:tops,chunkTops:()=>state.chunkTops,
  rerender:(next:EngravingOverrides)=>{if(engravingRenderKey(next)!==key){key=engravingRenderKey(next);made=projectEngraving(source,ids,next);}result.rerender(result.tree({...result.props,engraving:next,projection:projection(),trackIds:trackIds(),visibleTracks:[0,1,2],score:source}));}};
}
const mountPaged=(engraving:EngravingOverrides,over:Mount={})=>mountThree('verticalPage',engraving,over);
const mountContinuous=(engraving:EngravingOverrides,over:Mount={})=>mountThree('parchment',engraving,over);
const reserveOf=(engraving:EngravingOverrides)=>{const {score}=threeTrackScore(),projection=projectEngraving(score,ids,engraving);return planAccolades({engraving,trackIds:ids,rendered:[0,1,2],score:projection.score,nativeMode:projection.bracketMode,settings:new Settings()})!.reserve;};
it('a staff-gap-only change recomposes without another render',()=>{
 const {rerender,renders,blockTops}=mountPaged(defaultEngraving());const before=renders(),tops=blockTops();
 rerender(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]));
 expect(renders()).toBe(before);expect(blockTops()[1]-tops[1]).toBe(40);
});
it('a group change renders again with no brackets and the reserve',()=>{
 const {rerender,renders,view,projection}=mountPaged(defaultEngraving());const before=renders();
 const e=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]);rerender(e);
 const plan=planAccolades({engraving:e,trackIds:ids,rendered:[0,1,2],score:projection().score,nativeMode:projection().bracketMode,settings:view().settings})!;
 expect(renders()).toBe(before+1);expect(projection().score.stylesheet.bracketExtendMode).toBe(model.BracketExtendMode.NoBrackets);
 expect(view().settings.display.systemLabelPaddingRight).toBeCloseTo(3+plan.reserve);expect(view().settings.display.padding[0]).toBeCloseTo(plan.reserve);
});
it('label padding stays absolute across group edits and returns to 3 when the last group goes',()=>{
 const {rerender,view}=mountPaged(defaultEngraving());
 const g1=withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),g2=withStaffGroups(defaultEngraving(),[{trackIds:['base/1','base/2'],kind:'brace'}]);
 rerender(g1);const r1=view().settings.display.systemLabelPaddingRight;rerender(g2);const r2=view().settings.display.systemLabelPaddingRight;rerender(defaultEngraving());
 expect(r1).toBeCloseTo(3+reserveOf(g1));expect(r2).toBeCloseTo(3+reserveOf(g2));expect(view().settings.display.systemLabelPaddingRight).toBe(3);
});
it('without projection or trackIds no plan is made and the source score is untouched',()=>{
 const {score}=threeTrackScore(),mode=score.stylesheet.bracketExtendMode;
 mountPaged(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),{projection:undefined,trackIds:undefined,score});
 expect(score.stylesheet.bracketExtendMode).toBe(mode);expect(document.querySelector('[data-tp-accolade]')).toBeNull();
});
it('continuous layouts draw marks in an overlay that ignores clicks and ignore staff gaps',()=>{
 const {container,chunkTops}=mountContinuous(withStaffGaps(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),[{trackId:'base/0',scale:2}]));
 const overlay=container.querySelector('svg[data-tp-accolades]')!;
 expect(overlay.querySelectorAll('[data-tp-accolade="group-bracket"]')).toHaveLength(3);expect((overlay as SVGElement).style.pointerEvents).toBe('none');
 expect(overlay.getAttribute('aria-hidden')).toBe('true');
 expect(chunkTops()).toEqual([0,450,900]);
 // The bracket spans guitar top to piano bottom (200px) as rendered; a staff gap would stretch it by 40px.
 expect(Number(overlay.querySelector('[data-tp-accolade="group-bracket"] rect')!.getAttribute('height'))).toBeLessThan(230);
});
it('paged layouts put marks inside the composed chunks and size the boxes by the composed height',()=>{
 const {container}=mountPaged(withStaffGaps(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]),[{trackId:'base/0',scale:2}]));
 const boxes=[...container.querySelectorAll<HTMLElement>('.score-svg-chunk')];
 expect(boxes[0].innerHTML).toContain('data-tp-accolade="group-bracket"');expect(boxes[0].style.height).toBe('440px');
});
it('draws no overlay and leaves the paged DOM alone without groups or gaps',()=>{
 const {container}=mountContinuous(defaultEngraving());
 expect(container.querySelector('svg[data-tp-accolades]')).toBeNull();
 cleanup();
 const paged=mountPaged(defaultEngraving()),boxes=[...paged.container.querySelectorAll<HTMLElement>('.score-svg-chunk')];
 expect(boxes.map(box=>box.style.height)).toEqual(['400px','400px','400px']);expect(boxes.every(box=>!box.innerHTML.includes('<defs>')&&!box.innerHTML.includes('data-tp-accolade'))).toBe(true);
});
