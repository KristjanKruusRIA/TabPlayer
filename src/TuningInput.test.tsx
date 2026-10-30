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
