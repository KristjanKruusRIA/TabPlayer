// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {Component,StrictMode,type ReactElement,type ReactNode} from 'react';
import {readFileSync} from 'node:fs';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {EngravingSettings,LayoutMode,NotationElement,Settings,SystemsLayoutMode,model,rendering,type PlaybackHighlightChangeEventArgs} from '@coderline/alphatab';
import {ScoreView} from './ScoreView';
import {music} from './editor/fixtures';
import type {EngravingOverrides,PageLayout} from './engraving/types';
import type {EngravingFonts} from './engraving/fonts';
import type {SystemSpan} from './engraving/system-gaps';
import type {ScoreLayoutMode} from './engraving/screen-view';
import {defaultEngraving,projectEngraving,type EngravingProjection} from './engraving/projection';
import {mergeSmuflMetadata} from './engraving/smufl';
import type {MusicFontData} from './engraving/font-loading';
import {planAccolades} from './engraving/accolades';
import {withStaffGaps,withStaffGroups} from './engraving/staff-groups';
import {threeTrackScore} from './engraving/staff-fixtures';
import {engravingRenderKey,withSystemGaps} from './engraving/system-gaps';
const state=vi.hoisted(()=>({music:((_id:string)=>new Promise<unknown>(()=>{})) as (id:string)=>Promise<unknown>,loadedMusic:new Map<string,unknown>(),roles:((_fonts?:unknown)=>new Promise<{failed:string[]}>(()=>{})) as (fonts?:unknown)=>Promise<{failed:string[]}>,fonts:(()=>new Promise<void>(()=>{})) as ()=>Promise<void>,api:null as unknown,width:900,height:700,resize:()=>{},loads:vi.fn(),renders:vi.fn(),chunkTops:[] as number[]}));
function event<T>(){const handlers=new Set<(e:T)=>void>();return {on:(fn:(e:T)=>void)=>{handlers.add(fn);return()=>handlers.delete(fn);},emit:(e:T)=>{for(const fn of handlers)fn(e);}};}
vi.mock('./engraving/font-loading',async original=>({...await original<typeof import('./engraving/font-loading')>(),loadRoleFaces:(fonts?:unknown)=>state.roles(fonts),
 loadMusicFont:(id:string)=>state.music(id).then(data=>{state.loadedMusic.set(id,data);return data;}),
 loadedMusicFont:(id:string)=>id==='bravura'?{id,families:['Bravura'],metadata:null,substituted:[]}:state.loadedMusic.get(id)??null}));
const boom=vi.hoisted(()=>({plan:false}));
vi.mock('./engraving/accolades',async original=>{const real=await original<typeof import('./engraving/accolades')>();return {...real,planAccolades:(...args:Parameters<typeof real.planAccolades>)=>{if(boom.plan)throw new Error('plan failed');return real.planAccolades(...args);}};});
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
function setup(layout:ScoreLayoutMode='verticalPage',zoom=100,extra:{page?:PageLayout;engraving?:EngravingOverrides;onSystems?:(systems:SystemSpan[]|null)=>void;onFontStatus?:(status:{failed:string[];substituted:string[]})=>void;wrap?:(node:ReactNode)=>ReactNode;score?:model.Score;projection?:EngravingProjection;trackIds?:readonly string[];visibleTracks?:number[]}={}){
 const {wrap=(node:ReactNode)=>node,...rest}=extra;
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.width:0;});
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.height:0;});
 vi.stubGlobal('ResizeObserver',class {constructor(fn:()=>void){state.resize=fn;}observe(){}disconnect(){}});
 const props={score:music(),track:0,zoom,profile:'ScoreTab',playback:null,onSelect:vi.fn(),page,display:{layout,zoomMode:'manual' as const},onDisplayStatus:vi.fn(),...rest};
 const tree=(p=props)=><div className="paper-scroll" style={{padding:10}}><div className="paper score-paper-host"><ScoreView {...p}/></div></div>;
 const result=render(wrap(tree()) as ReactElement);return {...result,props,tree,api:state.api as {settings:Settings;renderer:{width:number}}};
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();state.loads.mockClear();state.renders.mockClear();state.width=900;state.height=700;state.fonts=()=>new Promise<void>(()=>{});state.roles=()=>new Promise<{failed:string[]}>(()=>{});state.music=()=>new Promise<unknown>(()=>{});state.loadedMusic.clear();});
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

