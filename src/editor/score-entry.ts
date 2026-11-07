import { model } from '@coderline/alphatab';
import type { EditCommand, SequenceStep } from '../edit-types';
import { describeSelection, previewEdit } from '../engine';
import type { BeatTarget, Project } from '../project';
import { entryNotes, maxEntryFret, type EntryFollow } from '../instruments/entry';
import { droneString, getBanjoDrone } from './banjo-drone';
import { openStringKey } from './partial-capo';
import { AUTO_DURATION_UNFIT, autoDurationEdit, type EntryDuration, type InputPreferences } from './input-preferences';
import { canSpell, drawnSpelling, enteredNoteIndex, enterPitch, entryClef, entryPitch, keyLetter, oneEdit, soundingKey, spellingFor, spellingStep, stepPitch, writtenPitch, type EntryAccidental, type EntryPitch } from './notation-entry';
import { voiceTicks } from './score-errors';
import { tieChain } from './non-tab';
import { MAX_SEQUENCE_COMMANDS } from '../parity-commands';

/** A key the score answers while note entry is on. */
export type ScoreEntryKey =
  | { kind: 'letter'; letter: number }
  | { kind: 'shorter' } | { kind: 'longer' } | { kind: 'dot'; double: boolean } | { kind: 'triplet' } | { kind: 'rest' }
  | { kind: 'step'; by: 1 | -1 } | { kind: 'semitone'; by: 1 | -1 } | { kind: 'octave'; by: 1 | -1 }
  | { kind: 'accidental'; value: AccidentalChord } | { kind: 'respell' };

/** The accidentals the Ctrl+7, 8 and 9 chords name, plain and with Alt. */
export type AccidentalChord = Extract<EntryAccidental, 'flat' | 'natural' | 'sharp' | 'doubleFlat' | 'doubleSharp'>;
const chordDigits: Record<string, { plain: AccidentalChord; alt: AccidentalChord | 'respell' }> = {
  Digit7: { plain: 'flat', alt: 'doubleFlat' }, Digit8: { plain: 'natural', alt: 'respell' }, Digit9: { plain: 'sharp', alt: 'doubleSharp' }
};


/**
 * What a key does on the score in entry mode. Letters write pitches; `+` and `-` make the beat shorter and longer, `.`
 * dots it (Ctrl+`.` double-dots), `/` makes a triplet and R a rest, as in Guitar Pro; Ctrl+Alt+Up/Down moves the
 * selected note a staff step, Alt+Shift+Up/Down a semitone, and Ctrl+Shift+Up/Down an octave. Ctrl+7, 8 and 9 are flat,
 * natural and sharp, with Alt double flat, change accidental and double sharp; they are read from `code`, because AltGr
 * makes `key` a brace or bracket on some layouts. Anything else is null.
 */
export function scoreEntryKey(event: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): ScoreEntryKey | null {
  const ctrl = event.ctrlKey || event.metaKey, vertical = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
  if (vertical) {
    if (ctrl && event.altKey && !event.shiftKey) return { kind: 'step', by: vertical };
    if (event.altKey && event.shiftKey && !ctrl) return { kind: 'semitone', by: vertical };
    if (ctrl && event.shiftKey && !event.altKey) return { kind: 'octave', by: vertical };
    return null;
  }
  const chord = event.code ? chordDigits[event.code] : undefined;
  if (chord && ctrl && !event.shiftKey) {
    const value = event.altKey ? chord.alt : chord.plain;
    return value === 'respell' ? { kind: 'respell' } : { kind: 'accidental', value };
  }
  if (event.altKey) return null;
  if (event.key === '.') return { kind: 'dot', double: ctrl };
  if (ctrl) return null;
  const letter = keyLetter(event.key);
  if (letter >= 0) return { kind: 'letter', letter };
  if (event.key === '+') return { kind: 'shorter' };
  if (event.key === '-') return { kind: 'longer' };
  if (event.key === '/') return { kind: 'triplet' };
  if (event.key === 'r' || event.key === 'R') return { kind: 'rest' };
  return null;
}

