import { model, type Settings } from '@coderline/alphatab';
import { automaticSpelling } from './notation-entry';

const sources = new WeakMap<model.Note, boolean>();
let used = false;

/** Returns whether a note has been marked with a courtesy / cautionary accidental. */
export function isNoteCautionary(note: model.Note): boolean {
  return sources.get(note) ?? false;
}

/** The forced accidental mode that makes this note's standard-staff accidental explicit. */
export function automaticForcedMode(note: model.Note): model.NoteAccidentalMode {
  const bar = note.beat.voice.bar;
  const key = bar?.keySignature ?? 0;
  const pitchClass = ((note.displayValueWithoutBend % 12) + 12) % 12;
  const { alteration } = automaticSpelling(key, pitchClass);
  switch (alteration) {
    case 1: return model.NoteAccidentalMode.ForceSharp;
    case -1: return model.NoteAccidentalMode.ForceFlat;
    case 2: return model.NoteAccidentalMode.ForceDoubleSharp;
    case -2: return model.NoteAccidentalMode.ForceDoubleFlat;
    default: return model.NoteAccidentalMode.ForceNatural;
  }
}

/**
 * Sets or clears the cautionary / courtesy accidental on a note.
 * When enabled and accidentalMode is Default, chooses the forced accidental mode for the note's pitch;
 * when disabled, resets accidentalMode to Default.
 */
export function setNoteCautionary(note: model.Note, cautionary: boolean): void {
  if (cautionary) {
    sources.set(note, true);
    used = true;
    if (note.accidentalMode === model.NoteAccidentalMode.Default) {
      note.accidentalMode = automaticForcedMode(note);
    }
  } else {
    sources.delete(note);
    if (note.accidentalMode !== model.NoteAccidentalMode.Default) {
      note.accidentalMode = model.NoteAccidentalMode.Default;
    }
  }
}

const eachNote = (score: model.Score, action: (note: model.Note, track: number, staff: number, bar: number, voice: number, beat: number, index: number) => void) => {
  score.tracks.forEach((track, t) => track.staves.forEach((staff, s) => staff.bars.forEach((bar, b) => bar.voices.forEach((voice, v) => voice.beats.forEach((beat, i) => beat.notes.forEach((note, n) => action(note, t, s, b, v, i, n)))))));
};

/** Whether any note in the score has a cautionary accidental. */
export function hasCautionaryAccidentals(score: model.Score): boolean {
  if (!used) return false;
  for (const track of score.tracks)
    for (const staff of track.staves)
      for (const bar of staff.bars)
        for (const voice of bar.voices)
          for (const beat of voice.beats)
            for (const note of beat.notes)
              if (sources.has(note)) return true;
  return false;
}

const extensionKey = 'tabplayercautionary';
const field = (source: unknown, key: string): unknown => source instanceof Map ? source.get(key) : source !== null && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
const list = (source: unknown, key: string): unknown[] => { const value = field(source, key); return Array.isArray(value) ? value : []; };
function noteWire(root: unknown, ...path: number[]): unknown {
  let node = root;
  ['tracks', 'staves', 'bars', 'voices', 'beats', 'notes'].forEach((key, level) => { node = list(node, key)[path[level]]; });
  return node;
}

const hooks = Symbol.for('tabplayer.cautionary.hooks');
function install(): void {
  const prototype = model.Score.prototype as unknown as Record<symbol, unknown>;
  if (prototype[hooks]) return;
  prototype[hooks] = true;
  const converter = model.JsonConverter as unknown as {
    scoreToJsObject(score: model.Score): unknown;
    jsObjectToScore(value: unknown, settings?: Settings): model.Score;
  };
  const toObject = converter.scoreToJsObject.bind(converter), toScore = converter.jsObjectToScore.bind(converter);
  converter.scoreToJsObject = score => {
    const result = toObject(score);
    if (!used) return result;
    eachNote(score, (note, t, s, b, v, i, n) => {
      if (sources.get(note)) {
        const wire = noteWire(result, t, s, b, v, i, n);
        if (wire instanceof Map) wire.set(extensionKey, true);
        else if (wire && typeof wire === 'object') (wire as Record<string, unknown>)[extensionKey] = true;
      }
    });
    return result;
  };
  converter.jsObjectToScore = (value, settings) => {
    const scoreProto = model.Score.prototype, finish = scoreProto.finish;
    scoreProto.finish = function (this: model.Score, ...args: Parameters<typeof finish>) {
      scoreProto.finish = finish;
      eachNote(this, (note, t, s, b, v, i, n) => {
        const wire = field(noteWire(value, t, s, b, v, i, n), extensionKey);
        if (wire === true) {
          sources.set(note, true);
          used = true;
        }
      });
      return finish.apply(this, args);
    };
    try { return toScore(value, settings); } finally { scoreProto.finish = finish; }
  };
}
install();
