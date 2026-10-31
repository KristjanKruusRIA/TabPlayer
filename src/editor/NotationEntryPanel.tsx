import { useI18n } from '../i18n';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { model } from '@coderline/alphatab';
import { describeSelection } from '../engine';
import type { EditCommand } from '../edit-types';
import type { EntryFollow } from '../instruments/entry';
import { entryNotes } from '../instruments/entry';
import type { BeatTarget } from '../project';
import { accidentalLabels, drawnSpelling, enterPitch, enteredNoteIndex, entryAccidentals, entryBlock, entryClef, entryPitch, highestStep, keyLetter, lowestStep, octaveRange, pitchStep, stepPitch, writtenPitch, type EntryAccidental, type EntryPitch } from './notation-entry';
import './notation-entry.css';

export interface NotationEntryPanelProps {
  score: model.Score; target: BeatTarget; busy: boolean; locked?: boolean;
  /** Sends one edit and tells whether it was accepted. */
  onEdit: (command: EditCommand, follow: EntryFollow) => Promise<boolean>;
  /** The score as it is now, so a follow-up edit reads the note an entry just wrote. */
  latestScore: () => model.Score;
}

const stepHeight = 6, staffWidth = 240, left = 44, top = stepHeight;
const stepY = (step: number) => (highestStep - step) * stepHeight + top;
const clefLetter: Record<number, string> = { [model.Clef.G2]: '𝄞', [model.Clef.F4]: '𝄢', [model.Clef.C3]: '𝄡', [model.Clef.C4]: '𝄡' };