const plainDurations = [1, 2, 4, 8, 16, 32, 64];
/**
 * The rhythm edit a duration key makes on a beat, or null when it would change nothing or leave the plain range (a whole
 * to a 64th). A triplet toggles 3:2 and keeps the beat's grace type.
 */
export function durationKeyEdit(key: ScoreEntryKey, target: BeatTarget, beat: model.Beat): { command: EditCommand; entry: EntryDuration } | null {
  const index = plainDurations.indexOf(beat.duration);
  if (key.kind === 'shorter' || key.kind === 'longer') {
    const next = plainDurations[index + (key.kind === 'shorter' ? 1 : -1)];
    if (index < 0 || next === undefined) return null;
    return { command: { type: 'setDuration', target, duration: next, dots: beat.dots }, entry: { duration: next, dots: beat.dots } };
  }
  if (key.kind === 'dot') {
    const want = key.double ? 2 : 1, dots = beat.dots === want ? 0 : want;
    return { command: { type: 'setDuration', target, duration: beat.duration, dots }, entry: { duration: beat.duration, dots } };
  }
  if (key.kind === 'triplet') {
    const triplet = beat.tupletNumerator === 3 && beat.tupletDenominator === 2, plain = beat.tupletNumerator <= 0 || beat.tupletNumerator === 1 && beat.tupletDenominator === 1;
    if (!triplet && !plain) return null;
    return { command: { type: 'setBeatRhythm', target, duration: beat.duration, dots: beat.dots, tupletNumerator: triplet ? 1 : 3, tupletDenominator: triplet ? 1 : 2, graceType: beat.graceType }, entry: { duration: beat.duration, dots: beat.dots } };
  }
  return null;
}

/** The pitch for a letter key: in the key signature unless an accidental is pending, in the octave nearest the previous entry. */
export function letterPitch(letter: number, near: number, keySignature: number, accidental: EntryAccidental = 'key'): EntryPitch | null {
  let best: EntryPitch | null = null;
  for (let octave = 0; octave <= 9; octave++) {
    const candidate = entryPitch(letter, octave, accidental, keySignature);
    if (candidate && candidate.pitch <= 127 && (!best || Math.abs(candidate.pitch - near) < Math.abs(best.pitch - near))) best = candidate;
  }
  return best;
}

/** The written pitch a staff position on the rendered score stands for, in the bar's clef and key signature. */
export function stepEntryPitch(score: model.Score, target: BeatTarget, step: number, accidental: EntryAccidental = 'key'): EntryPitch | null {
  const { bar } = describeSelection(score, target);
  return stepPitch(entryClef(bar), step, accidental, bar.keySignature as number);
}

export interface EntryPlan {
  /** The one edit the gesture records. */
  command: EditCommand;
  follow: EntryFollow;
  /** Where the cursor goes once the edit lands. */
  next: BeatTarget;
  /** The pitch name, or "Remove …". */
  name: string;
  removes: boolean;
  /** Something the person should know though the entry went ahead, or null. */
  notice: string | null;
  /** The rhythm the next entry uses. */
  entry: EntryDuration | null;
}
/** Why an entry or move wrote nothing; the app words it. `name` is the pitch. */
export type EntryRefusal = { refused: 'cannot_enter' | 'no_string' | 'refused' | 'present' | 'cannot_move'; name: string };
export interface EntryRequest {
  project: Project; score: model.Score; target: BeatTarget; entered: EntryPitch;
  preferences: InputPreferences; entry: EntryDuration | null;
  /** Keep the cursor on the beat, to build a chord. */
  chord: boolean;
}

const tryPreview = (project: Project, command: EditCommand) => { try { return previewEdit(project, command); } catch { return null; } };
const isPlain = (beat: model.Beat) => beat.graceType === model.GraceType.None && (beat.tupletNumerator <= 0 || beat.tupletNumerator === 1 && beat.tupletDenominator === 1);

/**
 * Plans writing `entered` on a beat as one edit: an auto-duration rhythm, the note, the spelling it needs, and, when the
 * cursor advances past the last beat of a bar that still has room, a rest to write into next. A pitch the beat has is
 * removed instead. Returns a refusal reason when nothing can be written, so the caller keeps the selection as it was.
 */
