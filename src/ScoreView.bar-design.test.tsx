// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { rendering, Settings, type model } from '@coderline/alphatab';
import { ScoreView, type BarDesign } from './ScoreView';
import { music } from './editor/fixtures';
import { defaultEngraving } from './engraving/projection';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
const view=vi.hoisted(()=>({api:null as unknown}));
const systems=(count:number)=>count?[{realBounds:new rendering.Bounds(0,0,400,100),bars:Array.from({length:count},(_,index)=>({index,realBounds:new rendering.Bounds(index*200,0,200,100)}))}]:[];
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings=new Settings();constructor(){view.api=this;}
  beatMouseDown=event();noteMouseDown=event();beatMouseMove=event();beatMouseUp=event();renderStarted=event();postRenderFinished=event();playbackRangeHighlightChanged=event();
  canvasElement={};uiFacade={getOffset:()=>({x:30,y:40,w:600,h:300}),highlightElements(){},removeHighlights(){}};
  renderer={width:0,partialRenderFinished:event()};renderScore(){}render(){}
  boundsLookup={findBeat:()=>null,findBeats:()=>[],getBeatAtPos:()=>null,staffSystems:[{realBounds:new rendering.Bounds(0,0,400,100),bars:[0,1,2].map(index=>({index,realBounds:new rendering.Bounds(index*200,0,200,100)}))}]};
  highlightPlaybackRange(){}clearPlaybackRangeHighlight(){}destroy(){}updateSettings(){}
}}));
function event(){const handlers=new Set<(value:unknown)=>void>();return {handlers,on:(handler:(value:unknown)=>void)=>{handlers.add(handler);return()=>handlers.delete(handler);},off:(handler:(value:unknown)=>void)=>{handlers.delete(handler);},emit:(value:unknown)=>{for(const handler of [...handlers])handler(value);}};}
type Fake={boundsLookup:{staffSystems:unknown};postRenderFinished:{emit:(value:unknown)=>void}};
const saved=new Map<number,number>(),imported=new Map<number,number>();
beforeAll(()=>{
  // jsdom has no pointer events; carry the fields the handle reads.
  if(typeof window.PointerEvent==='undefined')Object.defineProperty(window,'PointerEvent',{configurable:true,value:class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}}});
});
afterEach(()=>{cleanup();vi.clearAllMocks();saved.clear();imported.clear();});

const design=(over:Partial<BarDesign>={}):BarDesign=>({busy:false,scaleOf:(bar:number)=>saved.get(bar)??imported.get(bar)??1,defaultOf:(bar:number)=>imported.get(bar)??1,onScale:vi.fn(),...over});
function setup(options:{busy?:boolean;design?:boolean;layout?:'parchment'|'verticalScreen'|'horizontalScreen'}={}) {
  const barDesign=options.design===false?null:design({busy:!!options.busy}),score:model.Score=music(),onKey=vi.fn();
  const props=(next:BarDesign|null,scoreValue=score)=><div onKeyDown={onKey}><ScoreView score={scoreValue} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={vi.fn()} barDesign={next} display={{layout:options.layout??'parchment',zoomMode:'manual'}}/></div>;
  const result=render(props(barDesign));
  return {barDesign,onScale:barDesign?.onScale as ReturnType<typeof vi.fn>,score,onKey,again:(next:BarDesign|null,scoreValue?:model.Score)=>result.rerender(props(next,scoreValue)),...result};
}
const pointer=(type:'pointerDown'|'pointerMove'|'pointerUp'|'pointerCancel',element:Element,init:Record<string,unknown>={})=>fireEvent[type](element,{pointerId:1,button:0,buttons:type==='pointerUp'?0:1,...init});
const bar1=()=>screen.getByRole('slider',{name:'Bar 1 width'});
const guide=(element:Element)=>element.querySelector('.score-bar-guide');