export function NotationEntryPanel({ score, target, busy, locked = false, onEdit, latestScore }: NotationEntryPanelProps) {
  const { t } = useI18n();
  const { staff, bar, beat } = describeSelection(score, target), clef = entryClef(bar), keySignature = bar.keySignature as number;
  const [accidental, setAccidental] = useState<EntryAccidental>('key'), [octave, setOctave] = useState(4), [cursor, setCursor] = useState(0), [status, setStatus] = useState(''), working = useRef(false);
  const staffBox = useRef<HTMLDivElement>(null), id = useId();
  const block = entryBlock(staff, beat ?? null), disabled = busy || locked || block !== null;
  const context = { staff, bar, beat: beat ?? null, target, keySignature };
  const notes = beat && !staff.isPercussion ? entryNotes(staff, beat) : [];
  const chooseOctave = (value: number) => setOctave(Math.max(octaveRange.min, Math.min(octaveRange.max, value)));

  const enter = async (entered: EntryPitch | null) => {
    if (disabled) return;
    if (working.current) { setStatus(t('editor.entry_busy')); return; }
    if (!entered) { setStatus(t('editor.entry_out_of_range')); return; }
    const result = enterPitch(context, entered);
    if (!result.action) { setStatus(result.name.startsWith('No free string') ? result.name : t('editor.entry_cannot_enter', { name: result.name })); return; }
    working.current = true;
    try {
      const { command, follow } = result.action;
      if (!await onEdit(command, follow)) { setStatus(t('editor.entry_refused', { name: entered.name })); return; }
      let message = t(result.removes ? 'editor.entry_removed' : 'editor.entry_entered', { name: entered.name });
      if (!result.removes) {
        // Spelling is a second edit of the new note, made only when the note's spelling differs from what it needs.
        const written = latestScore().tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
        const index = enteredNoteIndex(written, command), note = index >= 0 ? written?.notes[index] : undefined;
        const mode = result.spelling ?? model.NoteAccidentalMode.Default;
        if (!note) message = t('editor.entry_spelling_missing', { name: entered.name });
        else if (note.accidentalMode !== mode && !await onEdit({ type: 'setNoteSpelling', target, noteIndex: index, accidentalMode: mode }, {})) message = t('editor.entry_spelling_unchanged', { name: entered.name });
      }
      setStatus(message);
      setAccidental('key');
      chooseOctave(entered.octave);
      const step = pitchStep(clef, entered.letter, entered.octave);
      if (step !== null) setCursor(step);
    } finally { working.current = false; }
  };

  const keys = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || disabled) return;
    const letter = keyLetter(event.key);
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (letter >= 0) { handled(); if (!event.repeat) void enter(entryPitch(letter, octave, accidental, keySignature)); return; }
    const picks: Record<string, EntryAccidental> = { '#': 'sharp', '+': 'sharp', '-': 'flat', n: 'natural', N: 'natural', k: 'key', K: 'key' };
    if (picks[event.key]) { handled(); setAccidental(picks[event.key]); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { handled(); setCursor(Math.max(lowestStep, Math.min(highestStep, cursor + (event.key === 'ArrowUp' ? 1 : -1)))); }
    else if (event.key === 'PageUp' || event.key === 'PageDown') { handled(); chooseOctave(octave + (event.key === 'PageUp' ? 1 : -1)); }
    else if (event.key === 'Enter' || event.key === ' ') { handled(); if (!event.repeat) { const entered = stepPitch(clef, cursor, accidental, keySignature); void enter(entered); } }
  };

  const steps = Array.from({ length: highestStep - lowestStep + 1 }, (_, index) => highestStep - index);
  const presentSteps = beat ? notes.flatMap(note => {
    const written = writtenPitch(staff, bar, beat, note.key), drawn = drawnSpelling(keySignature, written, beat.notes[note.index]?.accidentalMode ?? model.NoteAccidentalMode.Default);
    const step = pitchStep(clef, drawn.letter, drawn.octave);
    return step === null ? [] : [step];
  }) : [];
  const stepId = (step: number) => `${id}-step${step - lowestStep}`;
  return <details open className="notation-entry"><summary>{t('editor.standard_notation_entry')}</summary>
    <fieldset disabled={disabled}>
      <div role="group" aria-label={t('editor.accidental_group')} className="notation-entry-accidentals">{entryAccidentals.map(value => <button key={value} type="button" aria-pressed={accidental === value} onClick={() => setAccidental(value)}>{accidentalLabels[value]}</button>)}</div>
      <div className="notation-entry-octave"><button type="button" aria-label={t('editor.octave_down')} disabled={octave <= octaveRange.min} onClick={() => chooseOctave(octave - 1)}>−</button><span data-testid="entry-octave">{t('editor.octave_n', { octave })}</span><button type="button" aria-label={t('editor.octave_up')} disabled={octave >= octaveRange.max} onClick={() => chooseOctave(octave + 1)}>+</button></div>
    </fieldset>
    <div ref={staffBox} className="notation-entry-staff" role="group" aria-label={t('editor.pitch_entry_staff')} aria-disabled={disabled} aria-activedescendant={stepId(cursor)} tabIndex={0} aria-keyshortcuts="A B C D E F G" onKeyDown={keys}>
      <svg viewBox={`0 0 ${staffWidth} ${stepY(lowestStep) + top}`} width={staffWidth} data-clef={clef} data-key-signature={keySignature}>
        <text x={6} y={stepY(2) + 4} className="notation-entry-clef" aria-hidden="true">{clefLetter[clef] ?? ''}</text>
        {steps.filter(step => step % 2 === 0).map(step => <line key={`line/${step}`} x1={left} x2={staffWidth - 4} y1={stepY(step)} y2={stepY(step)} className={step >= 0 && step <= 8 ? 'notation-entry-line' : 'notation-entry-ledger'}/>)}
        {presentSteps.map((step, index) => <ellipse key={`note/${index}`} data-note-step={step} cx={left + 20} cy={stepY(step)} rx={5} ry={3.4} className="notation-entry-note"/>)}
        {steps.map(step => {
          const entered = stepPitch(clef, step, accidental, keySignature), result = entered ? enterPitch(context, entered) : null;
          return <rect key={`target/${step}`} id={stepId(step)} role="button" tabIndex={-1} data-step={step} data-cursor={step === cursor && !disabled ? 'true' : undefined} aria-disabled={disabled || !result?.action} aria-label={result?.name ?? 'Outside the MIDI range'} x={left} y={stepY(step) - stepHeight / 2} width={staffWidth - left - 4} height={stepHeight} className="notation-entry-target" onClick={() => { staffBox.current?.focus(); setCursor(step); if (entered) void enter(entered); }}/>;
        })}
      </svg>
    </div>
    <p className="muted" role="status">{block ?? (status || t('editor.notation_entry_instructions'))}</p>
  </details>;
}
