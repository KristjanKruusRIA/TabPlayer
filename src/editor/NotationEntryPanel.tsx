import { useRef, useState, type KeyboardEvent } from 'react';
import { model } from '@coderline/alphatab';
import { describeSelection } from '../engine';
import type { EditCommand } from '../edit-types';
import type { EntryFollow } from '../instruments/entry';
import { entryNotes } from '../instruments/entry';
import type { BeatTarget } from '../project';
import { accidentalLabels, enterPitch, enteredNoteIndex, entryAccidentals, entryBlock, entryClef, entryPitch, highestStep, keyLetter, lowestStep, octaveRange, pitchStep, stepPitch, type EntryAccidental, type EntryPitch } from './notation-entry';
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
const sharpLetters = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6], flatLetters = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];

export function NotationEntryPanel({ score, target, busy, locked = false, onEdit, latestScore }: NotationEntryPanelProps) {
  const { staff, bar, beat } = describeSelection(score, target), clef = entryClef(bar), keySignature = bar.keySignature as number;
  const [accidental, setAccidental] = useState<EntryAccidental>('key'), [octave, setOctave] = useState(4), [status, setStatus] = useState(''), working = useRef(false);
  const staffBox = useRef<HTMLDivElement>(null);
  const block = entryBlock(staff, beat ?? null), disabled = busy || locked || block !== null;
  const context = { staff, beat: beat ?? null, target, keySignature };
  const notes = beat && !staff.isPercussion ? entryNotes(staff, beat) : [];
  const chooseOctave = (value: number) => setOctave(Math.max(octaveRange.min, Math.min(octaveRange.max, value)));

  const enter = async (entered: EntryPitch | null) => {
    if (disabled || working.current) return;
    if (!entered) { setStatus('That pitch is outside the MIDI range.'); return; }
    const result = enterPitch(context, entered);
    if (!result.action) { setStatus(result.name); return; }
    working.current = true;
    try {
      const { command, follow } = result.action;
      if (!await onEdit(command, follow)) { setStatus(''); return; }
      let ok = true;
      if (!result.removes) {
        // Spelling is a second edit of the new note, made only when the note's spelling differs from what it has.
        const written = latestScore().tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
        const index = enteredNoteIndex(written, command), note = index >= 0 ? written?.notes[index] : undefined;
        const mode = result.spelling ?? model.NoteAccidentalMode.Default;
        if (note && note.accidentalMode !== mode) ok = await onEdit({ type: 'setNoteSpelling', target, noteIndex: index, accidentalMode: mode }, {});
      }
      setStatus(ok ? `${result.removes ? 'Removed' : 'Entered'} ${entered.name}` : `${entered.name} entered, but its spelling was not changed`);
      setAccidental('key');
      chooseOctave(entered.octave);
    } finally { working.current = false; }
  };

  const keys = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const letter = keyLetter(event.key);
    if (letter >= 0) { event.preventDefault(); void enter(entryPitch(letter, octave, accidental, keySignature)); return; }
    const picks: Record<string, EntryAccidental> = { '#': 'sharp', '+': 'sharp', '-': 'flat', n: 'natural', N: 'natural', k: 'key', K: 'key' };
    if (picks[event.key]) { event.preventDefault(); setAccidental(picks[event.key]); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); chooseOctave(octave + (event.key === 'ArrowUp' ? 1 : -1)); }
  };

  const steps = Array.from({ length: highestStep - lowestStep + 1 }, (_, index) => highestStep - index);
  const presentSteps = notes.flatMap(note => {
    const written = staff.tuning.length ? note.key + 12 : note.written!, letter = (keySignature < 0 ? flatLetters : sharpLetters)[((written % 12) + 12) % 12];
    const step = pitchStep(clef, letter, Math.floor(written / 12) - 1);
    return step === null ? [] : [step];
  });
  return <details open className="notation-entry"><summary>Standard notation entry</summary>
    <fieldset disabled={disabled}>
      <div role="group" aria-label="Accidental" className="notation-entry-accidentals">{entryAccidentals.map(value => <button key={value} type="button" aria-pressed={accidental === value} onClick={() => setAccidental(value)}>{accidentalLabels[value]}</button>)}</div>
      <div className="notation-entry-octave"><button type="button" aria-label="Octave down" disabled={octave <= octaveRange.min} onClick={() => chooseOctave(octave - 1)}>−</button><span data-testid="entry-octave">Octave {octave}</span><button type="button" aria-label="Octave up" disabled={octave >= octaveRange.max} onClick={() => chooseOctave(octave + 1)}>+</button></div>
    </fieldset>
    <div ref={staffBox} className="notation-entry-staff" role="group" aria-label="Pitch entry staff" aria-disabled={disabled} tabIndex={0} aria-keyshortcuts="A B C D E F G" onKeyDown={keys}>
      <svg viewBox={`0 0 ${staffWidth} ${stepY(lowestStep) + top}`} width={staffWidth} data-clef={clef} data-key-signature={keySignature}>
        <text x={6} y={stepY(2) + 4} className="notation-entry-clef" aria-hidden="true">{clefLetter[clef] ?? ''}</text>
        {steps.filter(step => step % 2 === 0).map(step => <line key={`line/${step}`} x1={left} x2={staffWidth - 4} y1={stepY(step)} y2={stepY(step)} className={step >= 0 && step <= 8 ? 'notation-entry-line' : 'notation-entry-ledger'}/>)}
        {presentSteps.map((step, index) => <ellipse key={`note/${index}`} data-note-step={step} cx={left + 20} cy={stepY(step)} rx={5} ry={3.4} className="notation-entry-note"/>)}
        {steps.map(step => {
          const entered = stepPitch(clef, step, accidental, keySignature), result = entered ? enterPitch(context, entered) : null;
          return <rect key={`target/${step}`} role="button" tabIndex={-1} data-step={step} aria-disabled={disabled || !result?.action} aria-label={result?.name ?? 'Outside the MIDI range'} x={left} y={stepY(step) - stepHeight / 2} width={staffWidth - left - 4} height={stepHeight} className="notation-entry-target" onClick={() => { staffBox.current?.focus(); if (entered) void enter(entered); }}/>;
        })}
      </svg>
    </div>
    <p className="muted" role="status">{block ?? (status || 'Click a line or space, or press A to G. # and - choose sharp and flat, N natural, K the key signature, Up and Down the octave.')}</p>
  </details>;
}
