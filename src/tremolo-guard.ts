import { midi, model } from '@coderline/alphatab';

// alphaTab 1.8.4 sounds a tremolo by stepping `getDurationAsTicks(duration) * beatDurationFactor`
// ticks along the note's length. When that step is not a positive number (a 128th or
// 256th with many marks truncates to 0 ticks; a beat whose grace notes took all its time has
// no play time; a file can carry no mark count at all) the loop never advances and adds
// attacks until memory runs out, and a tiny positive step adds them by the hundred thousand.
// Every route into the generator (playback plan, rendering, exports, timers, reference-sync
// positions) calls this one method, so it is guarded here, once, whoever the caller is.
//
// A tremolo that cannot be sounded plays as the plain note it decorates. Nothing in the
// document changes: the effect stays in the score and is only left out of the generated
// MIDI. Beats left out this way can be read through `collectUntimedTremolo`.

/** Most attacks one tremolo beat may add, tied or slid length included (about 500 whole-note bars at 5 marks). */
export const TREMOLO_BEAT_ATTACKS = 16384;
/**
 * Most tremolo attacks one generation may add in total, so a file full of long tremolos cannot exhaust
 * memory. A plan costs about 3 KB per attack (102,400 attacks: 7.7 s and 309 MB; beyond about 125,000
 * notes the plan fails outright), while the real files measured hold none and a Guitar Pro tremolo
 * (3 marks) adds 8 attacks per beat: this is a fully tremolo-picked line of over 3,000 bars.
 */
export const TREMOLO_GENERATION_ATTACKS = 100000;

type Duration = { beatDurationFactor: number; untilTieOrSlideEnd: number; letRingEnd: number };
type Handler = { addNote(track: number, start: number, length: number, key: number, velocity: number, channel: number): void };
type Generator = {
  _handler: Handler;
  _generateTremoloPicking(note: model.Note, noteStart: number, duration: Duration, noteKey: number, velocity: number, channel: number): void;
};

const installed = Symbol.for('tabplayer.tremoloGuard');
const prototype = midi.MidiFileGenerator.prototype as unknown as Generator & { [installed]?: true };
const original = prototype._generateTremoloPicking;
if (typeof original !== 'function') throw new Error('alphaTab no longer exposes the tremolo generator that the tremolo guard wraps.');

/** alphaTab's own tremolo generator, for comparing the guarded one against it. */
export const unguardedTremolo = original;

const used = new WeakMap<object, number>();
const collectors: model.Beat[][] = [];

/** Run `run`, returning the result and every tremolo beat the guard left out of the MIDI it generated. */
export function collectUntimedTremolo<T>(run: () => T): { result: T; beats: model.Beat[] } {
  const beats: model.Beat[] = [];
  collectors.push(beats);
  try { return { result: run(), beats }; } finally { collectors.splice(collectors.lastIndexOf(beats), 1); }
}

if (!prototype[installed]) {
  prototype._generateTremoloPicking = function guarded(this: Generator, note, noteStart, duration, noteKey, velocity, channel) {
    const effect = note.beat.tremoloPicking;
    // The public loop is `while (noteStart + 10 < noteStart + untilTieOrSlideEnd)`; outside it nothing is generated.
    if (effect && effect.marks !== 0 && noteStart + 10 < noteStart + duration.untilTieOrSlideEnd) {
      const step = effect.getDurationAsTicks(note.beat.duration) * duration.beatDurationFactor;
      const attacks = step > 0 ? Math.ceil(duration.untilTieOrSlideEnd / step) : Infinity;
      const total = (used.get(this) ?? 0) + attacks;
      if (attacks <= TREMOLO_BEAT_ATTACKS && total <= TREMOLO_GENERATION_ATTACKS) {
        used.set(this, total);
        return original.call(this, note, noteStart, duration, noteKey, velocity, channel);
      }
      for (const beats of collectors) beats.push(note.beat);
      // The plain note the beat would play without the effect, from the same length rules.
      const length = Math.max(duration.untilTieOrSlideEnd, duration.letRingEnd);
      if (!note.isTieDestination && (!note.slideOrigin || note.slideOrigin.slideOutType !== model.SlideOutType.Legato) && Number.isFinite(length)) {
        this._handler.addNote(note.beat.voice.bar.staff.track.index, noteStart, length, noteKey, velocity, channel);
      }
      return;
    }
    return original.call(this, note, noteStart, duration, noteKey, velocity, channel);
  };
  prototype[installed] = true;
}
