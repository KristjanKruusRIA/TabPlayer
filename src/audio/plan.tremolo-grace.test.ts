import { expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildPlaybackPlan, prepareMidiScore } from './plan';

// A grace beat takes its time from the beat before it. When that beat is shorter
// than the grace, its play time is <= 0, and public generation steps a tremolo by
// that play time: a tied note then spun forever adding attacks until memory ran out.
const settings = new Settings(), { Quarter, Eighth, ThirtySecond } = model.Duration;

function score(tremolo: boolean) {
  const result = new model.Score(), master = new model.MasterBar();
  master.tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)]; result.addMasterBar(master);
  const track = new model.Track(), staff = new model.Staff(), bar = new model.Bar(), voice = new model.Voice();
  track.playbackInfo.program = 25; staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  track.addStaff(staff); result.addTrack(track); staff.addBar(bar); bar.addVoice(voice);
  const add = (duration: model.Duration, played: boolean, configure?: (beat: model.Beat, note: model.Note) => void) => {
    const beat = new model.Beat(); beat.duration = duration; beat.isEmpty = false; voice.addBeat(beat);
    if (played) { const n = new model.Note(); n.string = 3; n.fret = 5; configure?.(beat, n); beat.addNote(n); }
    return beat;
  };
  add(Quarter, true);
  const short = add(ThirtySecond, true, beat => { if (tremolo) { beat.tremoloPicking = new model.TremoloPickingEffect(); beat.tremoloPicking.marks = 3; } });
  add(Eighth, true, (beat, n) => { beat.graceType = model.GraceType.BeforeBeat; n.string = 1; });
  add(Quarter, true, (_beat, n) => { n.isTieDestination = true; });
  add(Quarter, false); add(Quarter, false);
  result.finish(settings);
  return { result, short };
}

it('plans a tremolo beat whose grace note took all its time, as it plans the same beat without tremolo picking', () => {
  const { result, short } = score(true);
  expect(short.playbackDuration).toBeLessThanOrEqual(0);
  expect(short.notes[0].isTieOrigin).toBe(true);
  // Without the guard this never returns: the attack list grows until memory is exhausted.
  const plan = buildPlaybackPlan(result, 1);
  const plain = buildPlaybackPlan(score(false).result, 1);
  expect(plan.notes.length).toBeGreaterThan(0);
  expect(plan.notes.filter(n => n.source.target.beat === 1)).toEqual([]);
  expect(plan.notes.map(n => n.source.target.beat)).toEqual(plain.notes.map(n => n.source.target.beat).filter(beat => beat !== 1));
});

it('keeps the tremolo on the source score and silences it only in the transient MIDI model', () => {
  const { result, short } = score(true);
  const prepared = prepareMidiScore(result), beat = prepared.tracks[0].staves[0].bars[0].voices[0].beats[1];
  expect(short.tremoloPicking!.marks).toBe(3);
  expect(beat.tremoloPicking!.marks).toBe(0);
  expect(prepareMidiScore(prepared)).toBe(prepared);
});
