import { useEffect, useState } from 'react';
import type { model } from '@coderline/alphatab';
import { getNoteAudio, hasPitchEvents, isPlainNoteAudio, noteAudioLimits, plainNoteAudio, type NoteAudio } from './note-audio';

const fields = [
  ['length', 'Sounding length (%)'],
  ['offset', 'Start offset (ticks, 960 = quarter note)'],
  ['velocity', 'Velocity change'],
] as const;
type Field = typeof fields[number][0];

/** How the selected note sounds, apart from how it is written. A value is applied when the field loses focus or Enter is pressed, never while typing. */
export function NoteAudioControls({ note, score, onApply }: { note: model.Note | undefined; score: model.Score; onApply: (audio: NoteAudio | null) => void }) {
  const current = note ? getNoteAudio(note) ?? plainNoteAudio : plainNoteAudio;
  const [draft, setDraft] = useState<Record<Field, string>>({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) });
  const [error, setError] = useState('');
  const key = `${current.length}/${current.offset}/${current.velocity}`;
  // A different note, an undo or a redo shows the settings of the note now selected.
  useEffect(() => { setDraft({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) }); setError(''); }, [note, score, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const tied = !!note?.isTieDestination, fixed = !!note && hasPitchEvents(note);
  const commit = (field: Field) => {
    const text = draft[field].trim(), value = Number(text), { min, max } = noteAudioLimits[field];
    if (text === '' || !Number.isInteger(value) || value < min || value > max) {
      setError(`${fields.find(([name]) => name === field)![1]} must be a whole number from ${min} to ${max}.`);
      setDraft({ ...draft, [field]: String(current[field]) });
      return;
    }
    setError('');
    if (value === current[field]) return;
    const next = { ...current, [field]: value };
    onApply(isPlainNoteAudio(next) ? null : next);
  };
  return <div className="note-audio" role="group" aria-label="Note audio">
    <h3>Note audio</h3>
    {tied && <p className="muted">A tied note continues the note before it. Set its audio on the first note of the tie.</p>}
    {fixed && !tied && <p className="muted">A bent, whammy, sliding or vibrato note keeps its start and length; only its velocity changes.</p>}
    <div className="pair">{fields.map(([name, label]) => <label key={name}>{label}
      <input type="number" step={1} min={noteAudioLimits[name].min} max={noteAudioLimits[name].max} disabled={!note || tied || fixed && name !== 'velocity'} value={draft[name]}
        onChange={event => setDraft({ ...draft, [name]: event.target.value })} onBlur={() => commit(name)} onKeyDown={event => { if (event.key === 'Enter') commit(name); }}/>
    </label>)}</div>
    {error && <p role="alert" className="error">{error}</p>}
    <button type="button" disabled={!note || isPlainNoteAudio(current)} onClick={() => onApply(null)}>Reset note audio</button>
  </div>;
}
