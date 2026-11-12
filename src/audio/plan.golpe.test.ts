import { expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { buildPlaybackPlan } from './plan';
import type { PlanMidiEvent, PlaybackPlan } from './types';

// THE-60: a golpe adds a short knock to its beat, as plain MIDI events on channel 9 of the beat's own track. The written notes are untouched.
const settings = new Settings();
const beatOf = (score: model.Score, bar: number, beat: number, track = 0) => score.tracks[track].staves[0].bars[bar].voices[0].beats[beat];
type Note = Extract<PlanMidiEvent, { type: 'noteOn' | 'noteOff' }>;
const knocks = (plan: PlaybackPlan) => plan.midi.filter((event): event is Note => (event.type === 'noteOn' || event.type === 'noteOff') && event.channel === 9);
const withoutKnocks = (plan: PlaybackPlan) => ({ ...plan, midi: plan.midi.filter(event => !(knocks(plan) as PlanMidiEvent[]).includes(event)) });
const on = (event: Note) => [event.trackId, event.tick, event.key, event.velocity];

it('a score without a golpe plans no knock, and clearing every golpe from one returns the plan it had before', () => {
  const plain = music();
  expect(knocks(buildPlaybackPlan(plain, 1))).toEqual([]);
  const marked = music(), cleared = music();
  beatOf(marked, 0, 1).golpe = model.GolpeType.Thumb; beatOf(marked, 2, 3).golpe = model.GolpeType.Finger;
  beatOf(cleared, 0, 1).golpe = model.GolpeType.Thumb; beatOf(cleared, 2, 3).golpe = model.GolpeType.Finger;
  for (const beat of [beatOf(cleared, 0, 1), beatOf(cleared, 2, 3)]) beat.golpe = model.GolpeType.None;
  const plan = buildPlaybackPlan(marked, 1);
  // The notes, their articulations and every other event are what a plain score plans; only the knocks are added.
  expect(withoutKnocks(plan)).toEqual(buildPlaybackPlan(cleared, 1));
  expect(buildPlaybackPlan(cleared, 1)).toEqual(buildPlaybackPlan(plain, 1));
  expect(knocks(plan).length).toBe(4);
});

it('thumb is a lower, duller knock than finger, each on the beat start of its own track, on the percussion channel', () => {
  const score = music();
  beatOf(score, 0, 1).golpe = model.GolpeType.Thumb; beatOf(score, 0, 2).golpe = model.GolpeType.Finger;
  const plan = buildPlaybackPlan(score, 1), id = plan.tracks[0].id;
  expect(knocks(plan).filter(event => event.type === 'noteOn').map(on)).toEqual([[id, 960, 77, 85], [id, 1920, 37, 75]]);
  expect(knocks(plan).filter(event => event.type === 'noteOff').map(event => [event.tick, event.key])).toEqual([[1080, 77], [2040, 37]]);
  // Each knock starts with the written note of its beat.
  expect(plan.notes).toEqual(buildPlaybackPlan(music(), 1).notes);
});

it('a golpe on a chord taps together with the chord, and on a rest it is the tap alone', () => {
  const chord = music(), rest = music();
  const beat = beatOf(chord, 0, 0), second = new model.Note(); second.string = 5; second.fret = 2; beat.addNote(second);
  beat.golpe = model.GolpeType.Finger;
  const planned = buildPlaybackPlan(chord, 1);
  expect(planned.notes.filter(note => note.startTick === 0)).toHaveLength(2);
  expect(knocks(planned).filter(event => event.type === 'noteOn').map(event => event.tick)).toEqual([0]);
  const silent = beatOf(rest, 1, 2); silent.notes.slice().forEach(note => silent.removeNote(note)); silent.golpe = model.GolpeType.Thumb;
  const restPlan = buildPlaybackPlan(rest, 1);
  expect(restPlan.notes.some(note => note.source.target.bar === 1 && note.source.target.beat === 2)).toBe(false);
  expect(knocks(restPlan).filter(event => event.type === 'noteOn').map(event => [event.tick, event.key])).toEqual([[3840 + 1920, 77]]);
});

it('a tempo change inside the bar moves no tick: the knock stays on its beat and the plan keeps the tempo map', () => {
  const score = music();
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 90, 2), model.Automation.buildTempoAutomation(false, 0.5, 150, 2)];
  beatOf(score, 0, 3).golpe = model.GolpeType.Finger; score.finish(settings);
  const plan = buildPlaybackPlan(score, 1);
  expect(plan.tempos.length).toBeGreaterThan(1);
  expect(knocks(plan).filter(event => event.type === 'noteOn').map(on)).toEqual([[plan.tracks[0].id, 2880, 37, 75]]);
  expect(plan.notes.some(note => note.startTick === 2880)).toBe(true);
});

it('a repeated bar knocks on every pass', () => {
  const score = music();
  score.masterBars[0].isRepeatStart = true; score.masterBars[1].repeatCount = 2; score.rebuildRepeatGroups();
  beatOf(score, 0, 0).golpe = model.GolpeType.Thumb; score.finish(settings);
  const plan = buildPlaybackPlan(score, 1);
  const ticks = knocks(plan).filter(event => event.type === 'noteOn').map(event => event.tick);
  expect(ticks).toEqual([0, 7680]);
  expect(plan.occurrences.map(o => o.bar)).toEqual([0, 1, 0, 1, 2, 3]);
});

it('a golpe on the last, shortest beat still ends inside the plan', () => {
  const score = music();
  const last = beatOf(score, 3, 3); last.duration = model.Duration.SixtyFourth; last.golpe = model.GolpeType.Thumb;
  const plan = buildPlaybackPlan(score, 1), hit = knocks(plan);
  expect(hit).toHaveLength(2);
  expect(Math.max(...hit.map(event => event.tick))).toBeLessThanOrEqual(plan.durationTick);
});
