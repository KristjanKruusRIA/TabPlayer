// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TuningInput } from './TuningInput';
import { TrackSettingsPanel } from './workstation/TrackSettingsPanel';
import { StructurePanel } from './editor/StructurePanel';
import { SavedTuningsDialog } from './tuning/SavedTuningsDialog';
import { buildScore, trackIdentity } from './engine';
import { blankProject } from './project';
import { tuningAudition } from './audio/audition';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({format:'tabplayer-tuning-library',version:1,entries:[]}))}));
afterEach(cleanup);
const standard=[64,59,55,50,45,40];
function Draft({onAudition,start='E4 B3 G3 D3 A2 E2',disabled=false}:{onAudition?:(pitches:number[],strum:boolean)=>void;start?:string;disabled?:boolean}){
  const [value,onChange]=useState(start),[name,setName]=useState('');
  return <TuningInput label="Notes" presetLabel="Preset" value={value} onChange={onChange} tuningName={name} onTuningNameChange={setName} onAudition={onAudition} disabled={disabled}/>;
}
it('offers a button per string, high string first, plus Play tuning, only while the typed draft parses',()=>{
  const onAudition=vi.fn();render(<Draft onAudition={onAudition}/>);
  const names=screen.getAllByRole('button',{name:/^Play string/}).map(button=>button.getAttribute('aria-label'));
  expect(names).toEqual(['Play string 1 (E4)','Play string 2 (B3)','Play string 3 (G3)','Play string 4 (D3)','Play string 5 (A2)','Play string 6 (E2)']);
  fireEvent.click(screen.getByRole('button',{name:'Play string 6 (E2)'}));expect(onAudition).toHaveBeenLastCalledWith([40],false);
  fireEvent.click(screen.getByRole('button',{name:'Play string 1 (E4)'}));expect(onAudition).toHaveBeenLastCalledWith([64],false);
  fireEvent.click(screen.getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith(standard,true);
  // The draft is what is heard, not an applied tuning.
  fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'D4 B3 G3 D3 A2 D2'}});
  fireEvent.click(screen.getByRole('button',{name:'Play string 6 (D2)'}));expect(onAudition).toHaveBeenLastCalledWith([38],false);
  fireEvent.change(screen.getByLabelText('Notes'),{target:{value:'D4 B3 nope'}});
  expect(screen.queryByRole('button',{name:/^Play/})).not.toBeInTheDocument();expect(onAudition).toHaveBeenCalledTimes(4);
});
it('shows no audition buttons without a handler and disables them with the field',()=>{
  const view=render(<Draft/>);expect(screen.queryByRole('button',{name:/^Play/})).not.toBeInTheDocument();view.unmount();
  render(<Draft onAudition={vi.fn()} disabled/>);expect(screen.getByRole('button',{name:'Play tuning'})).toBeDisabled();expect(screen.getByRole('button',{name:'Play string 1 (E4)'})).toBeDisabled();
});
it('turns a strum into the exact low-to-high payload',()=>{
  expect(tuningAudition(standard,true).notes.map(note=>[note.key,note.startMs])).toEqual([[40,0],[45,60],[50,120],[55,180],[59,240],[64,300]]);
  expect(tuningAudition([40],false)).toEqual({notes:[{key:40,startMs:0,velocity:96}],durationMs:1500});
});
it('auditions the addressed track for its tuning and the default sound of the chosen program for a new track',()=>{
  const score=buildScore(blankProject()),onAudition=vi.fn(),id=trackIdentity(score.tracks[0]);
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={vi.fn()} onAudition={onAudition}/>);
  fireEvent.click(screen.getAllByRole('button',{name:'Play string 6 (E2)'})[0]);expect(onAudition).toHaveBeenLastCalledWith({trackId:id},[40],false);
  fireEvent.click(screen.getAllByRole('button',{name:'Play tuning'})[0]);expect(onAudition).toHaveBeenLastCalledWith({trackId:id},standard,true);
  fireEvent.click(screen.getByText('Add instrument'));fireEvent.change(screen.getByLabelText('MIDI instrument'),{target:{value:'33'}});
  const field=screen.getByLabelText('New track tuning').closest('.tuning-field') as HTMLElement;
  fireEvent.click(within(field).getByRole('button',{name:'Play string 4 (E1)'}));expect(onAudition).toHaveBeenLastCalledWith({program:33},[28],false);
  fireEvent.click(within(field).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({program:33},[43,38,33,28],true);
});
it('auditions the structure panel staff tuning through the addressed track and sends no edit',()=>{
  const score=buildScore({...blankProject(),edits:[{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}]}),onAudition=vi.fn(),onEdit=vi.fn();
  render(<StructurePanel score={score} target={{track:1,staff:0,bar:0,voice:0,beat:0}} string={1} busy={false} onEdit={onEdit} onSelect={vi.fn()} onAudition={onAudition}/>);
  fireEvent.click(screen.getByText('Staff, voices & layout'));
  fireEvent.click(screen.getByRole('button',{name:'Play string 1 (G2)'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:trackIdentity(score.tracks[1])},[43],false);
  fireEvent.click(screen.getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith({trackId:trackIdentity(score.tracks[1])},[43,38,33,28],true);
  expect(onEdit).not.toHaveBeenCalled();
});
it('plays the details pitches of the saved-tunings dialog',()=>{
  const onAudition=vi.fn();render(<SavedTuningsDialog notes="E4 B3 G3 D3 A2 E2" name="" onUse={vi.fn()} onClose={vi.fn()} onAudition={onAudition}/>);
  const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Play string 5 (A2)'}));expect(onAudition).toHaveBeenLastCalledWith([45],false);
  fireEvent.change(within(dialog).getByLabelText('Saved tuning pitches (notes, high to low)'),{target:{value:'D4 A3 F3 C3'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Play tuning'}));expect(onAudition).toHaveBeenLastCalledWith([62,57,53,48],true);
});