// ---- D12 role fonts: the first render waits for the chosen faces (Task 5) ----
const withFonts=(fonts:EngravingFonts):EngravingOverrides=>({...defaultEngraving(),fonts});
const serif:EngravingFonts={roles:{lyrics:{font:'notoSerif'}}},mono:EngravingFonts={roles:{lyrics:{font:'notoSansMono'}}};
const lyricsFamily=(api:{settings:Settings})=>api.settings.display.resources.elementFonts.get(NotationElement.EffectLyrics)!.families[0];
function deferred(){let resolve!:(value:{failed:string[]})=>void;const promise=new Promise<{failed:string[]}>(done=>{resolve=done;});return {promise,resolve};}
it('render_waits_for_role_faces_before_first_render',async()=>{
 const gate=deferred(),seen:unknown[]=[];state.roles=fonts=>{seen.push(fonts);return gate.promise;};
 const {api}=setup('verticalPage',100,{engraving:withFonts(serif)});
 expect(seen).toEqual([serif]);expect(state.loads).not.toHaveBeenCalled();expect(state.renders).not.toHaveBeenCalled();
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 expect(state.loads).toHaveBeenCalledTimes(1);
 // The fonts were configured when the render ran, after the faces were in.
 expect(lyricsFamily(api)).toBe('TabPlayer Serif');
});
it('default_documents_render_without_waiting_or_loading_roles',()=>{
 const roles=vi.fn(()=>new Promise<{failed:string[]}>(()=>{}));state.roles=roles;
 setup('verticalPage',100,{engraving:defaultEngraving()});
 expect(roles).not.toHaveBeenCalled();expect(state.loads).toHaveBeenCalledTimes(1);
 // A size-only role needs no face either.
 cleanup();state.loads.mockClear();
 setup('verticalPage',100,{engraving:withFonts({roles:{lyrics:{size:1.5}}})});
 expect(roles).not.toHaveBeenCalled();expect(state.loads).toHaveBeenCalledTimes(1);
});
it('fonts_change_rerenders_once',async()=>{
 const {props,tree,rerender,api}=setup('verticalPage',100,{engraving:defaultEngraving()});
 const renders=state.renders.mock.calls.length,gate=deferred();state.roles=()=>gate.promise;
 rerender(tree({...props,engraving:withFonts(serif)}));
 expect(state.renders).toHaveBeenCalledTimes(renders);
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 expect(state.renders).toHaveBeenCalledTimes(renders+1);expect(state.loads).toHaveBeenCalledTimes(1);expect(lyricsFamily(api)).toBe('TabPlayer Serif');
 // Choosing the same fonts again is the same render key, so nothing renders.
 rerender(tree({...props,engraving:withFonts(serif)}));
 await act(async()=>{await Promise.resolve();});
 expect(state.renders).toHaveBeenCalledTimes(renders+1);
});
it('a_slow_font_load_never_paints_an_older_choice',async()=>{
 const first=deferred(),second=deferred(),queue=[first,second];state.roles=()=>queue.shift()!.promise;
 const {props,tree,rerender,api}=setup('verticalPage',100,{engraving:withFonts(serif)});
 rerender(tree({...props,engraving:withFonts(mono)}));
 await act(async()=>{second.resolve({failed:[]});await second.promise;});
 expect(state.loads).toHaveBeenCalledTimes(1);expect(lyricsFamily(api)).toBe('TabPlayer Mono');
 const renders=state.renders.mock.calls.length;
 await act(async()=>{first.resolve({failed:[]});await first.promise;});
 expect(state.renders).toHaveBeenCalledTimes(renders);expect(lyricsFamily(api)).toBe('TabPlayer Mono');
});
it('a_load_that_ends_after_unmount_renders_nothing',async()=>{
 const gate=deferred();state.roles=()=>gate.promise;
 const {unmount}=setup('verticalPage',100,{engraving:withFonts(serif)});
 unmount();
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 expect(state.loads).not.toHaveBeenCalled();expect(state.renders).not.toHaveBeenCalled();
});
it('font_failures_are_reported_and_the_render_still_happens',async()=>{
 const gate=deferred(),status=vi.fn();state.roles=()=>gate.promise;
 setup('verticalPage',100,{engraving:withFonts(serif),onFontStatus:status});
 await act(async()=>{gate.resolve({failed:['NotoSerif-Italic.ttf']});await gate.promise;});
 expect(state.loads).toHaveBeenCalledTimes(1);expect(status).toHaveBeenLastCalledWith({failed:['NotoSerif-Italic.ttf'],substituted:[]});
});
it('page_overlay_uses_header_and_footer_role_fonts',async()=>{
 const gate=deferred();state.roles=()=>gate.promise;
 setup('verticalPage',100,{engraving:withFonts({roles:{pageHeader:{font:'notoSerif',bold:true,italic:true,size:1.5},pageFooter:{font:'notoSansMono'}}})});
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 const texts=[...screen.getAllByLabelText('Score page 1')[0].querySelectorAll('.score-page-text text')];
 expect(texts).toHaveLength(2);
 const [header,footer]=texts;
 expect(header.getAttribute('font-family')).toBe('TabPlayer Serif, Noto Sans, Noto Sans CJK JP, Noto Emoji');
 expect(header.getAttribute('font-weight')).toBe('700');expect(header.getAttribute('font-style')).toBe('italic');expect(header.getAttribute('font-size')).toBe('27');
 expect(footer.getAttribute('font-family')).toBe('TabPlayer Mono, Noto Sans, Noto Sans CJK JP, Noto Emoji');expect(footer.getAttribute('font-weight')).toBeNull();
});
it('page_overlay_keeps_the_default_stack_without_role_fonts',()=>{
 setup('verticalPage',100,{engraving:defaultEngraving()});
 const [header,footer]=[...screen.getAllByLabelText('Score page 1')[0].querySelectorAll('.score-page-text text')];
 for(const text of [header,footer]){expect(text.getAttribute('font-family')).toBe('Noto Sans, Noto Sans CJK JP, Noto Emoji');expect(text.getAttribute('font-weight')).toBeNull();expect(text.getAttribute('font-style')).toBeNull();}
 expect(header.getAttribute('font-size')).toBe('18');expect(footer.getAttribute('font-size')).toBe('11');
});

