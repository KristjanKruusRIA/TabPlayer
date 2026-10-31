import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { beatAt, enumValue, integer } from './common';
import { setNoteCautionary } from './cautionary';

export function applyPitchEdit(score:model.Score,edit:EditCommand):boolean {
  if(edit.type==='setNoteSpelling') {
    const note=beatAt(score,edit.target).notes[edit.noteIndex];
    if(!integer(edit.noteIndex)||!note)throw new Error('Select an existing note.');
    enumValue(edit.accidentalMode,model.NoteAccidentalMode,'accidental mode');
    note.accidentalMode=edit.accidentalMode;
    return true;
  }
  if(edit.type==='setNoteCautionary'||edit.type==='setNoteCourtesy') {
    const note=beatAt(score,edit.target).notes[edit.noteIndex];
    if(!integer(edit.noteIndex)||!note)throw new Error('Select an existing note.');
    const value=edit.type==='setNoteCautionary'?edit.cautionary:edit.courtesy;
    if(typeof value!=='boolean')throw new Error('Cautionary accidental must be a boolean.');
    setNoteCautionary(note,value);
    return true;
  }
  return false;
}
