// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {forgetSessionSoundLibrary,forgetSoundClipboard,readSoundLibrary} from './sound-library';
beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();forgetSessionSoundLibrary();forgetSoundClipboard();localStorage.clear();});

const edited=(onEdit:ReturnType<typeof vi.fn>)=>onEdit.mock.calls.at(-1)?.[0].sound;

it('saves the current sound by name and applies it to another track as one edit',()=>{
  const lead=soundPreset('lead');lead.effects.tremolo={enabled:true,rateHz:6,depth:.9,shape:'square'};
  const onEdit=vi.fn();const {rerender}=render(<SoundPanel trackId="base/0" sound={lead} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Saved sound name'),{target:{value:'Wobble lead'}});
  fireEvent.click(screen.getByRole('button',{name:'Save sound'}));
  expect(screen.getByRole('status')).toHaveTextContent('Saved “Wobble lead”.');
  expect(readSoundLibrary().map(entry=>entry.name)).toEqual(['Wobble lead']);
  expect(onEdit).not.toHaveBeenCalled();
  rerender(<SoundPanel trackId="base/1" sound={soundPreset('bass')} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Saved sound'),{target:{value:'Wobble lead'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply saved sound'}));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0][0]).toMatchObject({type:'setTrackSound',trackId:'base/1'});
  expect(edited(onEdit)).toEqual(lead);
});

it('reports an applied sound only once the edit is accepted, and clears messages on another track',async()=>{
  const lead=soundPreset('lead');let reject=true;
  const onEdit=vi.fn(async()=>{if(reject)throw new Error('Native player refused the sound.');});
  const {rerender}=render(<SoundPanel trackId="base/0" sound={lead} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Saved sound name'),{target:{value:'Lead'}});fireEvent.click(screen.getByRole('button',{name:'Save sound'}));
  fireEvent.change(screen.getByLabelText('Saved sound'),{target:{value:'Lead'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply saved sound'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Native player refused the sound.');
  expect(screen.getByRole('status')).toHaveTextContent('Saved “Lead”.');
  reject=false;fireEvent.click(screen.getByRole('button',{name:'Apply saved sound'}));
  expect(await screen.findByText('Applied “Lead”.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Delete saved sound'}));
  rerender(<SoundPanel trackId="base/1" sound={soundPreset('bass')} onEdit={onEdit}/>);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  expect(screen.queryByRole('group',{name:'Delete “Lead”?'})).toBeNull();
});

it('renames and deletes saved sounds after confirmation',()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('crunch')} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Saved sound name'),{target:{value:'Rhythm'}});fireEvent.click(screen.getByRole('button',{name:'Save sound'}));
  fireEvent.change(screen.getByLabelText('Saved sound'),{target:{value:'Rhythm'}});
  fireEvent.change(screen.getByLabelText('Saved sound name'),{target:{value:'Chug'}});fireEvent.click(screen.getByRole('button',{name:'Rename saved sound'}));
  expect(readSoundLibrary().map(entry=>entry.name)).toEqual(['Chug']);
  expect(screen.getByLabelText('Saved sound')).toHaveValue('Chug');
  fireEvent.click(screen.getByRole('button',{name:'Delete saved sound'}));
  // Deleting is not undoable, so it asks first.
  expect(readSoundLibrary()).toHaveLength(1);
  const confirm=screen.getByRole('group',{name:'Delete “Chug”?'});
  expect(within(confirm).getByRole('button',{name:'Cancel'})).toHaveFocus();
  fireEvent.click(within(confirm).getByRole('button',{name:'Cancel'}));expect(readSoundLibrary()).toHaveLength(1);
  expect(screen.getByLabelText('Saved sound')).toHaveFocus();
  fireEvent.click(screen.getByRole('button',{name:'Delete saved sound'}));
  fireEvent.click(within(screen.getByRole('group',{name:'Delete “Chug”?'})).getByRole('button',{name:'Delete'}));
  expect(readSoundLibrary()).toEqual([]);
  expect(screen.getByRole('button',{name:'Apply saved sound'})).toBeDisabled();
  expect(onEdit).not.toHaveBeenCalled();
});

it('copies and pastes a whole sound and single pedals between tracks',()=>{
  const lead=soundPreset('lead');lead.effects.delay={enabled:true,quarterNotes:.5,feedback:.6,mix:.4};
  const onEdit=vi.fn();const {rerender}=render(<SoundPanel trackId="base/0" sound={lead} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Paste sound'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Paste pedal: Delay'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Copy sound'}));
  fireEvent.click(screen.getByRole('button',{name:'Copy pedal: Delay'}));
  const bass=soundPreset('bass');rerender(<SoundPanel trackId="base/1" sound={bass} onEdit={onEdit}/>);
  // A copied delay only pastes into the delay pedal.
  expect(screen.getByRole('button',{name:'Paste pedal: Reverb'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Paste pedal: Delay'}));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(edited(onEdit)).toEqual({...bass,effects:{...bass.effects,delay:lead.effects.delay}});
  fireEvent.click(screen.getByRole('button',{name:'Paste sound'}));
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(onEdit.mock.calls[1][0]).toMatchObject({type:'setTrackSound',trackId:'base/1'});
  expect(edited(onEdit)).toEqual(lead);
});
