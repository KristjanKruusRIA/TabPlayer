// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { Dialog } from './Dialog';
import { Fader } from './Fader';
import { Segmented } from './Segmented';
import { busyRegion,busySelect } from './useBusyGuard';

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

it('takes a typed value like a knob does, from its readout or the Enter key', async()=>{
  const user=userEvent.setup(),onCommit=vi.fn();
  function Host(){const [value,setValue]=useState(3);return <Fader label="1k" ariaLabel="Graphic EQ 1k Hz (dB)" value={value} min={-12} max={12} step={.5} unit=" dB" bipolar onCommit={next=>{onCommit(next);setValue(next);}}/>;}
  render(<Host/>);
  await user.click(screen.getByText('+3.0 dB'));
  const field=screen.getByRole('textbox',{name:'Graphic EQ 1k Hz (dB) value'}) as HTMLInputElement;
  expect(field).toHaveFocus();expect(field.selectionEnd).toBe(field.value.length);
  await user.keyboard('-4.5{Enter}');
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(-4.5);expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow','-4.5');expect(screen.getByRole('slider')).toHaveFocus();
  screen.getByRole('slider').focus();await user.keyboard('{Enter}30{Enter}');
  expect(onCommit).toHaveBeenLastCalledWith(12);
  screen.getByRole('slider').focus();await user.keyboard('{Enter}1{Escape}');
  expect(onCommit).toHaveBeenCalledTimes(2);
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
  expect(radios[1]).toHaveAttribute('aria-disabled','true');expect(radios[1]).not.toBeDisabled();
  await user.click(radios[1]);expect(radios[1]).not.toBeChecked();
  radios[0].focus();await user.keyboard('{ArrowRight}');expect(radios[2]).toHaveFocus();expect(radios[2]).toBeChecked();
  await user.click(radios[3]);expect(radios[3]).toBeChecked();
});

it('disables the whole group while keeping the chosen option focusable and refusing presses', async()=>{
  const onChange=vi.fn();
  const {rerender}=render(<Segmented label="Output" value="stereo" onChange={onChange} options={[{value:'stereo',label:'Stereo'},{value:'mono',label:'Mono'}]}/>);
  const radios=screen.getAllByRole('radio');
  radios[0].focus();expect(radios[0]).toHaveFocus();
  rerender(<Segmented label="Output" value="stereo" onChange={onChange} disabled options={[{value:'stereo',label:'Stereo'},{value:'mono',label:'Mono'}]}/>);
  for(const radio of radios){expect(radio).toHaveAttribute('aria-disabled','true');expect(radio).not.toBeDisabled();}
  expect(radios[0].tabIndex).toBe(0);expect(radios[0]).toHaveFocus();
  await userEvent.click(radios[1]);
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.keyboard('{ArrowRight}');
  expect(onChange).not.toHaveBeenCalled();
});

it('does not report a change when Home or End lands on the option already chosen', async()=>{
  const user=userEvent.setup(),onChange=vi.fn();
  const {rerender}=render(<Segmented label="Source" value="gm" onChange={onChange} options={[{value:'auto',label:'Auto'},{value:'gm',label:'GM'}]}/>);
  const radios=screen.getAllByRole('radio');
  radios[1].focus();await user.keyboard('{End}');
  expect(onChange).not.toHaveBeenCalled();
  rerender(<Segmented label="Source" value="auto" onChange={onChange} options={[{value:'auto',label:'Auto'},{value:'gm',label:'GM'}]}/>);
  radios[0].focus();await user.keyboard('{Home}');
  expect(onChange).not.toHaveBeenCalled();
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

it('keeps Tab inside the dialog and closes from its button, and backdrop dismiss is opt-in', async()=>{
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
  fireEvent.mouseDown(dialog.parentElement!);expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(dialog);expect(onClose).toHaveBeenCalledTimes(1);
});

it('handles Escape and Tab at document level, recovers focus from body, and keeps background inert', async()=>{
  const onClose=vi.fn();
  const background=document.createElement('button');
  background.textContent='Background button';
  document.body.appendChild(background);

  const { unmount }=render(<Dialog title="Modal" onClose={onClose} actions={<button id="act">Action</button>}><input aria-label="Field"/></Dialog>);
  expect(background).toHaveAttribute('inert');

  // When focus falls to body (e.g. after a clicked button is disabled), document key handler recovers
  (document.activeElement as HTMLElement)?.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body,{key:'Tab'});
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

  // Escape at document level closes the dialog even when focus is on body
  (document.activeElement as HTMLElement)?.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body,{key:'Escape'});
  expect(onClose).toHaveBeenCalledTimes(1);

  unmount();
  expect(background).not.toHaveAttribute('inert');
  background.remove();
});

