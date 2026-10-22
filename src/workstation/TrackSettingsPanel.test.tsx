// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import { tuningPresets } from '../tuning-presets';
import { formatTuning } from '../tuning';
import { TrackSettingsPanel } from './TrackSettingsPanel';
import { trackColorHex } from '../track-color';
afterEach(cleanup);
it('all 128 programs are selectable and existing track settings dispatch exact payload',()=>{
  const score=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}).score,onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  const select=screen.getByLabelText('Track MIDI instrument');expect(select.querySelectorAll('option')).toHaveLength(128);
  fireEvent.change(screen.getByLabelText('Track name'),{target:{value:'Lead'}});fireEvent.change(screen.getByLabelText('Track short name'),{target:{value:'Ld'}});fireEvent.change(select,{target:{value:'127'}});fireEvent.click(screen.getByRole('button',{name:'Apply instrument settings'}));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackInfo',track:0,name:'Lead',shortName:'Ld',program:127});
});
it('existing and new track tuning use note names and reject invalid drafts without an edit',()=>{
  const score=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3}).score,onEdit=vi.fn();render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  const input=screen.getByLabelText('Tuning (notes, high to low)');expect(input).toHaveValue('E4 B3 G3 D3 A2 E2');
  fireEvent.change(input,{target:{value:'E4 B3 G3 D3 A2 D2'}});fireEvent.click(screen.getByRole('button',{name:'Apply tuning'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setTuning',track:0,tuning:[64,59,55,50,45,38]});onEdit.mockClear();
  fireEvent.change(input,{target:{value:'E4 B3 nope'}});fireEvent.click(screen.getByRole('button',{name:'Apply tuning'}));expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent(/note.*octave|E4/i);
  fireEvent.click(screen.getByText('Add instrument'));expect(screen.getByLabelText('New track tuning')).toHaveValue('G2 D2 A1 E1');fireEvent.change(screen.getByLabelText('New track tuning'),{target:{value:'G2 D2 A1 Eb1'}});fireEvent.click(screen.getByRole('button',{name:'Add track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addTrack',name:'Bass',program:33,tuning:[43,38,33,27]});
});
it('starts Add instrument collapsed and keeps invalid feedback with its own tuning draft',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score,onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  const add=screen.getByText('Add instrument').closest('details')!;
  expect(add).not.toHaveAttribute('open');
  const current=screen.getByLabelText('Tuning (notes, high to low)'),draft=screen.getByLabelText('New track tuning');
  fireEvent.change(current,{target:{value:'E4 wrong'}});fireEvent.click(screen.getByRole('button',{name:'Apply tuning'}));
  expect(current).toHaveValue('E4 wrong');expect(current).toHaveFocus();expect(current).toHaveAttribute('aria-invalid','true');
  const currentError=screen.getByRole('alert');expect(current).toHaveAttribute('aria-describedby',currentError.id);expect(current.parentElement!.nextElementSibling).toBe(currentError);expect(draft).not.toHaveAttribute('aria-invalid','true');
  fireEvent.click(screen.getByText('Add instrument'));fireEvent.change(draft,{target:{value:'G2 bad'}});fireEvent.click(screen.getByRole('button',{name:'Add track'}));
  expect(draft).toHaveValue('G2 bad');expect(draft).toHaveFocus();expect(draft).toHaveAttribute('aria-invalid','true');
  const draftError=document.getElementById(draft.getAttribute('aria-describedby')!)!;expect(draft.parentElement!.nextElementSibling).toBe(draftError);expect(draftError).toHaveTextContent('bad');expect(currentError).toHaveTextContent('wrong');
  fireEvent.change(draft,{target:{value:'G2 D2 A1 E1'}});expect(draft).not.toHaveAttribute('aria-invalid','true');expect(currentError).toBeInTheDocument();
  draft.focus();fireEvent.click(screen.getByRole('button',{name:'Apply tuning'}));expect(current).toHaveFocus();expect(onEdit).not.toHaveBeenCalled();
});
it('tuning readback refreshes after same-index history replacement',()=>{
  const before=previewEdit(blankProject(),{type:'setTuning',track:0,tuning:[64,59,55,50,45,38]}).score,onEdit=vi.fn();const props={selected:0,busy:false,onEdit};const view=render(<TrackSettingsPanel {...props} score={before}/>);expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue('E4 B3 G3 D3 A2 D2');
  view.rerender(<TrackSettingsPanel {...props} score={previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score}/>);expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue('E4 B3 G3 D3 A2 E2');
});
it('reveals the invalid field with its existing error again after focus moves away',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score;
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={()=>{}}/>);
  const input=screen.getByLabelText('Tuning (notes, high to low)'),apply=screen.getByRole('button',{name:'Apply tuning'});
  fireEvent.change(input,{target:{value:'bad'}});fireEvent.click(apply);
  const scroll=vi.fn();screen.getByRole('alert').parentElement!.scrollIntoView=scroll;
  screen.getByRole('button',{name:'Apply instrument settings'}).focus();fireEvent.click(apply);
  expect(input).toHaveFocus();expect(scroll).toHaveBeenCalledWith({block:'nearest'});
});
it('presets keep manual notes independent from program choice and disable existing percussion tuning',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score,onEdit=vi.fn(),props={score,selected:0,busy:false,onEdit};const view=render(<TrackSettingsPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Tuning preset'),{target:{value:'guitar-6-open-d'}});expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue('D4 A3 F#3 D3 A2 D2');fireEvent.change(screen.getByLabelText('Track MIDI instrument'),{target:{value:'33'}});expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue('D4 A3 F#3 D3 A2 D2');expect(onEdit).not.toHaveBeenCalled();
  score.tracks[0].staves[0].isPercussion=true;view.rerender(<TrackSettingsPanel {...props}/>);expect(screen.getByLabelText('Tuning preset')).toBeDisabled();expect(screen.getByLabelText('Tuning (notes, high to low)')).toBeDisabled();view.rerender(<TrackSettingsPanel {...props} busy/>);expect(screen.getByLabelText('New track tuning preset')).toBeDisabled();expect(screen.getByLabelText('New track tuning')).toBeDisabled();
});

