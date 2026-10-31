// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { Knob } from './Knob';
import { parseTyped, snapToStep } from './useRange';

beforeEach(()=>vi.useFakeTimers({shouldAdvanceTime:true}));
afterEach(()=>{cleanup();vi.useRealTimers();});
const gain=(extra:Partial<React.ComponentProps<typeof Knob>>={})=><Knob label="Gain" ariaLabel="amp Gain (dB)" value={2} min={-24} max={24} step={.5} defaultValue={0} unit=" dB" onCommit={()=>{}} {...extra}/>;

it('is a slider with a spoken value and range', ()=>{
  render(gain());
  const knob=screen.getByRole('slider',{name:'amp Gain (dB)'});
  expect(knob).toHaveAttribute('aria-valuemin','-24');expect(knob).toHaveAttribute('aria-valuemax','24');expect(knob).toHaveAttribute('aria-valuenow','2');
  expect(knob).toHaveAttribute('aria-valuetext','+2.0 dB');
  expect(screen.getByText('+2.0 dB')).toBeInTheDocument();
});

it('records one change for a whole vertical drag, not one per pixel', ()=>{
  const onCommit=vi.fn(),onInput=vi.fn();render(gain({onCommit,onInput}));
  const knob=screen.getByRole('slider');
  fireEvent.pointerDown(knob,{clientY:200,pointerId:1,button:0});
  for(const y of [190,170,150,120,100])fireEvent.pointerMove(knob,{clientY:y,pointerId:1});
  expect(onCommit).not.toHaveBeenCalled();
  expect(onInput.mock.calls.length).toBe(5);
  // The control follows the drag while it goes.
  expect(Number(knob.getAttribute('aria-valuenow'))).toBeGreaterThan(2);
  fireEvent.pointerUp(knob,{clientY:100,pointerId:1});
  expect(onCommit).toHaveBeenCalledTimes(1);
  // 100 px up on a 160 px travel across a 48 dB range would pass the top, so it stops there.
  expect(onCommit).toHaveBeenCalledWith(24);
});

it('drags down to lower the value and holds it to the range', ()=>{
  const onCommit=vi.fn();render(gain({onCommit,value:0,max:10,min:0,step:1}));
  const knob=screen.getByRole('slider');
  fireEvent.pointerDown(knob,{clientY:100,pointerId:1});fireEvent.pointerMove(knob,{clientY:400,pointerId:1});fireEvent.pointerUp(knob,{pointerId:1});
  expect(onCommit).not.toHaveBeenCalled();// already at the minimum: nothing to record
  fireEvent.pointerDown(knob,{clientY:400,pointerId:1});fireEvent.pointerMove(knob,{clientY:300,pointerId:1});fireEvent.pointerUp(knob,{pointerId:1});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(6);// 100 of 160 px across 0 to 10
});

it('takes a finer drag with Shift', ()=>{
  const onCommit=vi.fn();render(gain({onCommit,value:0,min:0,max:100,step:1}));
  const knob=screen.getByRole('slider');
  fireEvent.pointerDown(knob,{clientY:200,pointerId:1});fireEvent.pointerMove(knob,{clientY:120,pointerId:1,shiftKey:true});fireEvent.pointerUp(knob,{pointerId:1});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(10);
});

it('steps with the arrow, page, home and end keys', ()=>{
  const onCommit=vi.fn();render(gain({onCommit}));
  const knob=screen.getByRole('slider');
  fireEvent.keyDown(knob,{key:'ArrowUp'});expect(onCommit).toHaveBeenLastCalledWith(2.5);
  fireEvent.keyDown(knob,{key:'ArrowLeft'});expect(onCommit).toHaveBeenLastCalledWith(1.5);
  fireEvent.keyDown(knob,{key:'PageUp'});expect(onCommit).toHaveBeenLastCalledWith(7);
  fireEvent.keyDown(knob,{key:'ArrowDown',shiftKey:true});expect(onCommit).toHaveBeenLastCalledWith(-3);
  fireEvent.keyDown(knob,{key:'Home'});expect(onCommit).toHaveBeenLastCalledWith(-24);
  fireEvent.keyDown(knob,{key:'End'});expect(onCommit).toHaveBeenLastCalledWith(24);
  expect(onCommit).toHaveBeenCalledTimes(6);
});

it('does not take keys it does not use, and ignores everything while disabled', ()=>{
  const onCommit=vi.fn();const {rerender}=render(gain({onCommit}));
  const knob=screen.getByRole('slider');
  expect(fireEvent.keyDown(knob,{key:'a'})).toBe(true);
  rerender(gain({onCommit,disabled:true}));
  fireEvent.keyDown(knob,{key:'ArrowUp'});fireEvent.pointerDown(knob,{clientY:5,pointerId:1});fireEvent.pointerMove(knob,{clientY:0,pointerId:1});fireEvent.pointerUp(knob,{pointerId:1});fireEvent.doubleClick(knob);
  expect(onCommit).not.toHaveBeenCalled();expect(knob).toHaveAttribute('aria-disabled','true');
});

it('resets to its default on double-click, and has no reset without one', ()=>{
  const onCommit=vi.fn();const {rerender}=render(gain({onCommit}));
  fireEvent.doubleClick(screen.getByRole('slider'));expect(onCommit).toHaveBeenCalledExactlyOnceWith(0);
  onCommit.mockClear();rerender(gain({onCommit,defaultValue:undefined}));
  fireEvent.doubleClick(screen.getByRole('slider'));expect(onCommit).not.toHaveBeenCalled();
});