export function planScoreEntry(request: EntryRequest): EntryPlan | EntryRefusal {
  const { project, score, target, entered, preferences, chord } = request;
  const { staff, bar, beat } = describeSelection(score, target);
  const result = enterPitch({ staff, bar, beat: beat ?? null, target, keySignature: bar.keySignature as number }, entered);
  if (!result.action || !beat) return { refused: result.name.startsWith('No free string') ? 'no_string' : 'cannot_enter', name: entered.name };
  const { command, follow } = result.action, note = command as SequenceStep;
  if (result.removes) return { command, follow, next: target, name: result.name, removes: true, notice: null, entry: request.entry };
  const lead = autoDurationEdit(preferences, target, beat, request.entry) as SequenceStep | null;
  let steps: SequenceStep[] = lead ? [lead, note] : [note], notice: string | null = null;
  let written = tryPreview(project, oneEdit(steps));
  if (!written && lead) { steps = [note]; written = tryPreview(project, note); notice = AUTO_DURATION_UNFIT; }
  if (!written) return { refused: 'refused', name: entered.name };
  const spelled = spellingStep(written.score, target, note, result.spelling ?? model.NoteAccidentalMode.Default);
  if (spelled.step) steps.push(spelled.step);
  const rhythm = steps[0] === lead && lead?.type === 'setDuration' ? { duration: lead.duration, dots: lead.dots } : isPlain(beat) ? { duration: beat.duration, dots: beat.dots } : request.entry;
  let next = target;
  if (!chord && preferences.advance) {
    const voice = written.score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice], master = written.score.masterBars[target.bar];
    if (target.beat < voice.beats.length - 1) next = { ...target, beat: target.beat + 1 };
    else {
      const ticks = voiceTicks(voice, master.calculateDuration(false)), room = ticks && ticks[0] < master.calculateDuration(false) * ticks[1];
      const insert: SequenceStep | null = room && rhythm ? { type: 'insertBeat', target: { ...target, beat: target.beat + 1 }, duration: rhythm.duration, dots: rhythm.dots } : null;
      if (insert && tryPreview(project, oneEdit([...steps, insert]))) { steps.push(insert); next = insert.target; }
      else if (target.bar + 1 < written.score.masterBars.length) {
        const following = written.score.tracks[target.track].staves[target.staff].bars[target.bar + 1];
        next = { ...target, bar: target.bar + 1, voice: following.voices[target.voice] ? target.voice : 0, beat: 0 };
      }
    }
  }
  return { command: oneEdit(steps), follow, next, name: entered.name, removes: false, notice, entry: rhythm };
}

/** The selected note of a beat: the one at `noteIndex`, the one on the selected string, or the only one. */
export function selectedNote(beat: model.Beat, string: number | null, noteIndex: number | null): model.Note | null {
  if (noteIndex !== null && beat.notes[noteIndex]) return beat.notes[noteIndex];
  const onString = string !== null ? beat.notes.find(item => item.string === string) : undefined;
  return onString ?? (beat.notes.length === 1 ? beat.notes[0] : null);
}

/**
 * The pitch a moved note takes: a staff step up or down in the key signature, a semitone (spelled sharp going up and
 * flat going down), or an octave. Null at the edge of the MIDI range.
 */
