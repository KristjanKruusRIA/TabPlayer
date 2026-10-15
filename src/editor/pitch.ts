import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { beatAt, enumValue, integer } from './common';

export function applyPitchEdit(score:model.Score,edit:EditCommand):boolean {
  if(edit.type!=='setNoteSpelling')return false;
  const note=beatAt(score,edit.target).notes[edit.noteIndex];
  if(!integer(edit.noteIndex)||!note)throw new Error('Select an existing note.');
  enumValue(edit.accidentalMode,model.NoteAccidentalMode,'accidental mode');
  note.accidentalMode=edit.accidentalMode;
  return true;
}