it('puts one width handle on the right edge of each bar, only in design mode and in layouts that size bars by weight',()=>{
  setup();
  const handles=screen.getAllByRole('slider');expect(handles.map(h=>h.getAttribute('aria-label'))).toEqual(['Bar 1 width','Bar 2 width','Bar 3 width']);
  expect(handles.map(h=>h.style.left)).toEqual(['225px','425px','625px']);expect(handles[0].getAttribute('aria-valuenow')).toBe('100');
  cleanup();setup({design:false});expect(screen.queryAllByRole('slider')).toHaveLength(0);
  cleanup();setup({layout:'verticalScreen'});expect(screen.queryAllByRole('slider')).toHaveLength(0);
  cleanup();setup({layout:'horizontalScreen'});expect(screen.queryAllByRole('slider')).toHaveLength(0);
});

it('shows the weight a bar has, including one an imported score gave it',()=>{
  saved.set(1,1.5);imported.set(2,2);setup();
  expect(screen.getByRole('slider',{name:'Bar 2 width'}).getAttribute('aria-valuenow')).toBe('150');
  const third=screen.getByRole('slider',{name:'Bar 3 width'});expect(third.getAttribute('aria-valuenow')).toBe('200');expect(third.getAttribute('aria-valuetext')).toBe('200% of the standard width, imported 200%');
});

it('moves between bars with Left and Right, with one tab stop, and changes width with Shift+arrows',()=>{
  const {onScale}=setup();const [one,two,three]=screen.getAllByRole('slider');
  expect([one,two,three].map(h=>h.tabIndex)).toEqual([0,-1,-1]);
  one.focus();fireEvent.keyDown(one,{key:'ArrowRight'});expect(document.activeElement).toBe(two);expect([one,two,three].map(h=>h.tabIndex)).toEqual([-1,0,-1]);
  fireEvent.keyDown(two,{key:'End'});expect(document.activeElement).toBe(three);fireEvent.keyDown(three,{key:'ArrowRight'});expect(document.activeElement).toBe(three);
  fireEvent.keyDown(three,{key:'Home'});expect(document.activeElement).toBe(one);expect(onScale).not.toHaveBeenCalled();
  fireEvent.keyDown(one,{key:'ArrowRight',shiftKey:true});expect(onScale).toHaveBeenLastCalledWith(0,1.1);
  fireEvent.keyDown(one,{key:'ArrowLeft',shiftKey:true});expect(onScale).toHaveBeenLastCalledWith(0,.9);
  fireEvent.keyDown(one,{key:'PageUp'});expect(onScale).toHaveBeenLastCalledWith(0,1.5);fireEvent.keyDown(one,{key:'PageDown'});expect(onScale).toHaveBeenLastCalledWith(0,.5);
  expect(onScale).toHaveBeenCalledTimes(4);
});

it('records nothing at a limit, at the current value, or for a modified or unrelated key',()=>{
  const {onScale}=setup();const bar=bar1();bar.focus();
  fireEvent.keyDown(bar,{key:'Delete'});expect(onScale).not.toHaveBeenCalled();
  fireEvent.keyDown(bar,{key:'a'});fireEvent.keyDown(bar,{key:'ArrowRight',shiftKey:true,ctrlKey:true});expect(onScale).not.toHaveBeenCalled();
  saved.set(0,.25);fireEvent.keyDown(bar,{key:'ArrowLeft',shiftKey:true});expect(onScale).not.toHaveBeenCalled();
  saved.set(0,4);fireEvent.keyDown(bar,{key:'PageUp'});expect(onScale).not.toHaveBeenCalled();
  saved.set(0,1.5);fireEvent.keyDown(bar,{key:'Delete'});expect(onScale).toHaveBeenLastCalledWith(0,1);
});

it('reaches the default width of an imported bar, not 1',()=>{
  imported.set(0,2);saved.set(0,3);const {onScale}=setup();
  fireEvent.keyDown(bar1(),{key:'Delete'});expect(onScale).toHaveBeenLastCalledWith(0,2);
  saved.delete(0);onScale.mockClear();fireEvent.keyDown(bar1(),{key:'Backspace'});expect(onScale).not.toHaveBeenCalled();
  fireEvent.keyDown(bar1(),{key:'ArrowRight',shiftKey:true});expect(onScale).toHaveBeenLastCalledWith(0,2.1);
});

