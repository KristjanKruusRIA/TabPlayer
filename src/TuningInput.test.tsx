// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TuningInput } from './TuningInput';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
function Draft({onCommit}:{onCommit?:(pitches:number[])=>void}){const [value,onChange]=useState('E4 B3 G3 D3 A2 E2'),[name,setName]=useState('');return <><TuningInput label="Notes" presetLabel="Preset" value={value} onChange={onChange} tuningName={name} onTuningNameChange={setName} onCommit={onCommit}/><output aria-label="Draft name">{name}</output></>;}
it('groups exactly25 presets and choosing nine-string guitar only fills the editable draft',()=>{
  render(<Draft/>);const select=screen.getByLabelText('Preset');expect(select.querySelectorAll('optgroup')).toHaveLength(7);expect(select.querySelectorAll('option')).toHaveLength(26);fireEvent.change(select,{target:{value:'guitar-9-standard-csharp'}});expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2 B1 F#1 C#1');expect(select).toHaveValue('guitar-9-standard-csharp');
});
it('lets Custom stay selected at matching notes then autodetects manual equivalent flats',()=>{
  render(<Draft/>);const select=screen.getByLabelText('Preset');expect(select).toHaveValue('guitar-6-standard-e');fireEvent.change(select,{target:{value:'custom'}});expect(select).toHaveValue('custom');expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2');fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'Eb4 Bb3 Gb3 Db3 Ab2 Eb2'}});expect(select).toHaveValue('guitar-6-half-step-down');
});
it('resets Custom on source readback and disables both controls for percussion or busy',()=>{
  const onChange=vi.fn(),first={},props={label:'Notes',presetLabel:'Preset',value:'E4 B3 G3 D3 A2 E2',onChange,tuningName:'',onTuningNameChange:vi.fn(),revision:first};const view=render(<TuningInput {...props}/>);fireEvent.change(screen.getByLabelText('Preset'),{target:{value:'custom'}});view.rerender(<TuningInput {...props} revision={{}}/>);expect(screen.getByLabelText('Preset')).toHaveValue('guitar-6-standard-e');view.rerender(<TuningInput {...props} disabled/>);expect(screen.getByLabelText('Preset')).toBeDisabled();expect(screen.getByLabelText('Notes')).toBeDisabled();expect(onChange).not.toHaveBeenCalled();
});
it('typing clears the draft name, a preset supplies its name, and the saved-tunings button follows disabled',()=>{
  const onTuningNameChange=vi.fn(),props={label:'Notes',presetLabel:'Preset',value:'E4 B3 G3 D3 A2 E2',onChange:vi.fn(),tuningName:'Mine',onTuningNameChange};
  const view=render(<TuningInput {...props}/>);
  fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'E4 B3 G3 D3 A2 D2'}});expect(onTuningNameChange).toHaveBeenLastCalledWith('');
  fireEvent.change(screen.getByLabelText('Preset'),{target:{value:'guitar-6-drop-d'}});expect(onTuningNameChange).toHaveBeenLastCalledWith('Drop D');
  expect(screen.getByRole('button',{name:'Saved tunings for Notes'})).toBeEnabled();view.rerender(<TuningInput {...props} disabled/>);expect(screen.getByRole('button',{name:'Saved tunings for Notes'})).toBeDisabled();
});
it('string pegs step semitones by button, keyboard, and drag and commit one undoable edit per gesture',()=>{
  const onCommit=vi.fn();
  render(<Draft onCommit={onCommit}/>);
  const peg6=screen.getByRole('slider',{name:'Notes string 6 peg'});
  expect(peg6).toHaveAttribute('aria-valuenow','40');
  expect(peg6).toHaveAttribute('aria-valuetext','E2');

  fireEvent.click(screen.getByRole('button',{name:'Tune Notes string 6 down'}));
  expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 D#2');
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenLastCalledWith([64,59,55,50,45,39]);

  fireEvent.keyDown(peg6,{key:'ArrowDown'});
  expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 D2');
  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(onCommit).toHaveBeenLastCalledWith([64,59,55,50,45,38]);

  // Pointer drag updates the draft live and commits once on pointerUp.
  const peg1=screen.getByRole('slider',{name:'Notes string 1 peg'});
  fireEvent.pointerDown(peg1,{pointerId:1,clientY:100});
  fireEvent.pointerMove(peg1,{pointerId:1,clientY:108});
  fireEvent.pointerMove(peg1,{pointerId:1,clientY:116});
  expect(screen.getByLabelText('Notes')).toHaveValue('D4 B3 G3 D3 A2 D2');
  expect(onCommit).toHaveBeenCalledTimes(2);
  fireEvent.pointerUp(peg1,{pointerId:1,clientY:116});
  expect(onCommit).toHaveBeenCalledTimes(3);
  expect(onCommit).toHaveBeenLastCalledWith([62,59,55,50,45,38]);
});