export function movedPitch(staff: model.Staff, bar: model.Bar, beat: model.Beat, note: model.Note, move: Extract<ScoreEntryKey, { kind: 'step' | 'semitone' | 'octave' }>): EntryPitch | null {
  const key = entryNotes(staff, beat).find(item => item.index === note.index)?.key;
  if (key === undefined) return null;
  const keySignature = bar.keySignature as number, written = writtenPitch(staff, bar, beat, key), drawn = drawnSpelling(keySignature, written, note.accidentalMode);
  const natural = (letter: number, octave: number) => entryPitch(letter, octave, 'natural', keySignature)!;
  const accidentalOf = (alteration: number): EntryAccidental | null => alteration === 1 ? 'sharp' : alteration === -1 ? 'flat' : alteration === 0 ? 'natural' : alteration === 2 ? 'doubleSharp' : alteration === -2 ? 'doubleFlat' : null;
  let result: EntryPitch | null = null;
  if (move.kind === 'step') {
    const index = drawn.octave * 7 + drawn.letter + move.by;
    result = entryPitch(((index % 7) + 7) % 7, Math.floor(index / 7), 'key', keySignature);
  } else if (move.kind === 'octave') {
    const accidental = accidentalOf(written - natural(drawn.letter, drawn.octave).pitch);
    result = accidental ? entryPitch(drawn.letter, drawn.octave + move.by, accidental, keySignature) : null;
  } else {
    // A white key keeps its letter; a black key is spelled from the letter it was moved from.
    const goal = written + move.by, octave = Math.floor(goal / 12) - 1, from = Math.floor((goal - move.by) / 12) - 1;
    const plain = [0, 1, 2, 3, 4, 5, 6].find(letter => natural(letter, octave).pitch === goal);
    const below = [0, 1, 2, 3, 4, 5, 6].find(letter => natural(letter, from).pitch === goal - move.by);
    if (plain !== undefined) result = natural(plain, octave);
    else if (below !== undefined) result = entryPitch(below, from, move.by > 0 ? 'sharp' : 'flat', keySignature);
  }
  return result && result.pitch >= 0 && result.pitch <= 127 ? result : null;
}

/**
 * Plans moving the selected note to `entered` as one edit that keeps the note itself, with its techniques and ties: a
 * pitched note changes pitch in place, a fretted note takes a new fret on its own string. Only a fretted note its string
 * cannot reach is removed and written again on the best free string. The spelling the new pitch needs joins the same
 * edit. Refused when the new pitch is already on the beat or no string can play it.
 */
export function planNoteMove(project: Project, score: model.Score, target: BeatTarget, note: model.Note, entered: EntryPitch): EntryPlan | EntryRefusal {
  const { staff, bar, beat } = describeSelection(score, target);
  if (!beat || staff.isPercussion) return { refused: 'cannot_move', name: entered.name };
  const key = soundingKey(staff, bar, beat, entered.pitch);
  // The move carries the whole tie chain, so no tied beat may already hold the new pitch on another note.
  const chain = tieChain(note), shift = key - (entryNotes(staff, beat).find(item => item.index === note.index)?.key ?? key);
  for (const member of chain) {
    const own = entryNotes(staff, member.beat).find(item => item.index === member.index)?.key;
    if (own !== undefined && entryNotes(staff, member.beat).some(item => item.index !== member.index && item.key === own + shift)) return { refused: 'present', name: entered.name };
  }
  const keySignature = bar.keySignature as number;
  let steps: SequenceStep[] | null = null, follow: EntryFollow = {};
  if (!staff.tuning.length) { const pitch = key + staff.transpositionPitch; steps = [{ type: 'setPitchedNote', target, noteIndex: note.index, pitch }]; follow = { note: { pitch } }; }
  else {
    const plain = key - openStringKey(staff, note.string), fret = note.string === droneString && plain > 0 ? plain + getBanjoDrone(staff) : plain;
    if (fret >= 0 && fret <= maxEntryFret) { steps = [{ type: 'setNote', target, string: note.string, fret }]; follow = { string: note.string, fret }; }
    else {
      // The note's own string cannot reach the pitch: write it again where a free string can.
      const remove: SequenceStep = { type: 'removeNote', target, string: note.string }, without = tryPreview(project, remove);
      if (!without) return { refused: 'cannot_move', name: entered.name };
      const after = describeSelection(without.score, target);
      const result = enterPitch({ staff: after.staff, bar: after.bar, beat: after.beat ?? null, target, keySignature }, entered);
      if (!result.action || result.removes) return { refused: result.removes ? 'present' : result.name.startsWith('No free string') ? 'no_string' : 'cannot_move', name: entered.name };
      steps = [remove, result.action.command as SequenceStep]; follow = result.action.follow;
    }
  }
  const written = tryPreview(project, oneEdit(steps));
  if (!written) return { refused: 'refused', name: entered.name };
  const mode = spellingFor(entered, keySignature), spelled = spellingStep(written.score, target, steps[steps.length - 1], mode);
  if (spelled.step) steps.push(spelled.step);
  // A note moved in place takes its tied notes with it; they are spelled the same way, as far as one edit holds.
  const moved = written.score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat];
  const index = steps[0].type === 'removeNote' ? -1 : enteredNoteIndex(moved, steps[0]);
  for (const member of index >= 0 ? tieChain(moved.notes[index]) : []) {
    if (member === moved.notes[index] || member.accidentalMode === mode || steps.length >= MAX_SEQUENCE_COMMANDS) continue;
    const at = member.beat, bar = at.voice.bar;
    steps.push({ type: 'setNoteSpelling', target: { track: bar.staff.track.index, staff: bar.staff.index, bar: bar.index, voice: at.voice.index, beat: at.index }, noteIndex: member.index, accidentalMode: mode });
  }
  return { command: oneEdit(steps), follow, next: target, name: entered.name, removes: false, notice: null, entry: null };
}