it('keeps keys the handle uses or ignores away from the score, but lets Tab, Escape and modified keys through',()=>{
  const {onKey}=setup();const bar=bar1();bar.focus();
  for(const key of ['Enter','5','ArrowUp','ArrowRight','Delete','a',' '])fireEvent.keyDown(bar,{key});
  expect(onKey).not.toHaveBeenCalled();
  fireEvent.keyDown(bar,{key:'Tab'});fireEvent.keyDown(bar,{key:'Escape'});fireEvent.keyDown(bar,{key:'z',ctrlKey:true});expect(onKey).toHaveBeenCalledTimes(3);
});

it('records one edit for a whole drag, at its release, and none for an empty drag or other button',()=>{
  const {onScale}=setup();const bar=bar1();
  pointer('pointerDown',bar,{clientX:100});for(const x of [110,140,150])pointer('pointerMove',bar,{clientX:x});
  expect(onScale).not.toHaveBeenCalled();expect(guide(bar)).not.toBeNull();
  pointer('pointerUp',bar);expect(onScale).toHaveBeenCalledTimes(1);expect(onScale).toHaveBeenCalledWith(0,1.25);expect(guide(bar)).toBeNull();
  pointer('pointerMove',bar,{clientX:300});pointer('pointerUp',bar);expect(onScale).toHaveBeenCalledTimes(1);
  pointer('pointerDown',bar,{clientX:100});pointer('pointerUp',bar);
  pointer('pointerDown',bar,{clientX:100});pointer('pointerMove',bar,{clientX:150});pointer('pointerMove',bar,{clientX:100});pointer('pointerUp',bar);
  pointer('pointerDown',bar,{clientX:100,button:2});pointer('pointerMove',bar,{clientX:150});pointer('pointerUp',bar);
  expect(onScale).toHaveBeenCalledTimes(1);
  pointer('pointerDown',bar,{clientX:300});pointer('pointerMove',bar,{clientX:-5000});pointer('pointerUp',bar);expect(onScale).toHaveBeenLastCalledWith(0,.25);
});

it('abandons a drag on Escape, blur, window blur, pointer cancel, lost capture, a missed release and unmount',()=>{
  const {onScale,unmount}=setup();let bar=bar1();
  const start=()=>{bar=bar1();pointer('pointerDown',bar,{clientX:100});pointer('pointerMove',bar,{clientX:160});expect(guide(bar)).not.toBeNull();};
  const finishes=()=>{pointer('pointerUp',bar);expect(guide(bar)).toBeNull();expect(onScale).not.toHaveBeenCalled();};
  start();fireEvent.keyDown(document,{key:'Escape'});finishes();
  start();act(()=>{bar.blur();});finishes();
  start();act(()=>{window.dispatchEvent(new Event('blur'));});finishes();
  start();pointer('pointerCancel',bar);finishes();
  start();fireEvent.lostPointerCapture(bar,{pointerId:1});finishes();
  // The button was let go in another window: the next move has no button down, and the click after it must not commit.
  start();pointer('pointerMove',bar,{clientX:200,buttons:0});finishes();
  start();unmount();expect(onScale).not.toHaveBeenCalled();
});

it('ends a drag unrecorded when the score turns busy or its document or width changes mid-drag',()=>{
  const state=setup();const bar=bar1();
  pointer('pointerDown',bar,{clientX:100});pointer('pointerMove',bar,{clientX:160});
  state.again(design({busy:true,onScale:state.onScale as BarDesign['onScale']}));expect(guide(bar1())).toBeNull();pointer('pointerUp',bar1());
  state.again(design({onScale:state.onScale as BarDesign['onScale']}));
  pointer('pointerDown',bar1(),{clientX:100});pointer('pointerMove',bar1(),{clientX:160});
  state.again(design({onScale:state.onScale as BarDesign['onScale']}),music());expect(guide(bar1())).toBeNull();pointer('pointerUp',bar1());
  const next=design({onScale:state.onScale as BarDesign['onScale']});
  pointer('pointerDown',bar1(),{clientX:100});pointer('pointerMove',bar1(),{clientX:160});
  saved.set(0,1.7);state.again(next);pointer('pointerUp',bar1());
  expect(state.onScale).not.toHaveBeenCalled();
});

