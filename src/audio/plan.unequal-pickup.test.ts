import { expect, it, vi } from 'vitest';
import { midi, model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan } from './plan';

// Tracks whose pickup bars differ in length: the longest sets the master bar,
// and the shorter ones must still plan every note they play afterwards.
const settings = new Settings(), { Half, Quarter } = model.Duration;
type Beat = { duration: model.Duration; note?: boolean; tie?: boolean; bend?: number };
const on = (duration: model.Duration, extra: Partial<Beat> = {}): Beat => ({ duration, note: true, ...extra }), rest = (duration: model.Duration): Beat => ({ duration });
const full = () => [on(Quarter), on(Quarter), on(Quarter), on(Quarter)];
const quiet = () => [rest(Quarter), rest(Quarter), rest(Quarter), rest(Quarter)];

function build(parts: Beat[][][], repeat = false): model.Score {
  const score = new model.Score();
  for (let index = 0; index < parts[0].length; index++) {
    const master = new model.MasterBar(); master.isAnacrusis = index === 0;
    if (repeat && index === 0) master.isRepeatStart = true;
    if (repeat && index === parts[0].length - 1) master.repeatCount = 2;
    score.addMasterBar(master);
  }
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  parts.forEach((bars, trackIndex) => {
    const track = new model.Track(), staff = new model.Staff();
    track.playbackInfo.program = 25; track.playbackInfo.primaryChannel = trackIndex * 2; track.playbackInfo.secondaryChannel = trackIndex * 2 + 1;
    staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track);
    for (const beats of bars) {
      const bar = new model.Bar(), voice = new model.Voice(); staff.addBar(bar); bar.addVoice(voice);
      for (const spec of beats) {
        const beat = new model.Beat(); beat.duration = spec.duration; beat.isEmpty = false; voice.addBeat(beat);
        if (spec.note) { const note = new model.Note(); note.string = 2 + trackIndex; note.fret = 3 + trackIndex * 2;
          if (spec.tie) note.isTieDestination = true;
          if (spec.bend) { note.addBendPoint(new model.BendPoint(0, 0)); note.addBendPoint(new model.BendPoint(60, spec.bend)); }
          beat.addNote(note); }
      }
    }
  });
  score.finish(settings); return score;
}
const ticks = (score: model.Score, track: number) => buildPlaybackPlan(score, 1).notes.filter(note => note.source.target.track === track).map(note => note.startTick);
const bars = (score: model.Score) => buildPlaybackPlan(score, 1).occurrences.map(o => [o.bar, o.startTick, o.endTick]);

it('plans a shorter-pickup track that plays after the pickup, as it plans the same score with the pickups equalised', () => {
  const unequal = build([[[on(Quarter)], full()], [[rest(Half)], full()]]);
  const padded = build([[[on(Quarter), rest(Quarter)], full()], [[rest(Half)], full()]]);
  const plan = buildPlaybackPlan(unequal, 1), reference = buildPlaybackPlan(padded, 1);
  expect(plan.occurrences).toEqual(reference.occurrences);
  expect(plan.notes).toEqual(reference.notes);
  expect(plan.midi).toEqual(reference.midi);
  expect(ticks(unequal, 0)).toEqual([0, 1920, 2880, 3840, 4800]);
  expect(ticks(unequal, 1)).toEqual([1920, 2880, 3840, 4800]);
});

it('plans a score whose shorter pickup track is silent in the pickup bar and plays the bars after it', () => {
  const score = build([[[rest(Quarter)], full()], [[rest(Half)], full()]]);
  expect(ticks(score, 0)).toEqual([1920, 2880, 3840, 4800]);
  expect(ticks(score, 1)).toEqual([1920, 2880, 3840, 4800]);
});

it('plans a score whose shorter pickup track is silent for the rest of the score', () => {
  const score = build([[[on(Quarter)], quiet()], [[rest(Half)], quiet()]]);
  expect(ticks(score, 0)).toEqual([0]);
  expect(bars(score)).toEqual([[0, 0, 1920], [1, 1920, 5760]]);
});

it('plans two tracks that both play pickups of different lengths and the bars after them', () => {
  const unequal = build([[[on(Quarter), on(Quarter)], full()], [[on(Quarter), on(Quarter), on(Quarter)], full()]]);
  expect(ticks(unequal, 0)).toEqual([0, 960, 2880, 3840, 4800, 5760]);
  expect(ticks(unequal, 1)).toEqual([0, 960, 1920, 2880, 3840, 4800, 5760]);
});

it('keeps the longer pickup in the middle of three tracks and repeats the shorter pickup lane', () => {
  const score = build([[[on(Quarter)], full()], [[on(Quarter), on(Quarter), on(Quarter)], full()], [[on(Quarter), on(Quarter)], full()]], true);
  const plan = buildPlaybackPlan(score, 1), once = buildPlaybackPlan(build([[[on(Quarter)], full()], [[on(Quarter), on(Quarter), on(Quarter)], full()], [[on(Quarter), on(Quarter)], full()]]), 1);
  expect(plan.occurrences.map(o => [o.bar, o.occurrence])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  const second = plan.notes.filter(note => note.occurrence === 1), first = plan.notes.filter(note => note.occurrence === 0);
  expect(first.map(note => [note.trackId, note.startTick])).toEqual(once.notes.map(note => [note.trackId, note.startTick]));
  expect(second.length).toBe(first.length);
  expect(second.every((note, index) => note.startTick - first[index].startTick === plan.occurrences[2].startTick)).toBe(true);
});

it('places the bends of a note tied across the pickup gap where the equalised score has them', () => {
  // Track 1's quarter in the pickup is tied into a bent quarter in bar 1; the other track's longer pickup
  // starts bar 1 at tick 1920 in the complete score, but earlier on track 1's own clock.
  const bent = (pickup: Beat[]) => build([[[on(Quarter), on(Quarter)], full()], [pickup, [on(Quarter, { tie: true, bend: 4 }), on(Quarter), on(Quarter), on(Quarter)]]]);
  const unequal = buildPlaybackPlan(bent([on(Quarter)]), 1), reference = buildPlaybackPlan(bent([on(Half)]), 1);
  const curve = (plan: typeof unequal) => plan.notes.filter(note => note.trackId === 'base/1' || plan.tracks[1].id === note.trackId)[0];
  const note = curve(unequal);
  expect(note.startTick).toBe(0);
  expect(note.pitch.find(point => point.semitones > 0)!.tick).toBeGreaterThan(unequal.occurrences[1].startTick);
  expect(note.pitch.some(point => point.tick > 0 && point.tick < unequal.occurrences[1].startTick && point.semitones !== 0)).toBe(false);
  expect(curve(unequal)).toEqual(curve(reference));
});

it('refuses, rather than guesses, when a lane and the complete score disagree about their bars', () => {
  const original = midi.MidiFileGenerator.prototype.generate;
  let runs = 0;
  const spy = vi.spyOn(midi.MidiFileGenerator.prototype, 'generate').mockImplementation(function (this: midi.MidiFileGenerator) {
    original.call(this);
    if (++runs > 1) this.tickLookup.masterBars.pop();
  });
  try { expect(() => buildPlaybackPlan(build([[[on(Quarter)], full()], [[on(Half)], full()]]), 1)).toThrow(/bars disagree/); } finally { spy.mockRestore(); }
});