/** What a re-spell would do to the selected note, or why it cannot. Spelling only: the sounding pitch never changes. */
export type RespellResult =
  | { mode: model.NoteAccidentalMode; name: string }
  | { same: true }
  | { refused: 'no_spelling' | 'one_spelling'; name: string };

const letterSemitones = [0, 2, 4, 5, 7, 9, 11], letterNames = 'CDEFGAB';
const accidentalAlterations: Record<AccidentalChord | 'cycle', number> = { doubleFlat: -2, flat: -1, natural: 0, sharp: 1, doubleSharp: 2, cycle: 0 };
const alterationMarks = (alteration: number) => alteration >= 2 ? '##' : alteration === 1 ? '#' : alteration <= -2 ? 'bb' : alteration === -1 ? 'b' : '';

/**
 * The spelling a note takes when re-spelled as `accidental`, or the next of its spellings (flats before naturals before
 * sharps, wrapping) for `'cycle'`. A spelling the note already has is `same`; one alphaTab cannot draw is refused.
 */
export function respellNote(staff: model.Staff, bar: model.Bar, beat: model.Beat, note: model.Note, accidental: AccidentalChord | 'cycle'): RespellResult | null {
  const key = entryNotes(staff, beat).find(item => item.index === note.index)?.key;
  if (key === undefined) return null;
  const keySignature = bar.keySignature as number, written = writtenPitch(staff, bar, beat, key), pitchClass = ((written % 12) + 12) % 12;
  const drawn = drawnSpelling(keySignature, written, note.accidentalMode);
  const current = written - entryPitch(drawn.letter, drawn.octave, 'natural', keySignature)!.pitch;
  const currentName = `${letterNames[drawn.letter]}${alterationMarks(current)}${drawn.octave}`;
  const named = (alteration: number) => {
    const letter = letterSemitones.findIndex(semitone => (((semitone + alteration) % 12) + 12) % 12 === pitchClass);
    return letter < 0 ? null : { letter, alteration, octave: Math.floor((written - alteration - letterSemitones[letter]) / 12) - 1 };
  };
  let wanted: number;
  if (accidental === 'cycle') {
    const options = [-2, -1, 0, 1, 2].filter(alteration => canSpell(pitchClass, alteration));
    if (options.length < 2) return { refused: 'one_spelling', name: currentName };
    wanted = options[(Math.max(0, options.indexOf(current)) + 1) % options.length];
  } else wanted = accidentalAlterations[accidental];
  if (wanted === current) return { same: true };
  const spelled = named(wanted);
  if (!spelled || !canSpell(pitchClass, wanted)) return { refused: 'no_spelling', name: currentName };
  const entered: EntryPitch = { letter: spelled.letter, octave: spelled.octave, alteration: wanted, pitch: written, name: `${letterNames[spelled.letter]}${alterationMarks(wanted)}${spelled.octave}` };
  return { mode: spellingFor(entered, keySignature), name: entered.name };
}
