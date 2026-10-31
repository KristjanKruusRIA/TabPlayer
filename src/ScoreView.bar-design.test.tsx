// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { rendering, Settings, type model } from '@coderline/alphatab';
import { ScoreView, type BarDesign } from './ScoreView';
import { music } from './editor/fixtures';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
const view=vi.hoisted(()=>({api:null as unknown}));
vi.mock('@coderline/alphatab',async original=>({...await original<typeof import('@coderline/alphatab')>(),AlphaTabApi:class {
  settings=new Settings();constructor(){view.api=this;}
  beatMouseDown=event();noteMouseDown=event();beatMouseMove=event();beatMouseUp=event();renderStarted=event();postRenderFinished=event();playbackRangeHighlightChanged=event();
  canvasElement={};uiFacade={getOffset:()=>({x:30,y:40,w:600,h:300}),highlightElements(){},removeHighlights(){}};
  renderer={width:0,partialRenderFinished:event()};renderScore(){}render(){}
  boundsLookup={findBeat:()=>null,findBeats:()=>[],getBeatAtPos:()=>null,staffSystems:[{realBounds:new rendering.Bounds(0,0,400,100),bars:[0,1].map(index=>({index,realBounds:new rendering.Bounds(index*200,0,200,100)}))}]};
  highlightPlaybackRange(){}clearPlaybackRangeHighlight(){}destroy(){}updateSettings(){}
}}));
function event(){const handlers=new Set<(value:unknown)=>void>();return {handlers,on:(handler:(value:unknown)=>void)=>{handlers.add(handler);return()=>handlers.delete(handler);},off:(handler:(value:unknown)=>void)=>{handlers.delete(handler);},emit:(value:unknown)=>{for(const handler of [...handlers])handler(value);}};}
afterEach(()=>{cleanup();vi.clearAllMocks();});

const scores=new Map<number,number>();
function setup(options:{busy?:boolean;design?:boolean;layout?:'parchment'|'verticalScreen'|'horizontalScreen'|'verticalPage'}={}) {
  const onScale=vi.fn(),barDesign:BarDesign|null=options.design===false?null:{busy:!!options.busy,scaleOf:bar=>scores.get(bar)??1,onScale};
  const score:model.Score=music();
  const result=render(<ScoreView score={score} track={0} zoom={100} profile="ScoreTab" playback={null} onSelect={vi.fn()} barDesign={barDesign} display={{layout:options.layout??'parchment',zoomMode:'manual'}}/>);
  return {onScale,...result};
}
afterEach(()=>scores.clear());

it('puts one width handle on the right edge of each bar, only in design mode and in layouts that size bars by weight',()=>{
  setup();
  const handles=screen.getAllByRole('slider');expect(handles.map(h=>h.getAttribute('aria-label'))).toEqual(['Bar 1 width','Bar 2 width']);
  expect(handles.map(h=>h.style.left)).toEqual(['225px','425px']);expect(handles[0].getAttribute('aria-valuenow')).toBe('100');
  cleanup();setup({design:false});expect(screen.queryAllByRole('slider')).toHaveLength(0);
  cleanup();setup({layout:'verticalScreen'});expect(screen.queryAllByRole('slider')).toHaveLength(0);
  cleanup();setup({layout:'horizontalScreen'});expect(screen.queryAllByRole('slider')).toHaveLength(0);
});

it('shows the saved weight as a percentage of the default width',()=>{
  scores.set(1,1.5);setup();
  const bar=screen.getByRole('slider',{name:'Bar 2 width'});expect(bar.getAttribute('aria-valuenow')).toBe('150');expect(bar.getAttribute('aria-valuetext')).toBe('150% of the default width');
});

