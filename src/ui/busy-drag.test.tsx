// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Fader } from './Fader';
import { Knob } from './Knob';
import { MixSlider } from './MixSlider';

afterEach(cleanup);
const knob=(busy:boolean,extra:Partial<React.ComponentProps<typeof Knob>>={})=><Knob label="Pan" ariaLabel="Pan track" bipolar value={0} min={-1} max={1} step={.05} defaultValue={0} busy={busy} onCommit={()=>{}} {...extra}/>;
const fader=(busy:boolean,extra:Partial<React.ComponentProps<typeof Fader>>={})=><Fader label="Volume" ariaLabel="Volume track" value={.5} min={0} max={1} step={.05} defaultValue={1} busy={busy} onCommit={()=>{}} {...extra}/>;

it('keeps a Knob drag going when the app turns busy, and records it once at the release',()=>{
  const onCommit=vi.fn(),onInput=vi.fn(),onInputEnd=vi.fn();
  const view=render(knob(false,{onCommit,onInput,onInputEnd}));const slider=screen.getByRole('slider');
  fireEvent.pointerDown(slider,{clientY:200,pointerId:1,button:0});fireEvent.pointerMove(slider,{clientY:190,pointerId:1,buttons:1});
  view.rerender(knob(true,{onCommit,onInput,onInputEnd}));
  expect(slider).not.toHaveAttribute('disabled');
  fireEvent.pointerMove(slider,{clientY:150,pointerId:1,buttons:1});
  expect(onInputEnd).not.toHaveBeenCalled();expect(onInput.mock.calls.length).toBe(2);
  fireEvent.pointerUp(slider,{clientY:150,pointerId:1});
  expect(onCommit).toHaveBeenCalledTimes(1);expect(onCommit.mock.calls[0][0]).toBeGreaterThan(.2);expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(true);
});
it('refuses a Knob press or key while busy without taking it out of the tab order',()=>{
  const onCommit=vi.fn(),onInput=vi.fn();render(knob(true,{onCommit,onInput}));const slider=screen.getByRole('slider');
  expect(slider).toHaveAttribute('aria-disabled','true');expect(slider).toHaveAttribute('tabindex','0');
  fireEvent.pointerDown(slider,{clientY:200,pointerId:1,button:0});fireEvent.pointerMove(slider,{clientY:100,pointerId:1,buttons:1});fireEvent.pointerUp(slider,{pointerId:1});
  fireEvent.keyDown(slider,{key:'ArrowUp'});
  expect(onInput).not.toHaveBeenCalled();expect(onCommit).not.toHaveBeenCalled();
});
it('keeps a Fader drag going when the app turns busy',()=>{
  const onCommit=vi.fn();const view=render(fader(false,{onCommit}));const slider=screen.getByRole('slider');
  fireEvent.pointerDown(slider,{clientY:200,pointerId:1,button:0});fireEvent.pointerMove(slider,{clientY:180,pointerId:1,buttons:1});
  view.rerender(fader(true,{onCommit}));expect(slider).not.toHaveAttribute('disabled');
  fireEvent.pointerMove(slider,{clientY:150,pointerId:1,buttons:1});fireEvent.pointerUp(slider,{pointerId:1});
  expect(onCommit).toHaveBeenCalledTimes(1);
});
it('still ends a drag without recording it when the control is truly unavailable',()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();const view=render(knob(false,{onCommit,onInputEnd}));const slider=screen.getByRole('slider');
  fireEvent.pointerDown(slider,{clientY:200,pointerId:1,button:0});fireEvent.pointerMove(slider,{clientY:150,pointerId:1,buttons:1});
  view.rerender(knob(false,{onCommit,onInputEnd,disabled:true}));
  expect(onInputEnd).toHaveBeenCalledWith(false);expect(onCommit).not.toHaveBeenCalled();
});

const slider=(busy:boolean,extra:Partial<React.ComponentProps<typeof MixSlider>>={})=><MixSlider label="Volume Bass" value={.5} min={0} max={1} step={.05} format={v=>`${Math.round(v*100)}%`} busy={busy} onCommit={()=>{}} {...extra}/>;
const move=(range:HTMLElement,value:number)=>fireEvent.change(range,{target:{value:String(value)}});

it('MixSlider follows a drag with input only, and commits once at the release, busy or not',()=>{
  const onCommit=vi.fn(),onInput=vi.fn(),onInputEnd=vi.fn();const view=render(slider(false,{onCommit,onInput,onInputEnd}));const range=screen.getByRole('slider');
  fireEvent.pointerDown(range,{pointerId:1,button:0});move(range,.4);move(range,.3);
  view.rerender(slider(true,{onCommit,onInput,onInputEnd}));
  expect(range).not.toHaveAttribute('disabled');expect(range).toHaveAttribute('aria-disabled','true');
  move(range,.2);expect(range).toHaveValue('0.2');
  expect(onInput.mock.calls.map(c=>c[0])).toEqual([.4,.3,.2]);expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(range,{pointerId:1});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(.2);expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(true);
});
it('MixSlider records nothing for a drag that ends where it began',()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(slider(false,{onCommit,onInputEnd}));const range=screen.getByRole('slider');
  fireEvent.pointerDown(range,{pointerId:1});move(range,.8);move(range,.5);fireEvent.pointerUp(range,{pointerId:1});
  expect(onCommit).not.toHaveBeenCalled();expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);
});
it('MixSlider takes each keyboard step as one change and refuses a change that starts while busy',async()=>{
  const onCommit=vi.fn();const view=render(slider(false,{onCommit}));const range=screen.getByRole('slider');
  fireEvent.keyDown(range,{key:'ArrowRight'});move(range,.55);fireEvent.keyUp(range,{key:'ArrowRight'});
  fireEvent.keyDown(range,{key:'ArrowRight'});move(range,.6);fireEvent.keyUp(range,{key:'ArrowRight'});
  expect(onCommit.mock.calls.map(c=>c[0])).toEqual([.55,.6]);await act(async()=>{});
  view.rerender(slider(true,{onCommit,value:.6}));onCommit.mockClear();
  fireEvent.keyDown(range,{key:'ArrowRight'});move(range,.65);fireEvent.keyUp(range,{key:'ArrowRight'});
  expect(onCommit).not.toHaveBeenCalled();expect(range).toHaveValue('0.6');
});
it('MixSlider puts the control back when Escape cancels a drag',()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(slider(false,{onCommit,onInputEnd}));const range=screen.getByRole('slider');
  fireEvent.pointerDown(range,{pointerId:1});move(range,.9);fireEvent.keyDown(range,{key:'Escape'});fireEvent.pointerUp(range,{pointerId:1});
  expect(range).toHaveValue('0.5');expect(onCommit).not.toHaveBeenCalled();expect(onInputEnd).toHaveBeenCalledWith(false);
});

