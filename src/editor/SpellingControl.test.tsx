// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { SpellingControl } from './SpellingControl';
import { applyPitchEdit } from './pitch';
import { music, noteAt, target } from './fixtures';

afterEach(cleanup);
it('changes the selected chord note spelling while preserving pitch and other notes',()=>{
  const score=music(),beat=noteAt(score).beat,second=new model.Note();second.string=5;second.fret=2;beat.addNote(second);
  const pitch=second.realValue;
  render(<SpellingControl score={score} target={target} noteIndex={1} busy={false} onEdit={edit=>{applyPitchEdit(score,edit);}}/>);
  expect(screen.getAllByRole('option')).toHaveLength(7);fireEvent.change(screen.getByLabelText('Enharmonic spelling'),{target:{value:'5'}});
  expect(second.accidentalMode).toBe(5);expect(second.realValue).toBe(pitch);expect(noteAt(score).accidentalMode).toBe(0);
});

it('shows history readback and disables absent notes, percussion and busy edits',()=>{
  const score=music(),props={score,target,noteIndex:0,busy:false,onEdit:()=>{}},view=render(<SpellingControl {...props}/>);
  noteAt(score).accidentalMode=4;view.rerender(<SpellingControl {...props}/>);expect(screen.getByLabelText('Enharmonic spelling')).toHaveValue('4');
  view.rerender(<SpellingControl {...props} busy/>);expect(screen.getByLabelText('Enharmonic spelling')).toBeDisabled();
  view.rerender(<SpellingControl {...props} noteIndex={1}/>);expect(screen.getByLabelText('Enharmonic spelling')).toBeDisabled();
  score.tracks[0].staves[0].isPercussion=true;view.rerender(<SpellingControl {...props}/>);expect(screen.getByLabelText('Enharmonic spelling')).toBeDisabled();
});
