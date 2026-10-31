// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { NonTabPanel, NotationTrackControls } from './NonTabPanel';
import { TechniquePanel } from './TechniquePanel';
import { applyNonTabEdit } from './non-tab';
import { target } from './fixtures';
afterEach(cleanup);
function piano(percussion=false) {
  const score=new model.Score();score.addMasterBar(new model.MasterBar());applyNonTabEdit(score,{type:percussion?'addPercussionTrack':'addPitchedTrack',name:'Instrument',program:0});score.finish(new Settings());return score;
}
it('named pitched entry validates drafts and dispatches add, update and removal for the selected chord note',()=>{
  const score=piano(),onEdit=vi.fn(),onSelectNote=vi.fn(),props={score,target,noteIndex:null,busy:false,onEdit,onSelectNote};const view=render(<NonTabPanel {...props}/>);
  fireEvent.change(screen.getByLabelText('Written pitch'),{target:{value:'Db4'}});fireEvent.click(screen.getByRole('button',{name:'Add pitched note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPitchedNote',target,pitch:61});
  fireEvent.change(screen.getByLabelText('Written pitch'),{target:{value:'C4 E4'}});fireEvent.click(screen.getByRole('button',{name:'Add pitched note'}));expect(screen.getByRole('alert')).toHaveTextContent(/one note/i);
  applyNonTabEdit(score,{type:'addPitchedNote',target,pitch:60});applyNonTabEdit(score,{type:'addPitchedNote',target,pitch:64});view.rerender(<NonTabPanel {...props} noteIndex={1}/>);
  expect(screen.getByLabelText('Written pitch')).toHaveValue('E4');expect(screen.getByLabelText('Chord note')).toHaveValue('1');fireEvent.change(screen.getByLabelText('Chord note'),{target:{value:'0'}});expect(onSelectNote).toHaveBeenLastCalledWith(0);
  fireEvent.change(screen.getByLabelText('Written pitch'),{target:{value:'A4'}});fireEvent.click(screen.getByRole('button',{name:'Update pitched note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setPitchedNote',target,noteIndex:1,pitch:69});
  fireEvent.click(screen.getByRole('button',{name:'Remove selected note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:1});
  view.rerender(<NonTabPanel {...props} noteIndex={1} busy/>);expect(screen.getByRole('button',{name:'Add pitched note'})).toBeDisabled();
});
it('percussion entry exposes named standard and custom articulations and selected-note readback',()=>{
  const score=piano(true),onEdit=vi.fn(),onSelectNote=vi.fn();score.tracks[0].percussionArticulations=[new model.InstrumentArticulation('Custom shaker',-1,82)];applyNonTabEdit(score,{type:'addPercussionNote',target,articulation:0});
  const view=render(<NonTabPanel score={score} target={target} noteIndex={0} busy={false} onEdit={onEdit} onSelectNote={onSelectNote}/>);const choices=screen.getByLabelText('Percussion articulation');
  expect(within(choices).getByRole('option',{name:/Custom shaker/})).toHaveValue('0');expect(within(choices).getByRole('option',{name:/Snare \(rim shot\)/})).toHaveValue('91');expect(choices).toHaveValue('0');
  fireEvent.change(choices,{target:{value:'92'}});fireEvent.click(screen.getByRole('button',{name:'Update percussion note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setPercussionNote',target,noteIndex:0,articulation:92});fireEvent.click(screen.getByRole('button',{name:'Add percussion note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:92});
  view.rerender(<NonTabPanel score={score} target={{...target,beat:1}} noteIndex={null} busy={false} onEdit={onEdit} onSelectNote={onSelectNote}/>);expect(screen.getByRole('button',{name:'Update percussion note'})).toBeDisabled();
});
it('creates pitched and percussion tracks from finite name and program controls',()=>{
  const onEdit=vi.fn();render(<NotationTrackControls busy={false} onEdit={onEdit}/>);
  expect(within(screen.getByLabelText('New notation track program')).getByRole('option',{name:/Acoustic Grand Piano/})).toHaveValue('0');
  fireEvent.change(screen.getByLabelText('New notation track name'),{target:{value:'Keys'}});fireEvent.change(screen.getByLabelText('New notation track program'),{target:{value:'4'}});fireEvent.click(screen.getByRole('button',{name:'Add pitched track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPitchedTrack',name:'Keys',program:4});fireEvent.click(screen.getByRole('button',{name:'Add percussion track'}));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionTrack',name:'Keys',program:4});
});
it('shows written and sounding pitches as note names on a transposed pitched staff',()=>{
  const score=piano();score.tracks[0].staves[0].transpositionPitch=12;applyNonTabEdit(score,{type:'addPitchedNote',target,pitch:60});
  render(<NonTabPanel score={score} target={target} noteIndex={0} busy={false} onEdit={vi.fn()} onSelectNote={vi.fn()}/>);
  expect(screen.getByText(/Written C4; sounds C3/)).toBeInTheDocument();
});
it('generic technique controls use the selected note index, piano finger numbers and supported links',()=>{
  const score=piano(),onEdit=vi.fn();for(const beat of [0,1])for(const pitch of [60,64])applyNonTabEdit(score,{type:'addPitchedNote',target:{...target,beat},pitch});
  render(<TechniquePanel score={score} target={target} string={1} noteIndex={1} busy={false} onEdit={onEdit}/>);
  fireEvent.click(screen.getByLabelText('Ghost note'));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniquesByIndex',target,noteIndex:1,patch:{ghost:true}});
  expect(within(screen.getByLabelText('Left-hand finger')).getByRole('option',{name:'5 (little)'})).toHaveValue('4');fireEvent.change(screen.getByLabelText('Left-hand finger'),{target:{value:'4'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniquesByIndex',target,noteIndex:1,patch:{leftFinger:4}});
  expect(screen.getByLabelText('Palm mute')).toBeDisabled();expect(screen.getByLabelText('Pick stroke')).toBeDisabled();{const bend=screen.getByLabelText('Enable Bend'),before=onEdit.mock.calls.length;expect(bend).not.toHaveAttribute('disabled');expect(bend.closest('fieldset')).toHaveAttribute('aria-disabled','true');bend.focus();fireEvent.click(bend);expect(bend).not.toBeChecked();expect(bend).toHaveFocus();expect(onEdit.mock.calls.length).toBe(before);}expect(screen.getByRole('button',{name:'Hammer/pull to next'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Tie to next note'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLinkByIndex',from:{target,noteIndex:1},to:{target:{...target,beat:1},noteIndex:1},kind:'tie'});
  fireEvent.change(screen.getByLabelText('Slur note'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Create slur'}));expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteLinkByIndex',from:{target,noteIndex:1},to:{target:{...target,beat:1},noteIndex:1},kind:'slur'});
});
it('percussion techniques disable pitch and fingering effects while keeping dynamics usable',()=>{
  const score=piano(true),onEdit=vi.fn();applyNonTabEdit(score,{type:'addPercussionNote',target,articulation:91});render(<TechniquePanel score={score} target={target} string={1} noteIndex={0} busy={false} onEdit={onEdit}/>);
  for(const label of ['Left-hand finger','Right-hand finger','Vibrato','Ornament','Trill','Trill pitch','Trill speed'])expect(screen.getByLabelText(label)).toBeDisabled();fireEvent.change(screen.getByLabelText('Dynamics'),{target:{value:'3'}});expect(onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniquesByIndex',target,noteIndex:0,patch:{dynamics:3}});
});