it('turns with the wheel only while focused, and records once when the wheel settles', ()=>{
  const onCommit=vi.fn();render(gain({onCommit}));
  const knob=screen.getByRole('slider');
  fireEvent.wheel(knob,{deltaY:-100});expect(onCommit).not.toHaveBeenCalled();expect(knob).toHaveAttribute('aria-valuenow','2');
  act(()=>knob.focus());
  fireEvent.wheel(knob,{deltaY:-100});fireEvent.wheel(knob,{deltaY:-100});fireEvent.wheel(knob,{deltaY:100});
  expect(knob).toHaveAttribute('aria-valuenow','2.5');expect(onCommit).not.toHaveBeenCalled();
  act(()=>{vi.advanceTimersByTime(400);});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(2.5);
});

it('takes a typed value from the readout, with a unit, and ignores Escape', ()=>{
  const onCommit=vi.fn();render(gain({onCommit}));
  fireEvent.click(screen.getByText('+2.0 dB'));
  const field=screen.getByRole('textbox',{name:'amp Gain (dB) value'});
  fireEvent.change(field,{target:{value:'−6,5 dB'}});fireEvent.keyDown(field,{key:'Enter'});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(-6.5);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByText('+2.0 dB'));
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'30'}});fireEvent.keyDown(screen.getByRole('textbox'),{key:'Escape'});
  expect(onCommit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('+2.0 dB'));
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'99'}});fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});
  expect(onCommit).toHaveBeenLastCalledWith(24);
});

it('opens the typed value from the keyboard and rejects text with no number', ()=>{
  const onCommit=vi.fn();render(gain({onCommit}));
  const knob=screen.getByRole('slider');act(()=>knob.focus());
  fireEvent.keyDown(knob,{key:'Enter'});
  const field=screen.getByRole('textbox');expect(field).toHaveFocus();
  fireEvent.change(field,{target:{value:'loud'}});fireEvent.keyDown(field,{key:'Enter'});
  expect(onCommit).not.toHaveBeenCalled();expect(knob).toHaveFocus();
});

it('keeps showing the committed value until the host has taken it, then follows the host', async()=>{
  let release=()=>{};
  function Host() {
    const [value,setValue]=useState(0);
    return <Knob label="Mix" value={value} min={0} max={1} step={.1} onCommit={next=>new Promise<void>(resolve=>{release=()=>{setValue(next);resolve();};})}/>;
  }
  render(<Host/>);
  const knob=screen.getByRole('slider');
  fireEvent.keyDown(knob,{key:'ArrowUp'});
  expect(knob).toHaveAttribute('aria-valuenow','0.1');
  await act(async()=>{release();});
  expect(knob).toHaveAttribute('aria-valuenow','0.1');
});

it('returns to the host value when the host refuses a change', async()=>{
  render(<Knob label="Mix" value={0} min={0} max={1} step={.1} onCommit={()=>Promise.reject(new Error('no'))}/>);
  const knob=screen.getByRole('slider');
  await act(async()=>{fireEvent.keyDown(knob,{key:'ArrowUp'});});
  expect(knob).toHaveAttribute('aria-valuenow','0');
});

// Typed entry, with real typing: every key re-renders the field, and a render must not select its text again.
it('takes a typed value of several characters, selecting the old text once when the field opens', async()=>{
  vi.useRealTimers();
  const user=userEvent.setup(),onCommit=vi.fn();
  function Host(){const [value,setValue]=useState(2);return <Knob label="Gain" ariaLabel="amp Gain (dB)" unit=" dB" min={-24} max={24} step={.1} value={value} onCommit={next=>{onCommit(next);setValue(next);}}/>;}
  render(<Host/>);
  await user.click(screen.getByText('+2.0 dB'));
  const field=screen.getByRole('textbox') as HTMLInputElement;
  expect(field).toHaveFocus();expect(field.selectionStart).toBe(0);expect(field.selectionEnd).toBe(field.value.length);
  await user.keyboard('-6.5');
  expect(field).toHaveValue('-6.5');
  await user.keyboard('{Enter}');
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(-6.5);
});

it('does not steal focus back to the dial when a typed field blurs', async()=>{
  vi.useRealTimers();
  const user=userEvent.setup(),onCommit=vi.fn();
  render(<><Knob label="Gain" ariaLabel="amp Gain (dB)" value={2} min={-24} max={24} step={.5} onCommit={onCommit}/><button>Search sounds</button></>);
  await user.click(screen.getByText('+2.0'));
  expect(screen.getByRole('textbox')).toHaveFocus();
  await user.keyboard('5');
  await user.click(screen.getByRole('button',{name:'Search sounds'}));
  expect(screen.getByRole('button',{name:'Search sounds'})).toHaveFocus();
  expect(onCommit).toHaveBeenCalledWith(5);
});

it('reads typed numbers and snaps to whole steps', ()=>{
  expect(parseTyped('+3.5 dB')).toBe(3.5);expect(parseTyped('−2')).toBe(-2);expect(parseTyped('1,5')).toBe(1.5);expect(parseTyped('x')).toBeNull();
  expect(snapToStep(2.26,-24,24,.5)).toBe(2.5);expect(snapToStep(.3,0,1,.01)).toBe(.3);expect(snapToStep(99,0,10,1)).toBe(10);expect(snapToStep(1/3,0,1,.01)).toBe(.33);
});