it('peg clicked with no movement commits nothing and preserves tuning name',()=>{
  const onCommit=vi.fn();
  render(<Draft onCommit={onCommit}/>);
  const peg=screen.getByRole('slider',{name:'Notes string 1 peg'});
  fireEvent.pointerDown(peg,{pointerId:1,clientY:100});
  fireEvent.pointerUp(peg,{pointerId:1,clientY:100});
  expect(onCommit).not.toHaveBeenCalled();
});

it('peg at limit by key or wheel records nothing',()=>{
  const onCommit=vi.fn();
  render(<Draft onCommit={onCommit}/>);
  const peg=screen.getByRole('slider',{name:'Notes string 1 peg'});
  // Peg starts at 64 (E4). Move to 127.
  for(let i=0;i<65;i++){
    fireEvent.keyDown(peg,{key:'PageUp'});
  }
  const countAtLimit=onCommit.mock.calls.length;
  // Key at limit (127) records nothing (Finding 2)
  fireEvent.keyDown(peg,{key:'ArrowUp'});
  expect(onCommit).toHaveBeenCalledTimes(countAtLimit);
});

it('lost pointer cancels drag, restores value, and commits nothing',()=>{
  const onCommit=vi.fn();
  render(<Draft onCommit={onCommit}/>);
  const peg=screen.getByRole('slider',{name:'Notes string 1 peg'});
  fireEvent.pointerDown(peg,{pointerId:2,clientY:100});
  fireEvent.pointerMove(peg,{pointerId:2,clientY:120});
  expect(screen.getByLabelText('Notes')).not.toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.pointerCancel(peg,{pointerId:2});
  expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2');
  expect(onCommit).not.toHaveBeenCalled();
});

it('pegs are focusable when disabled and ignore busy interactions',()=>{
  const onCommit=vi.fn();
  const {rerender}=render(<TuningInput label="Notes" presetLabel="Preset" value="E4 B3 G3 D3 A2 E2" onChange={vi.fn()} tuningName="Standard" onTuningNameChange={vi.fn()} onCommit={onCommit} disabled/>);
  const peg=screen.getByRole('slider',{name:'Notes string 1 peg'});
  expect(peg).toHaveAttribute('tabindex','0');
  expect(peg).toHaveAttribute('aria-disabled','true');
  fireEvent.pointerDown(peg,{pointerId:1,clientY:100});
  fireEvent.pointerMove(peg,{pointerId:1,clientY:120});
  fireEvent.pointerUp(peg,{pointerId:1,clientY:120});
  fireEvent.keyDown(peg,{key:'ArrowUp'});
  expect(onCommit).not.toHaveBeenCalled();
});

it('busy starting mid-drag drops commit and restores draft tuning and name', () => {
  const onCommit = vi.fn();
  const onChange = vi.fn();
  const onTuningNameChange = vi.fn();
  const props = {
    label: 'Notes',
    presetLabel: 'Preset',
    value: 'E4 B3 G3 D3 A2 E2',
    onChange,
    tuningName: 'Standard',
    onTuningNameChange,
    onCommit,
  };
  const { rerender } = render(<TuningInput {...props} />);
  const peg = screen.getByRole('slider', { name: 'Notes string 1 peg' });

  // Start drag while active
  fireEvent.pointerDown(peg, { pointerId: 1, clientY: 100, button: 0 });
  fireEvent.pointerMove(peg, { pointerId: 1, clientY: 80 });

  // Disabled / busy starts mid-drag
  rerender(<TuningInput {...props} disabled />);
  fireEvent.pointerUp(peg, { pointerId: 1, clientY: 80 });

  expect(onCommit).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenLastCalledWith('E4 B3 G3 D3 A2 E2');
  expect(onTuningNameChange).toHaveBeenLastCalledWith('Standard');
});

