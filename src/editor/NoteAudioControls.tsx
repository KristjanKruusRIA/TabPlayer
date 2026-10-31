import { useEffect, useRef, useState } from 'react';
import type { model } from '@coderline/alphatab';
import { busyGuard } from '../ui/useBusyGuard';
import { getNoteAudio, hasPitchEvents, isPlainNoteAudio, noteAudioLimits, plainNoteAudio, type NoteAudio } from './note-audio';

const fields = [
  ['length', 'Sounding length (%)'],
  ['offset', 'Start offset (ticks, 960 = quarter note)'],
  ['velocity', 'Velocity change'],
] as const;
type Field = typeof fields[number][0];

/** How the selected note sounds, apart from how it is written. A value is applied when the field loses focus or Enter is pressed, never while typing. */
export function NoteAudioControls({ note, score, busy = false, onApply }: { note: model.Note | undefined; score: model.Score; busy?: boolean; onApply: (audio: NoteAudio | null) => void | boolean | Promise<boolean | void> }) {
  const current = note ? getNoteAudio(note) ?? plainNoteAudio : plainNoteAudio;
  const [draft, setDraft] = useState<Record<Field, string>>({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) });
  const [error, setError] = useState('');
  // The settings last sent, until the score shows them: a second commit before the edit returns builds on these, not on the stale `current`.
  const sent = useRef<NoteAudio | null>(null);
  const key = `${current.length}/${current.offset}/${current.velocity}`;
  // A different note, an undo or a redo shows the settings of the note now selected.
  useEffect(() => { sent.current = null; setDraft({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) }); setError(''); }, [note, score, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Busy refuses the commit, so what was typed is shown as not applied: back to the saved settings.
  useEffect(() => { if (busy) { setDraft({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) }); setError(''); } }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const tied = !!note?.isTieDestination, fixed = !!note && hasPitchEvents(note);
  // A refused edit leaves the score as it was, so what was sent is forgotten and the message shown.
  const send = (audio: NoteAudio | null, sentValues: NoteAudio) => {
    sent.current = sentValues;
    const refused = () => { if (sent.current === sentValues) sent.current = null; setDraft({ length: String(current.length), offset: String(current.offset), velocity: String(current.velocity) }); setError('The note audio change was not applied.'); };
    try { void Promise.resolve(onApply(audio)).then(result => { if (result === false) refused(); }, refused); } catch { refused(); }
  };
  const commit = (field: Field) => {
    if (busy) return;
    const text = draft[field].trim(), value = Number(text), { min, max } = noteAudioLimits[field], base = sent.current ?? current;
    if (text === '' || !Number.isInteger(value) || value < min || value > max) {
      setError(`${fields.find(([name]) => name === field)![1]} must be a whole number from ${min} to ${max}.`);
      setDraft({ ...draft, [field]: String(base[field]) });
      return;
    }
    setError('');
    if (value === base[field]) return;
    const next = { ...base, [field]: value };
    send(isPlainNoteAudio(next) ? null : next, next);
  };
  return <div className="note-audio" role="group" aria-label="Note audio">
    <h3>Note audio</h3>
    {tied && <p className="muted">A tied note continues the note before it. Set its audio on the first note of the tie.</p>}
    {fixed && !tied && <p className="muted">A bent, whammy, sliding or vibrato note keeps its start and length; only its velocity changes.</p>}
    <div className="pair">{fields.map(([name, label]) => <label key={name}>{label}
      <input type="number" step={1} min={noteAudioLimits[name].min} max={noteAudioLimits[name].max} disabled={!note || tied || fixed && name !== 'velocity'} value={draft[name]}
        aria-disabled={busy || undefined} onChange={event => busy ? undefined : setDraft({ ...draft, [name]: event.target.value })} onBlur={() => commit(name)} onKeyDown={event => { if (event.key === 'Enter') commit(name); }}/>
    </label>)}</div>
    {error && <p role="alert" className="error">{error}</p>}
    <button type="button" {...busyGuard({ busy, disabled: !note || isPlainNoteAudio(current), onClick: () => send(null, plainNoteAudio) })}>Reset note audio</button>
  </div>;
}
