// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddTrackDialog } from './AddTrackDialog';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
const open=(props:Partial<Parameters<typeof AddTrackDialog>[0]>={})=>{const onAdd=vi.fn(),onClose=vi.fn();const view=render(<AddTrackDialog busy={false} onAdd={onAdd} onClose={onClose} {...props}/>);return {onAdd,onClose,view};};
const addDialog=()=>screen.getByRole('dialog',{name:'Add track'});
const tuning=()=>screen.getByRole('dialog',{name:'Tuning'});
const newEdit=()=>screen.getByRole('button',{name:/^Edit new track tuning/});
const notes=()=>within(tuning()).getByLabelText('Notes, high to low') as HTMLInputElement;
const inTuning=(name:string|RegExp)=>within(tuning()).getByRole('button',{name});
const select=(label:string,value:string)=>fireEvent.change(within(tuning()).getByLabelText(label),{target:{value}});

it('opens with the new track name focused, and Enter in it adds the track and closes',()=>{
  const {onAdd,onClose}=open();
  expect(screen.getByLabelText('New track name')).toHaveFocus();expect(screen.getByLabelText('New track name')).toHaveValue('Bass');
  fireEvent.change(screen.getByLabelText('New track name'),{target:{value:'Fretless'}});
  fireEvent.keyDown(screen.getByLabelText('New track name'),{key:'Enter'});
  expect(onAdd).toHaveBeenCalledTimes(1);expect(onAdd).toHaveBeenLastCalledWith({type:'addTrack',name:'Fretless',program:33,tuning:[43,38,33,28],tuningName:''});
  expect(onClose).toHaveBeenCalledTimes(1);
});
it('Add track records one edit and closes; Cancel and Escape add nothing',()=>{
  const {onAdd,onClose}=open();
  fireEvent.click(within(addDialog()).getByRole('button',{name:'Cancel'}));expect(onClose).toHaveBeenCalledTimes(1);expect(onAdd).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!,{key:'Escape'});expect(onClose).toHaveBeenCalledTimes(2);expect(onAdd).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('MIDI instrument'),{target:{value:'25'}});
  fireEvent.click(within(addDialog()).getByRole('button',{name:'Add track'}));expect(onAdd).toHaveBeenCalledTimes(1);expect(onAdd).toHaveBeenLastCalledWith({type:'addTrack',name:'Bass',program:25,tuning:[43,38,33,28],tuningName:''});
  expect(onClose).toHaveBeenCalledTimes(3);
});
it('keeps both notation track buttons, each one edit, and closes after them',()=>{
  const {onAdd,onClose}=open();
  fireEvent.change(screen.getByLabelText('New notation track name'),{target:{value:'Piano'}});fireEvent.change(screen.getByLabelText('New notation track program'),{target:{value:'5'}});
  fireEvent.click(screen.getByRole('button',{name:'Add pitched track'}));expect(onAdd).toHaveBeenLastCalledWith({type:'addPitchedTrack',name:'Piano',program:5});expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Add percussion track'}));expect(onAdd).toHaveBeenLastCalledWith({type:'addPercussionTrack',name:'Piano',program:5});expect(onAdd).toHaveBeenCalledTimes(2);
});
it('refuses every add while busy, keeps focus on the name, and while the document is finalized',()=>{
  const {onAdd,onClose,view}=open({busy:true});
  const name=screen.getByLabelText('New track name');expect(name).toHaveFocus();
  fireEvent.keyDown(name,{key:'Enter'});
  for(const label of ['Add track','Add pitched track','Add percussion track']){const button=screen.getAllByRole('button',{name:label}).at(-1)!;fireEvent.click(button);expect(button.closest('[aria-disabled="true"],fieldset:disabled')??button).not.toBeNull();}
  expect(onAdd).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
  view.rerender(<AddTrackDialog busy={false} locked onAdd={onAdd} onClose={onClose}/>);
  fireEvent.keyDown(screen.getByLabelText('New track name'),{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'Add pitched track'}));expect(onAdd).not.toHaveBeenCalled();
});
it('uses the Tuning dialog as a draft: Use tuning fills only the new track, Cancel leaves it, and nothing is recorded until Add track',()=>{
  const {onAdd}=open();
  expect(newEdit()).toHaveTextContent('G2 D2 A1 E1');
  newEdit().focus();fireEvent.click(newEdit());expect(within(tuning()).queryByRole('button',{name:'Keep pitch'})).toBeNull();expect(within(tuning()).queryByRole('button',{name:'Keep fingering'})).toBeNull();
  fireEvent.change(notes(),{target:{value:'G2 bad'}});fireEvent.click(inTuning('Use tuning'));
  expect(tuning()).toBeInTheDocument();expect(notes()).toHaveAttribute('aria-invalid','true');expect(within(tuning()).getByRole('alert')).toHaveTextContent('bad');expect(onAdd).not.toHaveBeenCalled();
  fireEvent.click(inTuning('Cancel'));expect(newEdit()).toHaveFocus();expect(newEdit()).toHaveTextContent('G2 D2 A1 E1');expect(addDialog()).toBeInTheDocument();
  fireEvent.click(newEdit());select('Instrument','bass');select('Number of strings','4');select('Preset','bass-4-drop-d');expect(notes()).toHaveValue('G2 D2 A1 D1');fireEvent.click(inTuning('Use tuning'));
  expect(newEdit()).toHaveTextContent('G2 D2 A1 D1');expect(onAdd).not.toHaveBeenCalled();
  fireEvent.click(within(addDialog()).getByRole('button',{name:'Add track'}));expect(onAdd).toHaveBeenLastCalledWith({type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,26],tuningName:'Drop D'});
});
it('accepts any string count for a track that does not exist yet, and Escape in the Tuning dialog leaves the Add track dialog open',()=>{
  const {onAdd,onClose}=open();
  fireEvent.click(newEdit());fireEvent.change(notes(),{target:{value:'E4 B3 G3 D3 A2 E2 B1'}});expect(within(tuning()).queryByLabelText('Strings kept in place')).toBeNull();fireEvent.click(inTuning('Use tuning'));
  fireEvent.click(newEdit());fireEvent.keyDown(document.activeElement!,{key:'Escape'});expect(screen.queryByRole('dialog',{name:'Tuning'})).toBeNull();expect(addDialog()).toBeInTheDocument();expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(within(addDialog()).getByRole('button',{name:'Add track'}));expect(onAdd).toHaveBeenLastCalledWith({type:'addTrack',name:'Bass',program:33,tuning:[64,59,55,50,45,40,35],tuningName:''});
});
