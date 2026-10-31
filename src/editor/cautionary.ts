import { model, rendering, Settings } from '@coderline/alphatab';

const sources = new WeakMap<model.Note, boolean>();
let used = false;

/** Returns whether a note has been marked with a courtesy / cautionary accidental. */
export function isNoteCautionary(note: model.Note): boolean {
  return sources.get(note) ?? false;
}

/**
 * Sets or clears the cautionary (courtesy) mark on a note. The mark is only a flag: it never touches the note's
 * pitch or its accidental mode (spelling), so clearing it leaves exactly the spelling the note had, and a re-fret or
 * transposition cannot leave a stale forced accidental behind. The sign is worked out when the note is drawn.
 */
export function setNoteCautionary(note: model.Note, cautionary: boolean): void {
  if (cautionary) {
    sources.set(note, true);
    used = true;
    installRendering();
  } else sources.delete(note);
}

/*
 * alphaTab 1.8.4 draws an accidental only when the note's spelling differs from the key signature or from what the
 * bar has already shown, and offers no option to draw one anyway. This hooks the standard-notation accidental
 * helper, which alphaTab does not export, so that a marked note whose sign would be left out gets the sign for its
 * own spelling. It is reached through one throw-away render; if that fails the mark is kept but nothing extra is drawn.
 * A note with accidental mode "Force none" or a tie continuation is left without a sign, as alphaTab decides.
 */
interface AccidentalHelperLike {
  applyAccidental(note: model.Note): number;
  _registeredAccidentals: Map<number, number>;
  _appliedScoreSteps: Map<number, number>;
}
const hooked = Symbol.for('tabplayer.cautionary.rendering');
let renderingState: 'pending' | 'installed' | 'unavailable' = 'pending';

function probe(): object | null {
  const score = new model.Score(), track = new model.Track(), staff = new model.Staff();
  staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff);
  score.addTrack(track);
  score.addMasterBar(new model.MasterBar());
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(), note = new model.Note();
  note.string = 6;
  note.fret = 3;
  beat.duration = model.Duration.Quarter;
  beat.isEmpty = false;
  beat.addNote(note);
  voice.addBeat(beat);
  bar.addVoice(voice);
  staff.addBar(bar);
  score.finish(new Settings());
  const settings = new Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;
  settings.core.enableLazyLoading = false;
  const renderer = new rendering.ScoreRenderer(settings);
  renderer.width = 400;
  try {
    renderer.renderScore(score, [0]);
    const layout = (renderer as unknown as { layout: unknown }).layout as { getRendererForBar(staffId: string, bar: model.Bar): { accidentalHelper?: object } | null };
    const found = layout?.getRendererForBar('default-score', score.tracks[0].staves[0].bars[0])
      ?? layout?.getRendererForBar('score', score.tracks[0].staves[0].bars[0]);
    return found?.accidentalHelper ? Object.getPrototypeOf(found.accidentalHelper) : null;
  } finally {
    renderer.destroy();
  }
}

function installRendering(): void {
  if (renderingState !== 'pending') return;
  try {
    const prototype = probe() as (AccidentalHelperLike & Record<symbol, unknown>) | null;
    if (!prototype || typeof prototype.applyAccidental !== 'function') throw new Error('accidental helper not found');
    if (prototype[hooked]) {
      renderingState = 'installed';
      return;
    }
    const original = prototype.applyAccidental;
    prototype.applyAccidental = function (this: AccidentalHelperLike, note: model.Note): number {
      const type = original.call(this, note);
      if (type !== 0 || !sources.get(note) || note.isPercussion) return type;
      const steps = this._appliedScoreSteps.get(note.id);
      if (steps === undefined) return type;
      const registered = this._registeredAccidentals, had = registered.has(steps), prior = registered.get(steps);
      // A value no spelling can equal makes alphaTab treat the step as showing a different accidental.
      registered.set(steps, Number.NaN);
      const forced = original.call(this, note);
      if (forced === 0) {
        if (had) registered.set(steps, prior!);
        else registered.delete(steps);
      }
      return forced;
    };
    prototype[hooked] = true;
    renderingState = 'installed';
  } catch {
    renderingState = 'unavailable';
  }
}

/** Whether the notation renderer will draw the courtesy sign for marked notes (false only if alphaTab could not be hooked). */
export function cautionaryAccidentalsDrawn(): boolean {
  installRendering();
  return renderingState === 'installed';
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
    let score: model.Score;
    try { score = toScore(value, settings); } finally { scoreProto.finish = finish; }
    if (used) installRendering();
    return score;
  };
}
install();
