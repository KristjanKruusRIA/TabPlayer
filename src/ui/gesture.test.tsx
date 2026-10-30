// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Fader } from './Fader';
import { Knob } from './Knob';

afterEach(()=>{cleanup();vi.useRealTimers();});
const knob=(extra:Partial<React.ComponentProps<typeof Knob>>={})=><Knob label="Gain" ariaLabel="Gain" value={0} min={0} max={10} step={1} onCommit={()=>{}} {...extra}/>;
const begin=(slider:HTMLElement,y=300)=>{fireEvent.pointerDown(slider,{clientY:y,pointerId:1,pointerType:'mouse',buttons:1});fireEvent.pointerMove(slider,{clientY:y-48,pointerId:1,pointerType:'mouse',buttons:1});};

/** The rule: a pointer gesture records only when the release is seen with the pointer still held. Losing the pointer any other way ends it with nothing recorded. */
it('ends a drag without an edit when pointer capture is lost before the release', ()=>{
  const onCommit=vi.fn(),onInput=vi.fn(),onInputEnd=vi.fn();render(knob({onCommit,onInput,onInputEnd}));
  const slider=screen.getByRole('slider');begin(slider);
  expect(slider).toHaveAttribute('aria-valuenow','3');
  fireEvent.lostPointerCapture(slider,{pointerId:1});
  expect(slider).toHaveAttribute('aria-valuenow','0');expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);
  // Ending it does not send the old value as one more update: the end is the signal to go back.
  expect(onInput).toHaveBeenCalledTimes(1);
  // The button coming up afterwards, or the pointer moving over it, does nothing.
  fireEvent.pointerUp(slider,{clientY:252,pointerId:1,pointerType:'mouse'});fireEvent.pointerMove(slider,{clientY:100,pointerId:1,pointerType:'mouse',buttons:0});
  expect(onCommit).not.toHaveBeenCalled();expect(slider).toHaveAttribute('aria-valuenow','0');
});

it('does not end a drag that has already been released when capture is released after it', ()=>{
  const onCommit=vi.fn();render(knob({onCommit}));
  const slider=screen.getByRole('slider');begin(slider);
  fireEvent.pointerUp(slider,{clientY:252,pointerId:1,pointerType:'mouse'});fireEvent.lostPointerCapture(slider,{pointerId:1});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(3);
});

it('ends a drag without an edit when the window loses focus', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(knob({onCommit,onInputEnd}));
  const slider=screen.getByRole('slider');begin(slider);
  fireEvent.blur(window);
  expect(slider).toHaveAttribute('aria-valuenow','0');expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);
  fireEvent.pointerUp(slider,{clientY:252,pointerId:1,pointerType:'mouse'});expect(onCommit).not.toHaveBeenCalled();
});

it('ends a drag without an edit when the control loses focus', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(knob({onCommit,onInputEnd}));
  const slider=screen.getByRole('slider');begin(slider);
  act(()=>slider.blur());
  expect(slider).toHaveAttribute('aria-valuenow','0');expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);expect(onCommit).not.toHaveBeenCalled();
});

it('ends a drag without an edit when a mouse move arrives with no button held, and the knob stops following', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(knob({onCommit,onInputEnd}));
  const slider=screen.getByRole('slider');begin(slider);
  fireEvent.pointerMove(slider,{clientY:100,pointerId:1,pointerType:'mouse',buttons:0});
  expect(slider).toHaveAttribute('aria-valuenow','0');expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);
  fireEvent.pointerMove(slider,{clientY:50,pointerId:1,pointerType:'mouse',buttons:0});
  expect(slider).toHaveAttribute('aria-valuenow','0');
  // The next plain click is not mistaken for the end of the old drag.
  fireEvent.pointerDown(slider,{clientY:200,pointerId:1,pointerType:'mouse',buttons:1});fireEvent.pointerUp(slider,{clientY:200,pointerId:1,pointerType:'mouse'});
  expect(onCommit).not.toHaveBeenCalled();
});

