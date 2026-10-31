// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model } from '@coderline/alphatab';
import { SpellingControl } from './SpellingControl';
import { applyPitchEdit } from './pitch';
import { isNoteCautionary, setNoteCautionary } from './cautionary';
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

it('toggles cautionary accidental through engine, stays focusable when busy, and disables when inactive', () => {
  const score = music();
  let lastEdit: any = null;
  const onEdit = (edit: any) => {
    lastEdit = edit;
    applyPitchEdit(score, edit);
  };
  const note = noteAt(score);
  const props = { score, target, noteIndex: 0, busy: false, onEdit };
  const view = render(<SpellingControl {...props} />);

  const checkbox = screen.getByRole('checkbox', { name: /cautionary accidental/i });
  expect(checkbox).not.toBeChecked();
  expect(checkbox).not.toBeDisabled();
  expect(checkbox).not.toHaveAttribute('aria-disabled');

  // One gesture is one undoable edit through the real engine
  fireEvent.click(checkbox);
  expect(lastEdit).toEqual({ type: 'setNoteCautionary', target, noteIndex: 0, cautionary: true });
  expect(isNoteCautionary(note)).toBe(true);

  // Readback: rerender with updated score state
  view.rerender(<SpellingControl {...props} />);
  expect(checkbox).toBeChecked();

  // Choosing the current value records nothing
  lastEdit = null;
  fireEvent.change(checkbox, { target: { checked: true } });
  expect(lastEdit).toBeNull();

  // Stays focusable while busy (aria-disabled), never disabled, and refuses edits
  view.rerender(<SpellingControl {...props} busy={true} />);
  expect(checkbox).not.toBeDisabled();
  expect(checkbox).toHaveAttribute('aria-disabled', 'true');
  lastEdit = null;
  fireEvent.click(checkbox);
  expect(lastEdit).toBeNull();
  expect(isNoteCautionary(note)).toBe(true);

  // A value that does nothing is never shown as a live control
  view.rerender(<SpellingControl {...props} noteIndex={99} busy={false} />);
  expect(screen.getByRole('checkbox', { name: /cautionary accidental/i })).toBeDisabled();

  score.tracks[0].staves[0].isPercussion = true;
  view.rerender(<SpellingControl {...props} noteIndex={0} busy={false} />);
  expect(screen.getByRole('checkbox', { name: /cautionary accidental/i })).toBeDisabled();
});