it('MixSlider follows a mouse drag on the window, so it keeps going when pointer capture is dropped and the pointer leaves the control',()=>{
  const onCommit=vi.fn(),onInput=vi.fn(),onInputEnd=vi.fn();const view=render(slider(false,{onCommit,onInput,onInputEnd,value:1}));const range=screen.getByRole('slider');
  range.getBoundingClientRect=()=>({top:0,left:0,right:114,bottom:20,height:20,width:114,x:0,y:0,toJSON:()=>({})});
  fireEvent.pointerDown(range,{pointerId:1,pointerType:'mouse',button:0,buttons:1,clientX:107});
  fireEvent.pointerMove(document.body,{pointerId:1,pointerType:'mouse',buttons:1,clientX:77});
  view.rerender(slider(true,{onCommit,onInput,onInputEnd,value:1}));
  fireEvent.pointerMove(document.body,{pointerId:1,pointerType:'mouse',buttons:1,clientX:37});
  expect(range).toHaveValue('0.3');expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(document.body,{pointerId:1,pointerType:'mouse',clientX:37});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(.3);expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(true);
});

const sized=(range:HTMLElement)=>{range.getBoundingClientRect=()=>({top:0,left:0,right:114,bottom:20,height:20,width:114,x:0,y:0,toJSON:()=>({})});};
const mouse=(extra:object={})=>({pointerId:1,pointerType:'mouse',buttons:1,...extra});
it('MixSlider ignores key releases and arrow keys while a mouse drag is under way, so one drag is one edit',()=>{
  const onCommit=vi.fn();render(slider(false,{onCommit}));const range=screen.getByRole('slider');sized(range);
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:57});fireEvent.pointerMove(document.body,{...mouse(),clientX:77});
  expect(range).toHaveValue('0.7');
  fireEvent.keyUp(range,{key:'Shift'});fireEvent.keyUp(range,{key:'Control'});
  expect(onCommit).not.toHaveBeenCalled();
  // An arrow key does not move the native range under the pointer.
  expect(fireEvent.keyDown(range,{key:'ArrowRight'})).toBe(false);
  fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:77});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(.7);
});
it('MixSlider drags relative to where the thumb was grabbed, and a click on the thumb records nothing',()=>{
  const onCommit=vi.fn(),onInput=vi.fn();render(slider(false,{onCommit,onInput}));const range=screen.getByRole('slider');sized(range);
  // The thumb of a range at 0.5 is centred on x=57; a press 3 px off-centre is still on it and changes nothing.
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:60});fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:60});
  expect(onInput).not.toHaveBeenCalled();expect(onCommit).not.toHaveBeenCalled();expect(range).toHaveValue('0.5');
  // Dragging from there keeps the grab offset: 20 px right is 20 % of the range further.
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:60});fireEvent.pointerMove(document.body,{...mouse(),clientX:80});
  expect(range).toHaveValue('0.7');fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:80});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(.7);
});
it('MixSlider jumps to a press on the bare track and carries on as a drag',()=>{
  const onCommit=vi.fn();render(slider(false,{onCommit}));const range=screen.getByRole('slider');sized(range);
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:20});fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:20});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(.1);
});
it.each([
  ['the window loses focus',()=>fireEvent.blur(window)],
  ['the pointer is cancelled',()=>fireEvent.pointerCancel(document.body,mouse())],
  ['a press lands elsewhere',()=>fireEvent.pointerDown(document.body,mouse({button:0}))],
])('MixSlider ends a drag without an edit and takes the preview back when %s',(_name,lose)=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(slider(false,{onCommit,onInputEnd}));const range=screen.getByRole('slider');sized(range);
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:57});fireEvent.pointerMove(document.body,{...mouse(),clientX:77});
  lose();
  expect(range).toHaveValue('0.5');expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);
  fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:77});expect(onCommit).not.toHaveBeenCalled();
});
it('MixSlider consumes Escape during a drag so it does not reach the app',()=>{
  const outer=vi.fn(),onCommit=vi.fn();render(<div onKeyDown={outer}>{slider(false,{onCommit})}</div>);const range=screen.getByRole('slider');sized(range);
  fireEvent.pointerDown(range,{...mouse(),button:0,clientX:57});fireEvent.pointerMove(document.body,{...mouse(),clientX:77});
  fireEvent.keyDown(range,{key:'Escape'});
  expect(outer).not.toHaveBeenCalled();expect(range).toHaveValue('0.5');
  fireEvent.pointerUp(document.body,{...mouse({buttons:0}),clientX:77});expect(onCommit).not.toHaveBeenCalled();
});
