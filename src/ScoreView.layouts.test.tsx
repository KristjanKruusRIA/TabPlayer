// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {StrictMode} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LayoutMode,Settings,SystemsLayoutMode,model,rendering,type PlaybackHighlightChangeEventArgs} from '@coderline/alphatab';
import {ScoreView} from './ScoreView';
import {music} from './editor/fixtures';
import type {PageLayout} from './engraving/types';
import type {ScoreLayoutMode} from './engraving/screen-view';
const state=vi.hoisted(()=>({api:null as unknown,width:900,height:700,resize:()=>{},loads:vi.fn(),renders:vi.fn()}));
function event<T>(){const handlers=new Set<(e:T)=>void>();return {on:(fn:(e:T)=>void)=>{handlers.add(fn);return()=>handlers.delete(fn);},emit:(e:T)=>{for(const fn of handlers)fn(e);}};}
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
 settings=new Settings();score:model.Score|null=null;constructor(){state.api=this;}
 beatMouseDown=event<model.Beat>();noteMouseDown=event<model.Note>();beatMouseMove=event<model.Beat>();beatMouseUp=event<void>();renderStarted=event<void>();postRenderFinished=event<void>();playbackRangeHighlightChanged=event<PlaybackHighlightChangeEventArgs>();
 renderer={width:0,partialRenderFinished:event<unknown>()};boundsLookup={staffSystems:[] as rendering.StaffSystemBounds[],findBeats:(beat:model.Beat)=>this.boundsLookup.staffSystems.flatMap(s=>s.bars.flatMap(m=>m.bars.flatMap(b=>b.beats))).filter(b=>b.beat===beat),findBeat:(beat:model.Beat)=>this.boundsLookup.findBeats(beat)[0],getBeatAtPos:()=>null};
 uiFacade={getOffset:()=>({x:0,y:0}),highlightElements(){},removeHighlights(){}};canvasElement={};customCursorHandler=undefined;customScrollHandler=undefined;
 updateSettings(){} destroy(){}
 highlightPlaybackRange(start:model.Beat,end:model.Beat){const first=this.boundsLookup.findBeat(start),last=this.boundsLookup.findBeat(end);if(first&&last)this.playbackRangeHighlightChanged.emit({startBeat:start,endBeat:end,startBeatBounds:first,endBeatBounds:last,highlightBlocks:this.boundsLookup.staffSystems.filter(s=>s.bars[0].index>=start.voice.bar.index&&s.bars[0].index<=end.voice.bar.index).map(s=>s.realBounds)});}
 clearPlaybackRangeHighlight(){this.playbackRangeHighlightChanged.emit({});}
 renderScore(score:model.Score){state.loads();this.score=score;this.render();}
 render(){state.renders();this.renderStarted.emit();const score=this.score;if(!score)return;this.boundsLookup.staffSystems=[];
 for(let i=0;i<3;i++){
 const s=new rendering.StaffSystemBounds(),m=new rendering.MasterBarBounds(),b=new rendering.BarBounds(),beat=new rendering.BeatBounds(),note=new rendering.NoteBounds();
 s.realBounds=s.visualBounds=new rendering.Bounds(0,i*450,500,400);s.bars=[m];m.index=i;m.staffSystemBounds=s;m.bars=[b];m.realBounds=m.visualBounds=s.realBounds;b.masterBarBounds=m;b.realBounds=b.visualBounds=s.realBounds;b.beats=[beat];beat.barBounds=b;beat.beat=score.tracks[0].staves[0].bars[i].voices[0].beats[0];beat.realBounds=beat.visualBounds=new rendering.Bounds(50,i*450+40,60,60);note.note=beat.beat.notes[0];note.noteHeadBounds=new rendering.Bounds(60,i*450+50,12,12);beat.notes=[note];this.boundsLookup.staffSystems.push(s);
 this.renderer.partialRenderFinished.emit({id:`chunk-${i}`,x:0,y:i*450,width:500,height:400,firstMasterBarIndex:i,lastMasterBarIndex:i,renderResult:'<svg><text>Notes</text></svg>'});
 }this.postRenderFinished.emit();}
}}));
const page:PageLayout={widthMm:210,heightMm:210,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document'};
function setup(layout:ScoreLayoutMode='verticalPage',zoom=100){
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.width:0;});
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('paper-scroll')?state.height:0;});
 vi.stubGlobal('ResizeObserver',class {constructor(fn:()=>void){state.resize=fn;}observe(){}disconnect(){}});
 const props={score:music(),track:0,zoom,profile:'ScoreTab',playback:null,onSelect:vi.fn(),page,display:{layout,zoomMode:'manual' as const},onDisplayStatus:vi.fn()};
 const tree=(p=props)=><div className="paper-scroll" style={{padding:10}}><div className="paper score-paper-host"><ScoreView {...p}/></div></div>;
 const result=render(tree());return {...result,props,tree,api:state.api as {settings:Settings;renderer:{width:number}}};
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();state.loads.mockClear();state.renders.mockClear();state.width=900;state.height=700;});
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