it('changes a width from the keyboard, one edit per press, and records nothing at a limit or the current value',()=>{
  const {onScale}=setup();const bar=screen.getByRole('slider',{name:'Bar 1 width'});bar.focus();
  fireEvent.keyDown(bar,{key:'ArrowRight'});expect(onScale).toHaveBeenLastCalledWith(0,1.1);
  fireEvent.keyDown(bar,{key:'ArrowLeft'});expect(onScale).toHaveBeenLastCalledWith(0,.9);
  fireEvent.keyDown(bar,{key:'ArrowRight',shiftKey:true});expect(onScale).toHaveBeenLastCalledWith(0,1.5);
  expect(onScale).toHaveBeenCalledTimes(3);
  // Home on a default bar is the current value.
  fireEvent.keyDown(bar,{key:'Home'});expect(onScale).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(bar,{key:'a'});fireEvent.keyDown(bar,{key:'ArrowRight',ctrlKey:true});expect(onScale).toHaveBeenCalledTimes(3);
  scores.set(0,.25);fireEvent.keyDown(bar,{key:'ArrowLeft'});expect(onScale).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(bar,{key:'Home'});expect(onScale).toHaveBeenLastCalledWith(0,1);scores.set(0,4);fireEvent.keyDown(bar,{key:'ArrowRight'});expect(onScale).toHaveBeenCalledTimes(4);
});

it('records one edit for a whole drag, at its release, and none for a cancelled or empty drag',()=>{
  const {onScale}=setup();const bar=screen.getByRole('slider',{name:'Bar 1 width'});
  fireEvent.mouseDown(bar,{button:0,clientX:100});
  for(const x of [110,140,150])fireEvent.mouseMove(document,{clientX:x});
  expect(onScale).not.toHaveBeenCalled();expect(bar.querySelector('.score-bar-guide')).not.toBeNull();
  fireEvent.mouseUp(document);expect(onScale).toHaveBeenCalledTimes(1);expect(onScale).toHaveBeenCalledWith(0,1.25);expect(bar.querySelector('.score-bar-guide')).toBeNull();
  // Moves after the release do nothing.
  fireEvent.mouseMove(document,{clientX:300});fireEvent.mouseUp(document);expect(onScale).toHaveBeenCalledTimes(1);
  // Escape abandons the drag.
  fireEvent.mouseDown(bar,{button:0,clientX:100});fireEvent.mouseMove(document,{clientX:180});fireEvent.keyDown(document,{key:'Escape'});fireEvent.mouseUp(document);
  expect(onScale).toHaveBeenCalledTimes(1);expect(bar.querySelector('.score-bar-guide')).toBeNull();
  // A click without movement, and a drag back to the start, record nothing.
  fireEvent.mouseDown(bar,{button:0,clientX:100});fireEvent.mouseUp(document);
  fireEvent.mouseDown(bar,{button:0,clientX:100});fireEvent.mouseMove(document,{clientX:150});fireEvent.mouseMove(document,{clientX:100});fireEvent.mouseUp(document);
  fireEvent.mouseDown(bar,{button:2,clientX:100});fireEvent.mouseMove(document,{clientX:150});fireEvent.mouseUp(document);
  expect(onScale).toHaveBeenCalledTimes(1);
  // A drag narrows too, and never past the smallest width.
  fireEvent.mouseDown(bar,{button:0,clientX:300});fireEvent.mouseMove(document,{clientX:-5000});fireEvent.mouseUp(document);
  expect(onScale).toHaveBeenLastCalledWith(0,.25);
});

it('refuses width changes while busy without disabling the handle, so it keeps focus',()=>{
  const {onScale}=setup({busy:true});const bar=screen.getByRole('slider',{name:'Bar 1 width'});bar.focus();
  expect(bar.hasAttribute('disabled')).toBe(false);expect(bar.getAttribute('aria-disabled')).toBe('true');expect(bar.className).toContain('is-disabled');
  fireEvent.keyDown(bar,{key:'ArrowRight'});fireEvent.keyDown(bar,{key:'Home'});
  fireEvent.mouseDown(bar,{button:0,clientX:100});fireEvent.mouseMove(document,{clientX:200});fireEvent.mouseUp(document);
  expect(onScale).not.toHaveBeenCalled();expect(document.activeElement).toBe(bar);
  expect(bar.querySelector('.score-bar-guide')).toBeNull();
  act(()=>{});
});