it('defines the shared UI tokens and styles primary buttons and fields',()=>{
  const css=readFileSync('src/ui/ui.css','utf8');
  for(const token of ['--tp-danger','--tp-focus','--tp-r-sm','--tp-r-md','--tp-r-lg','--tp-shadow-float']){
    expect(css).toContain(token);
  }
  expect(css).toMatch(/\.tp-button\b/);
  expect(css).toMatch(/\.tp-field\b/);
  expect(css).toMatch(/\.tp-button\.primary|\.tp-dialog \.tp-dialog-foot button\.primary/);
});

it('does not fire onChange when Home or End targets the already selected option', async()=>{
  const onChange=vi.fn();
  render(<Segmented label="Mode" value="first" onChange={onChange} options={[{value:'first',label:'First'},{value:'second',label:'Second'}]}/>);
  const radios=screen.getAllByRole('radio');
  radios[0].focus();
  fireEvent.keyDown(radios[0],{key:'Home'});
  expect(onChange).not.toHaveBeenCalled();
});

const wait=()=>new Promise<void>(resolve=>setTimeout(resolve,20));
it('leaves focus alone when it moves to another element, and only recovers a real loss',async()=>{
  const user=userEvent.setup();
  render(<Dialog title="Frame" onClose={()=>{}} actions={<button>Done</button>}><input aria-label="One"/><input aria-label="Two"/></Dialog>);
  const [one,two]=[screen.getByRole('textbox',{name:'One'}),screen.getByRole('textbox',{name:'Two'})];
  await user.click(two);await wait();expect(two).toHaveFocus();
  await user.tab();await wait();expect(screen.getByRole('button',{name:'Done'})).toHaveFocus();
  await user.click(one);await wait();expect(one).toHaveFocus();
  one.blur();expect(document.body).toHaveFocus();await wait();
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);expect(document.activeElement).not.toBe(document.body);
});

it('keeps the focus-holding controls through a busy change and keeps aria-disabled controls in the trap',async()=>{
  const user=userEvent.setup(),onClose=vi.fn();
  const view=(closeDisabled:boolean)=><><button>Opener</button><Dialog title="Frame" onClose={onClose} closeDisabled={closeDisabled} dismissOnBackdrop busy={closeDisabled} actions={<button aria-disabled="true">Wait</button>}><input aria-label="One"/><input aria-label="Two"/></Dialog></>;
  const {rerender}=render(view(false));
  const two=screen.getByRole('textbox',{name:'Two'}),close=screen.getByRole('button',{name:'Close'}),wait_=screen.getByRole('button',{name:'Wait'});
  two.focus();rerender(view(true));
  expect(two).toHaveFocus();
  expect(close).toHaveAttribute('aria-disabled','true');expect(close).not.toBeDisabled();
  await user.click(close);fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  await user.tab();expect(wait_).toHaveFocus();
  await user.tab();expect(close).toHaveFocus();
  rerender(view(false));await user.click(close);expect(onClose).toHaveBeenCalledTimes(1);
});