it('retains manual, new-track and notation drafts while its mounted pane is hidden',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score,onEdit=vi.fn();
  const pane=(hidden:boolean)=><div hidden={hidden}><TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/></div>;
  const view=render(pane(false));
  fireEvent.change(screen.getByLabelText('Tuning (notes, high to low)'),{target:{value:'E4 B3 G3 D3 A2 D2'}});
  fireEvent.click(screen.getByText('Add instrument'));fireEvent.change(screen.getByLabelText('New track name'),{target:{value:'Fretless'}});
  fireEvent.change(screen.getByLabelText('New track tuning'),{target:{value:'G2 D2 A1 D1'}});
  fireEvent.change(screen.getByLabelText('New notation track name'),{target:{value:'Keys'}});
  view.rerender(pane(true));view.rerender(pane(false));
  expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue('E4 B3 G3 D3 A2 D2');
  expect(screen.getByLabelText('New track name')).toHaveValue('Fretless');expect(screen.getByLabelText('New track tuning')).toHaveValue('G2 D2 A1 D1');
  expect(screen.getByText('Add instrument').closest('details')).toHaveAttribute('open');
  expect(screen.getByLabelText('New notation track name')).toHaveValue('Keys');expect(onEdit).not.toHaveBeenCalled();
});
it('keeps full long track names accessible and selected/remove/notation command payloads intact',()=>{
  const name='Lead guitar with a deliberately long descriptive name for the live arrangement';
  const added=previewEdit(blankProject(),{type:'addTrack',name,tuning:[64,59,55,50,45,40],program:24}),onEdit=vi.fn();
  render(<TrackSettingsPanel score={added.score} selected={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByRole('heading',{name})).toHaveAttribute('title',name);expect(screen.getByLabelText('Track name')).toHaveValue(name);
  fireEvent.click(screen.getByRole('button',{name:'Remove track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'removeTrack',track:1});
  // The last of two tracks can move up only.
  expect(screen.getByRole('button',{name:'Move track down'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Move track up'}));expect(onEdit).toHaveBeenLastCalledWith({type:'moveTrack',track:1,to:0});
  cleanup();render(<TrackSettingsPanel score={added.score} selected={0} busy={false} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Move track up'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Move track down'}));expect(onEdit).toHaveBeenLastCalledWith({type:'moveTrack',track:0,to:1});
  fireEvent.click(screen.getByRole('button',{name:'Duplicate track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'duplicateTrack',track:0});
  const color=screen.getByLabelText('Track color');expect(color).toHaveValue(trackColorHex(added.score.tracks[0].color));
  fireEvent.change(color,{target:{value:'#ff8800'}});fireEvent.click(screen.getByRole('button',{name:'Apply track color'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setTrackColor',track:0,color:'#ff8800'});
  // Another track shows its own color, and an unchanged color can't be applied as an empty Undo step.
  const recolored=previewEdit(added.project,{type:'setTrackColor',track:1,color:'#00ff00'}).score;cleanup();render(<TrackSettingsPanel score={recolored} selected={1} busy={false} onEdit={onEdit}/>);
  expect(screen.getByLabelText('Track color')).toHaveValue('#00ff00');expect(screen.getByRole('button',{name:'Apply track color'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('New notation track name'),{target:{value:'Piano'}});fireEvent.change(screen.getByLabelText('New notation track program'),{target:{value:'5'}});
  fireEvent.click(screen.getByRole('button',{name:'Add pitched track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPitchedTrack',name:'Piano',program:5});
  fireEvent.click(screen.getByRole('button',{name:'Add percussion track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionTrack',name:'Piano',program:5});
});
it('retains all 25 guitar 6–9 and bass 4–6 presets for both tuning drafts',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score,onEdit=vi.fn();
  render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit}/>);
  expect(tuningPresets).toHaveLength(25);
  expect(new Set(tuningPresets.filter(p=>p.instrument==='guitar').map(p=>p.strings))).toEqual(new Set([6,7,8,9]));
  expect(new Set(tuningPresets.filter(p=>p.instrument==='bass').map(p=>p.strings))).toEqual(new Set([4,5,6]));
  for(const preset of tuningPresets){
    fireEvent.change(screen.getByLabelText('Tuning preset'),{target:{value:preset.id}});expect(screen.getByLabelText('Tuning (notes, high to low)')).toHaveValue(formatTuning(preset.tuning));
    fireEvent.change(screen.getByLabelText('New track tuning preset'),{target:{value:preset.id}});expect(screen.getByLabelText('New track tuning')).toHaveValue(formatTuning(preset.tuning));
  }
  expect(onEdit).not.toHaveBeenCalled();
});
it('disables removal for the sole track and all commits while busy',()=>{
  const score=previewEdit(blankProject(),{type:'setRest',target:{track:0,staff:0,bar:0,voice:0,beat:0}}).score;
  const view=render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={()=>{}}/>);
  expect(screen.getByRole('button',{name:'Remove track'})).toBeDisabled();
  view.rerender(<TrackSettingsPanel score={score} selected={0} busy onEdit={()=>{}}/>);
  for(const name of ['Apply tuning','Apply instrument settings','Add track','Add pitched track','Add percussion track'])expect(screen.getByRole('button',{name})).toBeDisabled();
});