it('ends a drag, and a wheel run, without an edit when the control goes away', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn(),first=render(knob({onCommit,onInputEnd}));
  begin(screen.getByRole('slider'));first.unmount();
  expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);expect(onCommit).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const second=render(knob({onCommit,onInputEnd}));act(()=>screen.getByRole('slider').focus());
  fireEvent.wheel(screen.getByRole('slider'),{deltaY:-100});second.unmount();act(()=>{vi.advanceTimersByTime(1000);});
  expect(onCommit).not.toHaveBeenCalled();expect(onInputEnd).toHaveBeenCalledTimes(2);
});

it('ends a fader drag the same way', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(<Fader label="1k" value={0} min={-12} max={12} step={.5} onCommit={onCommit} onInputEnd={onInputEnd}/>);
  const slider=screen.getByRole('slider');slider.getBoundingClientRect=()=>({top:0,left:0,right:36,bottom:134,height:134,width:36,x:0,y:0,toJSON:()=>({})});
  const thumb=slider.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:67,pointerId:1,pointerType:'mouse',buttons:1});fireEvent.pointerMove(thumb,{clientY:37,pointerId:1,pointerType:'mouse',buttons:1});
  fireEvent.lostPointerCapture(slider,{pointerId:1});
  expect(onCommit).not.toHaveBeenCalled();expect(onInputEnd).toHaveBeenCalledExactlyOnceWith(false);expect(slider).toHaveAttribute('aria-valuenow','0');
});

it('turns the wheel by the range and step of the field the knob shows now, not the first it showed', ()=>{
  vi.useFakeTimers();
  const onCommit=vi.fn(),{rerender}=render(knob({value:2.5,min:.05,max:5,step:.05,onCommit}));
  rerender(knob({value:8,min:.1,max:20,step:.1,onCommit}));
  const slider=screen.getByRole('slider');act(()=>slider.focus());
  fireEvent.wheel(slider,{deltaY:-100});
  // One notch is one step of the current field, from the current value, inside the current range.
  expect(slider).toHaveAttribute('aria-valuenow','8.1');
  act(()=>{vi.advanceTimersByTime(400);});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(8.1);
  rerender(knob({value:8.1,min:.1,max:20,step:.1,onCommit}));
  for(let i=0;i<5;i++)fireEvent.wheel(slider,{deltaY:100});
  act(()=>{vi.advanceTimersByTime(400);});
  expect(onCommit).toHaveBeenLastCalledWith(7.6);
});

it('records nothing for a press and release in place, even where the stored value is off the steps', ()=>{
  const onCommit=vi.fn(),onInputEnd=vi.fn();render(knob({value:.333,min:0,max:1,step:.01,onCommit,onInputEnd}));
  const slider=screen.getByRole('slider');
  fireEvent.pointerDown(slider,{clientY:300,pointerId:1,pointerType:'mouse',buttons:1});fireEvent.pointerUp(slider,{clientY:300,pointerId:1,pointerType:'mouse'});
  expect(onCommit).not.toHaveBeenCalled();expect(onInputEnd).toHaveBeenCalledWith(false);expect(slider).toHaveAttribute('aria-valuenow','0.333');
  // A real move still records, and the keyboard still snaps an off-step value onto a step.
  begin(slider);fireEvent.pointerUp(slider,{clientY:252,pointerId:1,pointerType:'mouse'});expect(onCommit).toHaveBeenCalledTimes(1);
  onCommit.mockClear();fireEvent.keyDown(slider,{key:'ArrowUp'});expect(onCommit).toHaveBeenCalledExactlyOnceWith(.34);
});

it('gives a drag one edit even if an arrow key is pressed during it', ()=>{
  const onCommit=vi.fn();render(knob({onCommit}));
  const slider=screen.getByRole('slider');begin(slider);
  fireEvent.keyDown(slider,{key:'ArrowUp'});fireEvent.keyDown(slider,{key:'End'});
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerMove(slider,{clientY:240,pointerId:1,pointerType:'mouse',buttons:1});fireEvent.pointerUp(slider,{clientY:240,pointerId:1,pointerType:'mouse'});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(4);
});