// ---- fix round 1: overlay-only header fonts, gated draw errors, StrictMode ----
it('a_header_or_footer_font_change_does_not_render_the_notation',async()=>{
 const seen:unknown[]=[];state.roles=fonts=>{seen.push(fonts);return Promise.resolve({failed:[]});};
 const {props,tree,rerender}=setup('verticalPage',100,{engraving:withFonts(serif)});
 await act(async()=>{await Promise.resolve();});
 const renders=state.renders.mock.calls.length,loads=state.loads.mock.calls.length;seen.length=0;
 rerender(tree({...props,engraving:withFonts({roles:{...serif.roles,pageHeader:{font:'notoSerif',bold:true,size:1.5},pageFooter:{font:'notoSansMono'}}})}));
 await act(async()=>{await Promise.resolve();});
 expect(state.renders).toHaveBeenCalledTimes(renders);expect(state.loads).toHaveBeenCalledTimes(loads);
 // Only the page roles' faces were requested, and the overlay now uses them.
 expect(seen).toEqual([{roles:{pageHeader:{font:'notoSerif',bold:true,size:1.5},pageFooter:{font:'notoSansMono'}}}]);
 const [header,footer]=[...screen.getAllByLabelText('Score page 1')[0].querySelectorAll('.score-page-text text')];
 expect(header.getAttribute('font-family')).toBe('TabPlayer Serif, Noto Sans, Noto Sans CJK JP, Noto Emoji');expect(header.getAttribute('font-size')).toBe('27');
 expect(footer.getAttribute('font-family')).toBe('TabPlayer Mono, Noto Sans, Noto Sans CJK JP, Noto Emoji');
 // Changing a screen role still renders.
 rerender(tree({...props,engraving:withFonts({roles:{lyrics:{font:'notoSansMono'},pageHeader:{font:'notoSerif',bold:true,size:1.5},pageFooter:{font:'notoSansMono'}}})}));
 await act(async()=>{await Promise.resolve();});
 expect(state.renders).toHaveBeenCalledTimes(renders+1);
});
it('an_overlay_font_load_that_ends_after_a_newer_choice_paints_nothing',async()=>{
 const first=deferred(),second=deferred(),queue=[first,second];state.roles=()=>queue.shift()!.promise;
 const {props,tree,rerender}=setup('verticalPage',100,{engraving:defaultEngraving()});
 rerender(tree({...props,engraving:withFonts({roles:{pageHeader:{font:'notoSerif'}}})}));
 rerender(tree({...props,engraving:withFonts({roles:{pageHeader:{font:'notoSansMono'}}})}));
 await act(async()=>{second.resolve({failed:[]});await second.promise;});
 const header=()=>screen.getAllByLabelText('Score page 1')[0].querySelector('.score-page-text text')!;
 expect(header().getAttribute('font-family')).toMatch(/^TabPlayer Mono/);
 await act(async()=>{first.resolve({failed:[]});await first.promise;});
 expect(header().getAttribute('font-family')).toMatch(/^TabPlayer Mono/);
});
class Catch extends Component<{children:ReactNode},{error:Error|null}>{
 state={error:null as Error|null};static getDerivedStateFromError(error:Error){return {error};}
 render(){return this.state.error?<p role="alert">{this.state.error.message}</p>:this.props.children;}
}
it('a_draw_error_after_the_faces_load_reaches_the_error_boundary_like_a_synchronous_one',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 // Without role fonts the effect throws during commit: the boundary shows it.
 state.loads.mockImplementationOnce(()=>{throw new Error('draw failed now');});
 setup('verticalPage',100,{engraving:defaultEngraving(),wrap:node=><Catch>{node}</Catch>});
 expect(screen.getByRole('alert').textContent).toBe('draw failed now');
 cleanup();
 // With role fonts the same throw happens after the load: it must not become an unhandled rejection.
 const unhandled=vi.fn();process.on('unhandledRejection',unhandled);
 const gate=deferred();state.roles=()=>gate.promise;
 state.loads.mockImplementationOnce(()=>{throw new Error('draw failed later');});
 setup('verticalPage',100,{engraving:withFonts(serif),wrap:node=><Catch>{node}</Catch>});
 expect(screen.queryByRole('alert')).toBeNull();
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 await new Promise(resolve=>setTimeout(resolve,0));
 process.off('unhandledRejection',unhandled);
 expect(screen.getByRole('alert').textContent).toBe('draw failed later');expect(unhandled).not.toHaveBeenCalled();
});
it('strict_mode_loads_once_and_renders_once_after_the_faces_arrive',async()=>{
 const gate=deferred();state.roles=()=>gate.promise;
 setup('verticalPage',100,{engraving:withFonts(serif),wrap:node=><StrictMode>{node}</StrictMode>});
 expect(state.loads).not.toHaveBeenCalled();expect(state.renders).not.toHaveBeenCalled();
 await act(async()=>{gate.resolve({failed:[]});await gate.promise;});
 expect(state.loads).toHaveBeenCalledTimes(1);expect(state.renders).toHaveBeenCalledTimes(1);
});
// ---- fix round 2: page header and footer face failures are reported ----
it('a_failed_page_font_face_is_reported_and_a_later_load_clears_it',async()=>{
 const first=deferred(),second=deferred(),queue=[first,second],status=vi.fn();state.roles=()=>queue.shift()!.promise;
 const {props,tree,rerender}=setup('verticalPage',100,{engraving:defaultEngraving(),onFontStatus:status});
 rerender(tree({...props,engraving:withFonts({roles:{pageHeader:{font:'notoSerif'}}})}));
 await act(async()=>{first.resolve({failed:['NotoSerif-Regular.ttf']});await first.promise;});
 expect(status).toHaveBeenLastCalledWith({failed:['NotoSerif-Regular.ttf'],substituted:[]});
 const reports=status.mock.calls.length;
 // The same choice again is not reported twice; a changed choice that loads clears the failure.
 rerender(tree({...props,engraving:withFonts({roles:{pageHeader:{font:'notoSansMono'}}})}));
 await act(async()=>{second.resolve({failed:[]});await second.promise;});
 expect(status).toHaveBeenCalledTimes(reports+1);expect(status).toHaveBeenLastCalledWith({failed:[],substituted:[]});
});
it('notation_and_page_font_failures_are_reported_together_and_independently',async()=>{
 const notation=deferred(),page=deferred(),status=vi.fn();
 state.roles=fonts=>(fonts as EngravingFonts).roles?.lyrics?notation.promise:page.promise;
 setup('verticalPage',100,{engraving:withFonts({roles:{...serif.roles,pageFooter:{font:'notoSansMono'}}}),onFontStatus:status});
 await act(async()=>{page.resolve({failed:['NotoSansMono-Regular.ttf']});await page.promise;});
 expect(status).toHaveBeenLastCalledWith({failed:['NotoSansMono-Regular.ttf'],substituted:[]});
 await act(async()=>{notation.resolve({failed:['NotoSerif-Italic.ttf']});await notation.promise;});
 expect(status).toHaveBeenLastCalledWith({failed:['NotoSerif-Italic.ttf','NotoSansMono-Regular.ttf'],substituted:[]});
});

