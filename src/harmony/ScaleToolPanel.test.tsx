// @vitest-environment jsdom
import { afterEach,expect,it } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { music,target } from '../editor/fixtures';
import { ScaleToolPanel } from './ScaleToolPanel';
afterEach(cleanup);
it('browses_sixteen_patterns_twelve_roots_notes_intervals_tags_and_custom_scales_without_a_score_edit',()=>{
  const score=music(),before=model.JsonConverter.scoreToJson(score);render(<ScaleToolPanel score={score} selection={null} busy={false} onClose={()=>{}}/>);
  expect(within(screen.getByLabelText('Scale root')).getAllByRole('option')).toHaveLength(12);expect(within(screen.getByLabelText('Scale pattern')).getAllByRole('option')).toHaveLength(17);
  expect(screen.getByLabelText('Scale notes')).toHaveTextContent('C4 D4 E4 F4 G4 A4 B4 C5');expect(screen.getByLabelText('Adjacent semitones')).toHaveTextContent('2 2 1 2 2 2 1');
  fireEvent.change(screen.getByLabelText('Search scales'),{target:{value:'aeolian'}});expect(within(screen.getByLabelText('Scale pattern')).getByRole('option',{name:'Natural minor / Aeolian'})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search scales'),{target:{value:''}});fireEvent.click(within(screen.getByRole('radiogroup',{name:'Scale tag'})).getByRole('radio',{name:'pentatonic'}));expect(within(screen.getByLabelText('Scale pattern')).getAllByRole('option')).toHaveLength(3);
  fireEvent.change(screen.getByLabelText('Scale pattern'),{target:{value:'custom'}});fireEvent.change(screen.getByLabelText('Custom intervals'),{target:{value:'0, 3, 7'}});fireEvent.change(screen.getByLabelText('Scale root'),{target:{value:'2'}});
  expect(screen.getByLabelText('Scale notes')).toHaveTextContent('D4 F4 A4 D5');expect(screen.getByLabelText('Adjacent semitones')).toHaveTextContent('3 4 5');fireEvent.change(screen.getByLabelText('Custom intervals'),{target:{value:'0, 3, 3'}});expect(screen.getByRole('alert')).toHaveTextContent('unique');
  expect(screen.queryByRole('button',{name:/audition|insert/i})).not.toBeInTheDocument();expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('selection_matches_count_distinct_sounding_classes_and_exclude_dead_and_percussion_notes',()=>{
  const score=music(),staff=score.tracks[0].staves[0],beat=staff.bars[0].voices[0].beats[0];staff.stringTuning.tunings=[60,64,67];staff.capo=2;staff.transpositionPitch=2;beat.notes=[];
  for(const string of [3,2,1]){const note=new model.Note();note.string=string;note.fret=0;beat.addNote(note);}const dead=new model.Note();dead.string=3;dead.fret=1;dead.isDead=true;beat.addNote(dead);
  const selection={kind:'notes' as const,notes:[0,1,2,3].map(noteIndex=>({target,noteIndex}))},before=model.JsonConverter.scoreToJson(score),view=render(<ScaleToolPanel score={score} selection={selection} busy={false} onClose={()=>{}}/>);
  expect(screen.getByText('C Major / Ionian: 3 / 3 selected classes, 4 extra tones')).toBeInTheDocument();expect(screen.getByLabelText('Scale fretboard')).toBeInTheDocument();expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  staff.isPercussion=true;view.rerender(<ScaleToolPanel score={score} selection={selection} busy={false} onClose={()=>{}}/>);expect(screen.getByText('Select melodic notes to match scales.')).toBeInTheDocument();
});
it('scale_modal_restores_focus_traps_tabs_and_keeps_close_available_while_busy',()=>{
  const score=music();score.tracks[0].staves[0].stringTuning.tunings=[];const opener=document.createElement('button');document.body.append(opener);opener.focus();const closed:string[]=[],props={score,selection:null,busy:false,onClose:()=>closed.push('closed')},view=render(<ScaleToolPanel {...props}/>);
  expect(screen.getByLabelText('Scale keyboard')).toBeInTheDocument();const root=screen.getByLabelText('Scale root'),headClose=screen.getByRole('button',{name:'Close'}),close=screen.getByRole('button',{name:'Close scales'});expect(root).toHaveFocus();headClose.focus();fireEvent.keyDown(headClose,{key:'Tab',shiftKey:true});expect(close).toHaveFocus();fireEvent.keyDown(close,{key:'Tab'});expect(headClose).toHaveFocus();
  view.rerender(<ScaleToolPanel {...props} busy/>);expect(root).toBeDisabled();expect(close).toHaveFocus();fireEvent.keyDown(close,{key:'Escape'});expect(closed).toEqual(['closed']);view.unmount();expect(opener).toHaveFocus();opener.remove();
});
it('out_of_range_sounding_selection_is_reported_without_crashing_the_browser',()=>{
  const score=music();score.tracks[0].staves[0].transpositionPitch=127;render(<ScaleToolPanel score={score} selection={{kind:'notes',notes:[{target,noteIndex:0}]}} busy={false} onClose={()=>{}}/>);expect(screen.getByRole('alert')).toHaveTextContent('0 to 127');
});
it('valid_fretted_scale_tones_remain_visible_when_the_open_pitch_is_below_midi_zero',()=>{
  const score=music(),staff=score.tracks[0].staves[0];staff.stringTuning.tunings=[0];staff.transpositionPitch=1;const before=model.JsonConverter.scoreToJson(score);render(<ScaleToolPanel score={score} selection={null} busy={false} onClose={()=>{}}/>);
  expect(screen.getByLabelText('String 1 fret 1: C-1, root')).toBeInTheDocument();expect(screen.queryByLabelText(/String 1 fret 0:/)).not.toBeInTheDocument();expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