it('closes from the backdrop only when asked to',()=>{
  const onClose=vi.fn();
  render(<Dialog title="Frame" onClose={onClose} dismissOnBackdrop><p>Body</p></Dialog>);
  fireEvent.mouseDown(screen.getByRole('dialog'));expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(onClose).toHaveBeenCalledTimes(1);
});

it('refuses every press, key and change inside a busy region without taking focus away',async()=>{
  const user=userEvent.setup(),act=vi.fn(),change=vi.fn();
  function Region({busy}:{busy:boolean}){return <fieldset {...busyRegion(busy)}><button onClick={act}>Go</button><input aria-label="Text" defaultValue="a" onChange={change}/><input type="checkbox" aria-label="Check" onChange={change}/><select aria-label="Pick" onChange={change}><option>a</option><option>b</option></select></fieldset>;}
  const {rerender}=render(<Region busy={false}/>);
  const go=screen.getByRole('button',{name:'Go'});go.focus();
  rerender(<Region busy/>);
  expect(go).toHaveFocus();expect(screen.getByRole('group')).toHaveAttribute('aria-disabled','true');
  await user.click(go);await user.keyboard('{Enter}');await user.keyboard(' ');
  const text=screen.getByRole('textbox',{name:'Text'});text.focus();await user.keyboard('xyz{Backspace}');
  await user.click(screen.getByRole('checkbox',{name:'Check'}));
  const pick=screen.getByRole('combobox',{name:'Pick'});pick.focus();await user.keyboard('{ArrowDown}');
  expect(act).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled();
  expect(text).toHaveValue('a');expect(screen.getByRole('checkbox',{name:'Check'})).not.toBeChecked();
  rerender(<Region busy={false}/>);await user.click(go);expect(act).toHaveBeenCalledTimes(1);
});

it('styles the palette backdrop above the shared one and dims aria-disabled controls',()=>{
  expect(readFileSync('src/styles.css','utf8')).toMatch(/\.tp-dialog-backdrop\.command-palette-backdrop\{[^}]*align-items:flex-start/);
  expect(readFileSync('src/ui/ui.css','utf8')).toMatch(/^:is\(button,select,summary\)\[aria-disabled=true\], button\.is-disabled/m);
});

it('also refuses double clicks, context menus, drags and aux clicks in a busy region, and announces it',()=>{
  const seen=vi.fn();
  function Region({busy}:{busy:boolean}){return <div {...busyRegion(busy)} data-testid="region"><span role="button" tabIndex={0} onDoubleClick={seen} onContextMenu={seen} onDragStart={seen} onAuxClick={seen}>Mark</span></div>;}
  const {rerender}=render(<Region busy/>);
  const mark=screen.getByRole('button',{name:'Mark'});
  fireEvent.doubleClick(mark);fireEvent.contextMenu(mark);fireEvent.dragStart(mark);fireEvent.mouseDown(mark,{button:1});
  expect(seen).not.toHaveBeenCalled();expect(screen.getByTestId('region')).toHaveAttribute('aria-busy','true');
  rerender(<Region busy={false}/>);fireEvent.doubleClick(mark);fireEvent.contextMenu(mark);
  expect(seen).toHaveBeenCalledTimes(2);expect(screen.getByTestId('region')).not.toHaveAttribute('aria-busy');
});

it('keeps a busy select from opening its popup',()=>{
  const {rerender}=render(<select aria-label="Pick" {...busySelect(true)}><option>a</option></select>);
  const pick=screen.getByRole('combobox',{name:'Pick'});
  expect(pick).toHaveAttribute('aria-disabled','true');
  expect(fireEvent.mouseDown(pick)).toBe(false);expect(fireEvent.keyDown(pick,{key:'ArrowDown'})).toBe(false);expect(fireEvent.keyDown(pick,{key:'Tab'})).toBe(true);
  rerender(<select aria-label="Pick" {...busySelect(false)}><option>a</option></select>);
  expect(fireEvent.mouseDown(pick)).toBe(true);
});
