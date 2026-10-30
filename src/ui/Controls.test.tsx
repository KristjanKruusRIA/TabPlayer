// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog } from './Dialog';
import { Fader } from './Fader';
import { Segmented } from './Segmented';

afterEach(cleanup);

const fader=(extra:Partial<React.ComponentProps<typeof Fader>>={})=><Fader label="1k" ariaLabel="Graphic EQ 1k Hz (dB)" value={3} min={-12} max={12} step={.5} defaultValue={0} unit=" dB" bipolar onCommit={()=>{}} {...extra}/>;
/** A fader 134 px high has 120 px of travel for its thumb. */
const sized=(element:HTMLElement)=>{element.getBoundingClientRect=()=>({top:100,left:0,right:36,bottom:234,height:134,width:36,x:0,y:100,toJSON:()=>({})});};

it('is a vertical slider with the knob contract', ()=>{
  const onCommit=vi.fn();render(fader({onCommit}));
  const slider=screen.getByRole('slider',{name:'Graphic EQ 1k Hz (dB)'});
  expect(slider).toHaveAttribute('aria-orientation','vertical');expect(slider).toHaveAttribute('aria-valuetext','+3.0 dB');
  fireEvent.keyDown(slider,{key:'ArrowUp'});expect(onCommit).toHaveBeenLastCalledWith(3.5);
  fireEvent.keyDown(slider,{key:'PageDown'});expect(onCommit).toHaveBeenLastCalledWith(-2);
  fireEvent.doubleClick(slider);expect(onCommit).toHaveBeenLastCalledWith(0);
  expect(onCommit).toHaveBeenCalledTimes(3);
});

it('records one change for a drag along its track', ()=>{
  const onCommit=vi.fn();render(fader({onCommit}));
  const slider=screen.getByRole('slider');sized(slider);
  const thumb=slider.querySelector('.tp-fader-thumb')!;
  fireEvent.pointerDown(thumb,{clientY:150,pointerId:1});
  fireEvent.pointerMove(thumb,{clientY:140,pointerId:1});fireEvent.pointerMove(thumb,{clientY:120,pointerId:1});
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(thumb,{clientY:120,pointerId:1});
  // 30 px up of 120 px of travel across 24 dB is 6 dB.
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(9);
});

it('jumps to where the bare track is pressed', ()=>{
  const onCommit=vi.fn();render(fader({onCommit}));
  const slider=screen.getByRole('slider');sized(slider);
  fireEvent.pointerDown(slider,{clientY:100+7,pointerId:1});fireEvent.pointerUp(slider,{pointerId:1});
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
});

it('is inert while disabled', ()=>{
  const onCommit=vi.fn();render(fader({onCommit,disabled:true}));
  const slider=screen.getByRole('slider');
  fireEvent.keyDown(slider,{key:'ArrowUp'});fireEvent.doubleClick(slider);
  expect(onCommit).not.toHaveBeenCalled();
});

function Choice({disabledOption=false}:{disabledOption?:boolean}) {
  const [value,setValue]=useState('lead');
  return <><Segmented label="Amp model" value={value} onChange={setValue} options={[{value:'clean',label:'Clean'},{value:'crunch',label:'Crunch',disabled:disabledOption},{value:'lead',label:'Lead'},{value:'metal',label:'Metal'}]}/><button>after</button></>;
}
it('is a radio group whose chosen option is the only tab stop', async()=>{
  const user=userEvent.setup();render(<Choice/>);
  const group=screen.getByRole('radiogroup',{name:'Amp model'});
  const radios=within(group).getAllByRole('radio');
  expect(radios.map(radio=>radio.getAttribute('aria-checked'))).toEqual(['false','false','true','false']);
  expect(radios.map(radio=>radio.tabIndex)).toEqual([-1,-1,0,-1]);
  await user.tab();expect(radios[2]).toHaveFocus();
  await user.tab();expect(screen.getByRole('button',{name:'after'})).toHaveFocus();
});

it('moves focus and choice together with the arrow keys, wrapping at neither end', async()=>{
  const user=userEvent.setup();render(<Choice/>);
  const radios=screen.getAllByRole('radio');
  radios[2].focus();
  await user.keyboard('{ArrowRight}');expect(radios[3]).toHaveFocus();expect(radios[3]).toBeChecked();
  await user.keyboard('{ArrowRight}');expect(radios[3]).toHaveFocus();
  await user.keyboard('{ArrowUp}');expect(radios[2]).toBeChecked();
  await user.keyboard('{Home}');expect(radios[0]).toHaveFocus();expect(radios[0]).toBeChecked();
  await user.keyboard('{End}');expect(radios[3]).toBeChecked();
  expect(radios.map(radio=>radio.tabIndex)).toEqual([-1,-1,-1,0]);
});

it('skips a disabled option and chooses on click', async()=>{
  const user=userEvent.setup();render(<Choice disabledOption/>);
  const radios=screen.getAllByRole('radio');
  expect(radios[1]).toBeDisabled();
  radios[0].focus();await user.keyboard('{ArrowRight}');expect(radios[2]).toHaveFocus();expect(radios[2]).toBeChecked();
  await user.click(radios[3]);expect(radios[3]).toBeChecked();
});

it('disables the whole group', ()=>{
  render(<Segmented label="Output" value="stereo" onChange={()=>{}} disabled options={[{value:'stereo',label:'Stereo'},{value:'mono',label:'Mono'}]}/>);
  for(const radio of screen.getAllByRole('radio'))expect(radio).toBeDisabled();
});

it('frames a dialog: named, focused, closed by Escape, and focus returns', async()=>{
  const user=userEvent.setup(),onClose=vi.fn();
  function Host() {
    const [open,setOpen]=useState(false);
    return <><button onClick={()=>setOpen(true)}>Open</button>{open&&<Dialog title="Delete “Practice”?" onClose={()=>{onClose();setOpen(false);}} actions={<><button>Cancel</button><button data-autofocus>Delete</button></>}><p>This cannot be undone.</p></Dialog>}</>;
  }
  render(<Host/>);
  const opener=screen.getByRole('button',{name:'Open'});await user.click(opener);
  const dialog=screen.getByRole('dialog',{name:'Delete “Practice”?'});
  expect(dialog).toHaveAttribute('aria-modal','true');
  expect(within(dialog).getByRole('button',{name:'Delete'})).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);expect(screen.queryByRole('dialog')).toBeNull();expect(opener).toHaveFocus();
});

it('keeps Tab inside the dialog and closes from its button or the backdrop', async()=>{
  const user=userEvent.setup(),onClose=vi.fn();
  render(<Dialog title="Frame" onClose={onClose} actions={<button>Done</button>}><input aria-label="Name"/></Dialog>);
  const dialog=screen.getByRole('dialog');
  expect(screen.getByRole('textbox',{name:'Name'}) .closest('.tp-dialog')).toBe(dialog);
  const items=[screen.getByRole('button',{name:'Close'}),screen.getByRole('textbox'),screen.getByRole('button',{name:'Done'})];
  expect(items[0]).toHaveFocus();
  await user.tab();await user.tab();expect(items[2]).toHaveFocus();
  await user.tab();expect(items[0]).toHaveFocus();
  await user.tab({shift:true});expect(items[2]).toHaveFocus();
  await user.click(items[0]);expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(dialog.parentElement!);expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.mouseDown(dialog);expect(onClose).toHaveBeenCalledTimes(2);
});