it('peg +/- buttons preserve focus through an edit when busy becomes true', () => {
  const onCommit = vi.fn();
  const props = {
    label: 'Notes',
    presetLabel: 'Preset',
    value: 'E4 B3 G3 D3 A2 E2',
    onChange: vi.fn(),
    tuningName: 'Standard',
    onTuningNameChange: vi.fn(),
    onCommit,
  };
  const { rerender } = render(<TuningInput {...props} />);
  const upBtn = screen.getByRole('button', { name: 'Tune Notes string 1 up' });
  upBtn.focus();
  expect(upBtn).toHaveFocus();

  // During edit busy becomes true
  rerender(<TuningInput {...props} disabled />);
  expect(upBtn).toHaveFocus();
  expect(upBtn).toHaveAttribute('aria-disabled', 'true');
});

it('wheel over an unfocused peg does not retune and focused wheel commits once after settling',()=>{
  vi.useFakeTimers();
  try{
    const onCommit=vi.fn();
    render(<Draft onCommit={onCommit}/>);
    const peg=screen.getByRole('slider',{name:'Notes string 1 peg'});

    // Unfocused wheel does nothing (Finding 5)
    fireEvent.wheel(peg,{deltaY:-100});
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Notes')).toHaveValue('E4 B3 G3 D3 A2 E2');

    // Focused wheel updates live and commits once after settling
    peg.focus();
    fireEvent.wheel(peg,{deltaY:-100});
    fireEvent.wheel(peg,{deltaY:-100});
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith([66,59,55,50,45,40]);
  }finally{
    vi.useRealTimers();
  }
});

it('7+ strings peg strip maintains single row layout',()=>{
  render(<TuningInput label="Notes" presetLabel="Preset" value="E4 B3 G3 D3 A2 E2 B1" onChange={vi.fn()} tuningName="7-String" onTuningNameChange={vi.fn()}/>);
  const strip=document.querySelector('.tp-tuning-peg-strip');
  expect(strip).toHaveStyle({'grid-template-columns':'repeat(7, minmax(0, 1fr))'});
});

it('fits 7+ strings in a compact peg strip layout without clipping', () => {
  render(<TuningInput label="Notes" presetLabel="Preset" value="E4 B3 G3 D3 A2 E2 C#2" onChange={vi.fn()} tuningName="Drop C#" onTuningNameChange={vi.fn()}/>);
  const pegs = document.querySelector('.tp-tuning-pegs');
  const strip = document.querySelector('.tp-tuning-peg-strip');
  expect(pegs).toHaveAttribute('data-compact', 'true');
  expect(strip).toHaveAttribute('data-compact', 'true');
  expect(strip).toHaveStyle({ gap: '2px' });
  const cells = document.querySelectorAll('.tp-tuning-peg-cell');
  expect(cells).toHaveLength(7);
  expect(screen.getByText('C#2')).toHaveClass('tp-peg-pitch');
});

it('9 strings peg strip enables horizontal scrolling to prevent clipping in narrow rails', () => {
  render(<TuningInput label="Notes" presetLabel="Preset" value="E4 B3 G3 D3 A2 E2 B1 F#1 C#1" onChange={vi.fn()} tuningName="9-String" onTuningNameChange={vi.fn()}/>);
  const strip = document.querySelector('.tp-tuning-peg-strip');
  expect(strip).toHaveStyle({ 'overflow-x': 'auto' });
  expect(strip).toHaveStyle({ 'grid-template-columns': 'repeat(9, minmax(20px, 1fr))' });
  const cells = document.querySelectorAll('.tp-tuning-peg-cell');
  expect(cells).toHaveLength(9);
});