// ---- Task 6: the music font on screen ----
const withMusic=(music:'bravura'|'petaluma'|'leland',extra:Partial<EngravingOverrides>={}):EngravingOverrides=>({...defaultEngraving(),...extra,fonts:{music}});
const petalumaData=():MusicFontData=>{
 const {metadata,substituted}=mergeSmuflMetadata(JSON.parse(readFileSync('assets/fonts/petaluma_metadata.json','utf8')),EngravingSettings.bravuraMetadata);
 return {id:'petaluma',families:['Petaluma','TabPlayer Bravura'],metadata,substituted};
};
const musicRoot=(container:HTMLElement)=>container.querySelector('.score-presentation')!;
function deferredMusic(){let resolve!:(value:MusicFontData)=>void,reject!:(error:Error)=>void;const promise=new Promise<MusicFontData>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
const noteheadWidth=(api:{settings:Settings})=>api.settings.display.resources.engravingSettings.glyphWidths.get(0xE0A4 as never) /* MusicFontSymbol.NoteheadBlack, which alphaTab does not export */;

const musicRules=()=>{
 const css=readFileSync('src/ScoreView.css','utf8').replace(/\/\*[\s\S]*?\*\//g,''),rules=new Map<string,{selector:string;body:string}>();
 for(const match of css.matchAll(/([^{}]*\[data-music-font="(\w+)"\][^{}]*)\{([^}]*)\}/g))rules.set(match[2],{selector:match[1].trim(),body:match[3]});
 return rules;
};
/** (ids, classes and attributes, elements) of a selector made of compound selectors and descendant combinators, enough for these rules. */
const specificity=(selector:string)=>[(selector.match(/#/g)??[]).length,(selector.match(/\.[\w-]+|\[[^\]]+\]/g)??[]).length,(selector.replace(/\[[^\]]*\]/g,'').match(/(^|[\s>+~])[a-z][\w-]*/gi)??[]).length];
it('music_font_css_rule_targets_surface_and_chunks',()=>{
 const rules=musicRules();
 expect([...rules.keys()].sort()).toEqual(['leland','petaluma']);
 for(const [id,{selector,body}] of rules){
  expect(body).toMatch(new RegExp(`font-family:\\s*${id[0].toUpperCase()+id.slice(1)},\\s*'TabPlayer Bravura'\\s*;`));
  // alphaTab registers `.at-surface.at<N> .at` (0,3,0), once per API instance; the app rule has to win without !important.
  const alphaTab=specificity('.at-surface.at3 .at'),mine=specificity(selector);
  expect(alphaTab).toEqual([0,3,0]);
  expect(mine[0]).toBe(0);expect(mine[1]).toBeGreaterThan(alphaTab[1]);
  expect(selector).toBe(`.score-presentation[data-music-font="${id}"] .at-surface .at`);
  expect(body).not.toMatch(/!important|font-size/);
  // The same rule applies inside the live surface and inside the page chunks, which sit under the root with alphaTab's surface classes.
  document.body.innerHTML=`<div class="score-presentation" data-music-font="${id}"><div class="at-surface at"><svg><g class="at"></g></svg></div><div class="score-pages at-surface at"><div class="score-svg-chunk at-surface-svg"><svg><g class="at"></g></svg></div></div></div>`;
  const hits=[...document.querySelectorAll(selector)];
  expect(hits).toHaveLength(2);expect(hits.every(node=>node.classList.contains('at')&&node.tagName.toLowerCase()==='g')).toBe(true);
  // Another font id, and no choice at all, do not match.
  document.body.innerHTML=`<div class="score-presentation" data-music-font="other"><div class="at-surface at"><g class="at"></g></div></div><div class="score-presentation"><div class="at-surface at"><g class="at"></g></div></div>`;
  expect(document.querySelectorAll(selector)).toHaveLength(0);
 }
 document.body.innerHTML='';
});
it('the_root_names_the_music_font_only_after_it_is_drawn',async()=>{
 const gate=deferredMusic();state.music=()=>gate.promise;
 const {container}=setup('verticalPage',100,{engraving:withMusic('petaluma')});
 // Nothing is drawn, and nothing claims Petaluma, until the metadata the layout needs is in.
 expect(state.renders).not.toHaveBeenCalled();expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
 await act(async()=>{gate.resolve(petalumaData());await gate.promise;});
 expect(state.loads).toHaveBeenCalledTimes(1);expect(musicRoot(container).getAttribute('data-music-font')).toBe('petaluma');
});
it('bravura_documents_render_without_waiting_or_loading_music',()=>{
 const music=vi.fn(()=>new Promise<unknown>(()=>{}));state.music=music;
 const {container}=setup('verticalPage',100,{engraving:withMusic('bravura')});
 expect(music).not.toHaveBeenCalled();expect(state.loads).toHaveBeenCalledTimes(1);expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
});
it('music_change_rerenders_after_load',async()=>{
 const {props,tree,rerender,api,container}=setup('verticalPage',100,{engraving:defaultEngraving()});
 const renders=state.renders.mock.calls.length,gate=deferredMusic(),loadMusic=vi.fn(()=>gate.promise);state.music=loadMusic;
 const bravuraWidth=noteheadWidth(api);
 rerender(tree({...props,engraving:withMusic('petaluma')}));
 expect(loadMusic).toHaveBeenCalledWith('petaluma');expect(state.renders).toHaveBeenCalledTimes(renders);
 const data=petalumaData();
 await act(async()=>{gate.resolve(data);await gate.promise;});
 expect(state.renders).toHaveBeenCalledTimes(renders+1);expect(state.loads).toHaveBeenCalledTimes(1);
 // Layout uses the merged metadata: the notehead is Petaluma's width, not Bravura's.
 expect(noteheadWidth(api)).not.toBe(bravuraWidth);expect(musicRoot(container).getAttribute('data-music-font')).toBe('petaluma');
 // Back to Bravura renders at once and restores Bravura's metrics.
 rerender(tree({...props,engraving:defaultEngraving()}));
 expect(state.renders).toHaveBeenCalledTimes(renders+2);expect(noteheadWidth(api)).toBe(bravuraWidth);expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
 expect(api.settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);
 // A font that is already loaded is drawn without waiting or loading it again.
 rerender(tree({...props,engraving:withMusic('petaluma')}));
 expect(loadMusic).toHaveBeenCalledTimes(1);expect(state.renders).toHaveBeenCalledTimes(renders+3);expect(musicRoot(container).getAttribute('data-music-font')).toBe('petaluma');
});
it('a_view_without_engraving_returns_to_bravura_metrics',async()=>{
 const {props,tree,rerender,api,container}=setup('verticalPage',100,{engraving:defaultEngraving()});
 const gate=deferredMusic();state.music=()=>gate.promise;
 rerender(tree({...props,engraving:withMusic('petaluma')}));
 await act(async()=>{gate.resolve(petalumaData());await gate.promise;});
 expect(api.settings.display.resources.engravingSettings).not.toEqual(EngravingSettings.bravuraDefaults);
 // With no engraving at all configureEngraving is skipped, so the Petaluma metrics would stay behind unless they are reset here.
 rerender(tree({...props,engraving:undefined}));
 expect(api.settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
});
it('a_slow_music_load_never_paints_an_older_choice',async()=>{
 const slow=deferredMusic(),loads=[slow];state.music=()=>loads.shift()!.promise;
 const {props,tree,rerender,api,container}=setup('verticalPage',100,{engraving:withMusic('petaluma')});
 rerender(tree({...props,engraving:withMusic('bravura',{systemSpacing:1.5})}));
 expect(state.loads).toHaveBeenCalledTimes(1);
 const renders=state.renders.mock.calls.length;
 await act(async()=>{slow.resolve(petalumaData());await slow.promise;});
 expect(state.renders).toHaveBeenCalledTimes(renders);expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
 expect(api.settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);
});
it('music_substitutions_are_reported_with_the_font_status',async()=>{
 const gate=deferredMusic(),status=vi.fn();state.music=()=>gate.promise;
 setup('verticalPage',100,{engraving:withMusic('petaluma'),onFontStatus:status});
 const data=petalumaData();
 await act(async()=>{gate.resolve(data);await gate.promise;});
 expect(data.substituted.length).toBeGreaterThan(0);expect(status).toHaveBeenLastCalledWith({failed:[],substituted:data.substituted});
});
it('music_load_failure_falls_back_to_bravura_and_is_reported',async()=>{
 const status=vi.fn(),failing=deferredMusic();state.music=()=>failing.promise;
 const {props,tree,rerender,api,container}=setup('verticalPage',100,{engraving:withMusic('petaluma'),onFontStatus:status});
 await act(async()=>{failing.reject(new Error('metadata missing'));await failing.promise.catch(()=>{});});
 // The score still renders, with Bravura's metrics and no Petaluma claim, and the panel hears about it.
 expect(state.loads).toHaveBeenCalledTimes(1);
 expect(api.settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);expect(musicRoot(container).getAttribute('data-music-font')).toBeNull();
 expect(status).toHaveBeenLastCalledWith({failed:['Petaluma.otf'],substituted:[]});
 // The next change tries again, and a load that works clears the failure.
 const retry=deferredMusic(),loadMusic=vi.fn(()=>retry.promise);state.music=loadMusic;
 rerender(tree({...props,engraving:withMusic('petaluma',{systemSpacing:1.5})}));
 expect(loadMusic).toHaveBeenCalledWith('petaluma');
 const data=petalumaData();
 await act(async()=>{retry.resolve(data);await retry.promise;});
 expect(status).toHaveBeenLastCalledWith({failed:[],substituted:data.substituted});expect(musicRoot(container).getAttribute('data-music-font')).toBe('petaluma');
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
it('a staff gap is not drawn without a projection, as the prop says',()=>{
 const {container}=mountPaged(withStaffGaps(defaultEngraving(),[{trackId:'base/0',scale:2}]),{projection:undefined});
 const boxes=[...container.querySelectorAll<HTMLElement>('.score-svg-chunk')];
 expect(boxes.map(box=>box.style.height)).toEqual(['400px','400px','400px']);
});
it('a throw while planning accolades falls back to no plan and draws no overlay',()=>{
 boom.plan=true;
 try{
  const {container,view,projection}=mountContinuous(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
  expect(container.querySelector('svg[data-tp-accolades]')).toBeNull();
  expect(view().settings.display.systemLabelPaddingRight).toBe(3);
  expect(projection().score.stylesheet.bracketExtendMode).toBe(projection().bracketMode);
 }finally{boom.plan=false;}
});
it('the continuous overlay disappears once the last group is removed',()=>{
 const {container,rerender}=mountContinuous(withStaffGroups(defaultEngraving(),[{trackIds:['base/0','base/1'],kind:'bracket'}]));
 expect(container.querySelector('svg[data-tp-accolades]')).not.toBeNull();
 rerender(defaultEngraving());
 expect(container.querySelector('svg[data-tp-accolades]')).toBeNull();
});
