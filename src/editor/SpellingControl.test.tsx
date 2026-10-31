// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { SpellingControl } from './SpellingControl';
import { applyPitchEdit } from './pitch';
import { isNoteCautionary } from './cautionary';
import userEvent from '@testing-library/user-event';
import type { EditCommand } from '../edit-types';
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
  const score=music(),edits:EditCommand[]=[],props={score,target,noteIndex:0,busy:false,onEdit:(edit:EditCommand)=>{edits.push(edit);}},view=render(<SpellingControl {...props}/>);
  noteAt(score).accidentalMode=4;view.rerender(<SpellingControl {...props}/>);expect(screen.getByLabelText('Enharmonic spelling')).toHaveValue('4');
  view.rerender(<SpellingControl {...props} busy/>);expect(screen.getByLabelText('Enharmonic spelling')).not.toBeDisabled();expect(screen.getByLabelText('Enharmonic spelling')).toHaveAttribute('aria-disabled','true');
  fireEvent.change(screen.getByLabelText('Enharmonic spelling'),{target:{value:'5'}});expect(edits).toEqual([]);
  view.rerender(<SpellingControl {...props} noteIndex={1}/>);expect(screen.getByLabelText('Enharmonic spelling')).toBeDisabled();
  score.tracks[0].staves[0].isPercussion=true;view.rerender(<SpellingControl {...props}/>);expect(screen.getByLabelText('Enharmonic spelling')).toBeDisabled();
});

it('toggles the cautionary mark with real clicks: one click is one edit, the current value records nothing, busy refuses but keeps focus', async () => {
  const user = userEvent.setup();
  const score = music(), note = noteAt(score), edits: EditCommand[] = [];
  const onEdit = (edit: EditCommand) => { edits.push(edit); applyPitchEdit(score, edit); };
  const props = { score, target, noteIndex: 0, busy: false, onEdit };
  const view = render(<SpellingControl {...props} />);
  const box = () => screen.getByRole('checkbox', { name: /cautionary accidental/i });
  expect(box()).not.toBeChecked();
  expect(box()).not.toBeDisabled();

  await user.click(box());
  expect(edits).toEqual([{ type: 'setNoteCautionary', target, noteIndex: 0, cautionary: true }]);
  expect(isNoteCautionary(note)).toBe(true);
  view.rerender(<SpellingControl {...props} />);
  expect(box()).toBeChecked();

  // A second click clears it, again as exactly one edit.
  await user.click(box());
  expect(edits).toHaveLength(2);
  expect(edits[1]).toEqual({ type: 'setNoteCautionary', target, noteIndex: 0, cautionary: false });
  expect(isNoteCautionary(note)).toBe(false);
  view.rerender(<SpellingControl {...props} />);
  expect(box()).not.toBeChecked();

  // Busy: never disabled, keeps focus, aria-disabled, and neither click nor Space records anything.
  await user.click(box());
  view.rerender(<SpellingControl {...props} busy />);
  box().focus();
  expect(box()).not.toBeDisabled();
  expect(box()).toHaveAttribute('aria-disabled', 'true');
  edits.length = 0;
  await user.click(box());
  await user.keyboard(' ');
  expect(edits).toEqual([]);
  expect(box()).toHaveFocus();
  expect(isNoteCautionary(note)).toBe(true);
});

it('shows the mark as unavailable, not live, when there is no note or the staff is percussion', () => {
  const score = music(), edits: EditCommand[] = [];
  const props = { score, target, noteIndex: 0, busy: false, onEdit: (edit: EditCommand) => { edits.push(edit); } };
  const view = render(<SpellingControl {...props} noteIndex={99} />);
  expect(screen.getByRole('checkbox', { name: /cautionary accidental/i })).toBeDisabled();
  score.tracks[0].staves[0].isPercussion = true;
  view.rerender(<SpellingControl {...props} />);
  expect(screen.getByRole('checkbox', { name: /cautionary accidental/i })).toBeDisabled();
  expect(edits).toEqual([]);
});