it('refuses width changes while busy without disabling the handle, so it keeps focus',()=>{
  const {onScale,onKey}=setup({busy:true});const bar=bar1();bar.focus();
  expect(bar.hasAttribute('disabled')).toBe(false);expect(bar.getAttribute('aria-disabled')).toBe('true');expect(bar.className).toContain('is-disabled');
  fireEvent.keyDown(bar,{key:'ArrowRight',shiftKey:true});fireEvent.keyDown(bar,{key:'Delete'});fireEvent.keyDown(bar,{key:'Enter'});
  pointer('pointerDown',bar,{clientX:100});pointer('pointerMove',bar,{clientX:200});pointer('pointerUp',bar);
  expect(onScale).not.toHaveBeenCalled();expect(onKey).not.toHaveBeenCalled();expect(document.activeElement).toBe(bar);expect(guide(bar)).toBeNull();
  // Moving between bars is not an edit and still works.
  fireEvent.keyDown(bar,{key:'ArrowRight'});expect(document.activeElement).toBe(screen.getByRole('slider',{name:'Bar 2 width'}));
});

it('puts focus back on the bar after an accepted edit even when the handles are rebuilt',()=>{
  const {onScale}=setup(),api=view.api as Fake;let bar=screen.getByRole('slider',{name:'Bar 2 width'});
  bar.focus();fireEvent.keyDown(bar,{key:'ArrowRight',shiftKey:true});expect(onScale).toHaveBeenCalledWith(1,1.1);
  const good=api.boundsLookup.staffSystems;
  // The page layout re-paginates: no handle can be placed, then they return.
  api.boundsLookup.staffSystems=systems(0);act(()=>api.postRenderFinished.emit(undefined));
  expect(screen.queryAllByRole('slider')).toHaveLength(0);expect(document.activeElement).toBe(document.body);
  api.boundsLookup.staffSystems=good;act(()=>api.postRenderFinished.emit(undefined));
  bar=screen.getByRole('slider',{name:'Bar 2 width'});expect(document.activeElement).toBe(bar);
  // Once the user has moved elsewhere, focus is not pulled back.
  fireEvent.keyDown(bar,{key:'ArrowRight',shiftKey:true});api.boundsLookup.staffSystems=systems(0);act(()=>api.postRenderFinished.emit(undefined));
  const other=document.createElement('button');document.body.append(other);other.focus();
  api.boundsLookup.staffSystems=good;act(()=>api.postRenderFinished.emit(undefined));expect(document.activeElement).toBe(other);other.remove();
});

it('keeps the handle focused through a render that does not move it',()=>{
  const {onScale}=setup(),api=view.api as Fake,bar=bar1();bar.focus();
  fireEvent.keyDown(bar,{key:'PageUp'});expect(onScale).toHaveBeenCalledTimes(1);
  act(()=>api.postRenderFinished.emit(undefined));expect(document.activeElement).toBe(bar1());
  expect(defaultEngraving().barWidths).toBeUndefined();
});

it('keeps Enter, even with Ctrl or Alt, out of note entry',()=>{
  const {onKey}=setup();const bar=bar1();bar.focus();
  for(const init of [{},{ctrlKey:true},{altKey:true},{metaKey:true}])fireEvent.keyDown(bar,{key:'Enter',...init});
  expect(onKey).not.toHaveBeenCalled();
});

it('moves focus to the nearest remaining bar when the focused bar disappears',()=>{
  setup();const api=view.api as Fake,good=api.boundsLookup.staffSystems,three=screen.getByRole('slider',{name:'Bar 3 width'});
  three.focus();api.boundsLookup.staffSystems=systems(2);act(()=>api.postRenderFinished.emit(undefined));
  expect(screen.queryByRole('slider',{name:'Bar 3 width'})).toBeNull();expect(document.activeElement).toBe(screen.getByRole('slider',{name:'Bar 2 width'}));
  api.boundsLookup.staffSystems=good;
});
