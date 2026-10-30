import { expect, it, vi } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { buildDocument, previewEdit } from '../engine';
import { blankProject } from '../project';
import { validateMix } from '../document-settings';
import type { TrackInterpretation } from '../edit-types';
import { NativePlaybackController } from './NativePlaybackController';
import type { NativeAudioBridge } from './bridge';
import { buildPlaybackPlanFromJson } from './plan';
import { focusNotes } from '../instruments/focus';
import { canonicalInterpretation, interpretationsOf, strongOffsets, validateInterpretation } from './interpretation';
import type { PlaybackPlan } from './types';

const settings = new Settings();
function authored(bars = 1, program = 25, tuning = [64, 59, 55, 50, 45, 40]) {
  const score = new model.Score();
  for (let b = 0; b < bars; b++) score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  const track = new model.Track(); track.playbackInfo.program = program;
  const staff = new model.Staff(); staff.stringTuning.tunings = tuning; track.addStaff(staff); score.addTrack(track);
  for (let b = 0; b < bars; b++) {
    const bar = new model.Bar(); staff.addBar(bar);
    const voice = new model.Voice(); bar.addVoice(voice);
    for (let i = 0; i < 4; i++) { const beat = new model.Beat(); beat.duration = model.Duration.Quarter; beat.isEmpty = false; voice.addBeat(beat); }
  }
  return score;
}
function note(score: model.Score, bar: number, beat: number, string = 1, fret = 3) {
  const n = new model.Note(); n.string = string; n.fret = fret;
  score.tracks[0].staves[0].bars[bar].voices[0].beats[beat].addNote(n); return n;
}
const planOf = (score: model.Score, interpretation?: TrackInterpretation) => {
  score.finish(settings);
  return buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score), ['t0'], 3, interpretation ? { t0: interpretation } : undefined);
};
const byBeat = (plan: PlaybackPlan) => [...plan.notes].sort((a, b) => a.startTick - b.startTick || a.key - b.key);
const sounding = (plan: PlaybackPlan) => {
  const keyed = plan.midi.flatMap(e => e.type === 'noteOn' || e.type === 'noteOff' ? [e] : []);
  return { on: keyed.filter(e => e.type === 'noteOn').map(e => [e.tick, e.key, e.velocity]).sort(), off: keyed.filter(e => e.type === 'noteOff').map(e => [e.tick, e.key]).sort() };
};

it('leaves the plan byte-identical while no interpretation is set, whichever way it is passed', () => {
  const build = () => { const score = authored(2); note(score, 0, 0, 1, 3); note(score, 0, 1, 2, 5).isPalmMute = true; note(score, 0, 2, 3, 2); note(score, 0, 2, 4, 2); note(score, 1, 0, 6, 0); return score; };
  const plain = JSON.stringify(planOf(build()));
  const json = (score: model.Score) => { score.finish(settings); return model.JsonConverter.scoreToJson(score); };
  for (const profiles of [undefined, {}, { other: { style: 'pick' } } as Record<string, TrackInterpretation>]) expect(JSON.stringify(buildPlaybackPlanFromJson(json(build()), ['t0'], 3, profiles))).toBe(plain);
});

it('routes unmarked stringed notes to the chosen style and lets every written mark override it', () => {
  const score = authored(1);
  const plain = note(score, 0, 0, 1, 3), finger = note(score, 0, 1, 2, 3), picked = note(score, 0, 2, 3, 3), muted = note(score, 0, 3, 4, 3);
  finger.rightHandFinger = model.Fingers.IndexFinger; picked.beat.pickStroke = model.PickStroke.Down; muted.isPalmMute = true;
  const articulations = (style?: 'pick' | 'fingers') => planOf(score, style && { style }).notes.map(n => n.articulation);
  expect(articulations()).toEqual(['picked', 'fingered', 'picked', 'muted']);
  expect(articulations('fingers')).toEqual(['fingered', 'fingered', 'picked', 'muted']);
  expect(articulations('pick')).toEqual(['picked', 'fingered', 'picked', 'muted']);
  expect(plain.beat.index).toBe(0);
  // Dead, ghost, staccato and harmonic notes keep their own sound whatever the style.
  const marks = authored(1); note(marks, 0, 0).isDead = true; note(marks, 0, 1).isGhost = true; note(marks, 0, 2).isStaccato = true; note(marks, 0, 3).harmonicType = model.HarmonicType.Natural;
  expect(planOf(marks, { style: 'fingers' }).notes.map(n => n.articulation)).toEqual(['dead', 'ghost', 'staccato', 'harmonic']);
});

it('moves a bass between its fingered default and a picked style, and leaves legato passages legato', () => {
  const bass = authored(1, 33, [43, 38, 33, 28]); note(bass, 0, 0, 3, 2); note(bass, 0, 1, 3, 4);
  expect(planOf(bass).notes.map(n => n.articulation)).toEqual(['fingered', 'fingered']);
  expect(planOf(bass, { style: 'pick' }).notes.map(n => n.articulation)).toEqual(['picked', 'picked']);
  const legato = authored(1), origin = note(legato, 0, 0, 2, 3), slurred = note(legato, 0, 1, 2, 5);
  origin.isHammerPullOrigin = true; origin.hammerPullDestination = slurred; slurred.hammerPullOrigin = origin;
  expect(planOf(legato, { style: 'fingers' }).notes.map(n => n.articulation)).toEqual(['fingered', 'legato']);
});

it('plays no style on notes that are not stringed', () => {
  const score = authored(1); const n = score.tracks[0].staves[0].bars[0].voices[0].beats[0]; const pitched = new model.Note(); pitched.octave = 4; pitched.tone = 0; n.addNote(pitched);
  score.tracks[0].staves[0].stringTuning.tunings = [];
  expect(JSON.stringify(planOf(score, { style: 'fingers', brush: 'down', letRing: true, accent: 'strong' }))).toBe(JSON.stringify(planOf(score)));
});

it('plays a light palm mute looser and a heavy one softer than the written one', () => {
  const score = authored(1); for (let i = 0; i < 4; i++) { const n = note(score, 0, i, 5, 2); n.isPalmMute = i < 3; }
  const normal = planOf(score), light = planOf(score, { palmMute: 'light' }), heavy = planOf(score, { palmMute: 'heavy' });
  expect(normal.notes.map(n => n.articulation)).toEqual(['muted', 'muted', 'muted', 'picked']);
  expect(light.notes.map(n => n.articulation)).toEqual(['staccato', 'staccato', 'staccato', 'picked']);
  expect(heavy.notes.map(n => n.articulation)).toEqual(['muted', 'muted', 'muted', 'picked']);
  expect(heavy.notes.slice(0, 3).map(n => n.velocity)).toEqual(normal.notes.slice(0, 3).map(n => Math.round(n.velocity * 0.8)));
  expect(heavy.notes[0].velocity).toBeLessThan(normal.notes[0].velocity);
  expect(heavy.notes[3].velocity).toBe(normal.notes[3].velocity);
  expect(light.notes.map(n => n.velocity)).toEqual(normal.notes.map(n => n.velocity));
  // The written score is not rewritten: its notes still carry their palm mutes.
  expect(score.tracks[0].staves[0].bars[0].voices[0].beats.map(b => b.notes[0].isPalmMute)).toEqual([true, true, true, false]);
});

it('accents the strong beats of the meter, the downbeat most', () => {
  const four = authored(1); for (let i = 0; i < 4; i++) note(four, 0, i, 2 + i, 3);
  const normal = planOf(four), light = planOf(four, { accent: 'light' }), strong = planOf(four, { accent: 'strong' });
  const gain = (plan: PlaybackPlan) => byBeat(plan).map((n, i) => n.velocity - byBeat(normal)[i].velocity);
  expect(gain(light)).toEqual([10, 0, 5, 0]);
  expect(gain(strong)).toEqual([22, 0, 11, 0]);
  const waltz = authored(1); waltz.masterBars[0].timeSignatureNumerator = 3;
  waltz.tracks[0].staves[0].bars[0].voices[0].beats.pop(); for (let i = 0; i < 3; i++) note(waltz, 0, i, 2 + i, 3);
  expect(strongOffsets(3, 4)).toEqual({ downbeat: 0, middle: [] });
  expect(strongOffsets(6, 8)).toEqual({ downbeat: 0, middle: [1440] });
  expect(strongOffsets(12, 8)).toEqual({ downbeat: 0, middle: [1440, 2880, 4320] });
  const waltzNormal = planOf(waltz), waltzStrong = planOf(waltz, { accent: 'strong' });
  expect(byBeat(waltzStrong).map((n, i) => n.velocity - byBeat(waltzNormal)[i].velocity)).toEqual([22, 0, 0]);
  // Ghost and dead notes stay as quiet as written.
  const quiet = authored(1); note(quiet, 0, 0).isGhost = true; note(quiet, 0, 2).isDead = true;
  expect(planOf(quiet, { accent: 'strong' }).notes.map(n => n.velocity)).toEqual(planOf(quiet).notes.map(n => n.velocity));
});

it('brushes a written chord from the low strings up or the high strings down, and leaves written brushes and single notes alone', () => {
  const chord = () => { const score = authored(1); for (const [string, fret] of [[6, 3], [5, 2], [4, 0], [3, 0]]) note(score, 0, 0, string, fret); note(score, 0, 2, 1, 3); return score; };
  const normal = planOf(chord()), down = planOf(chord(), { brush: 'down' }), up = planOf(chord(), { brush: 'up' });
  const starts = (plan: PlaybackPlan) => byBeat(plan).filter(n => n.startTick < 960).sort((a, b) => a.key - b.key).map(n => n.startTick);
  expect(starts(normal)).toEqual([0, 0, 0, 0]);
  expect(starts(down)).toEqual([0, 30, 60, 90]);
  expect(starts(up)).toEqual([90, 60, 30, 0]);
  expect(down.notes.find(n => n.startTick === 1920)).toEqual(normal.notes.find(n => n.startTick === 1920));
  for (const plan of [down, up]) {
    for (const n of plan.notes) { expect(n.pitch[0].tick).toBe(n.startTick); expect(n.endTick).toBe(normal.notes.find(o => o.key === n.key && o.endTick === n.endTick)!.endTick); }
    expect(sounding(plan).on).toEqual(plan.notes.map(n => [n.startTick, n.key, n.velocity]).sort());
  }
  const written = chord(); const first = written.tracks[0].staves[0].bars[0].voices[0].beats[0]; first.brushType = model.BrushType.BrushUp; first.brushDuration = 120;
  expect(JSON.stringify(planOf(written, { brush: 'down' }))).toBe(JSON.stringify(planOf(written)));
});

it('lets strings ring to the next pluck on the same string or the end of the bar, and not past a mute', () => {
  const score = authored(2); note(score, 0, 0, 2, 3); note(score, 0, 2, 2, 5); note(score, 0, 1, 3, 3); note(score, 0, 3, 4, 3).isPalmMute = true; note(score, 1, 0, 2, 3);
  const normal = planOf(score), ringing = planOf(score, { letRing: true });
  const ends = (plan: PlaybackPlan) => plan.notes.map(n => [n.startTick, n.endTick]);
  expect(ends(normal)).toEqual([[0, 960], [960, 1920], [1920, 2880], [2880, 3040], [3840, 4800]]);
  // The first note rings until the same string is plucked on beat three, the second to the end of its bar, the palm mute not at all.
  expect(ends(ringing)).toEqual([[0, 1920], [960, 3840], [1920, 3840], [2880, 3040], [3840, 7680]]);
  expect(ringing.notes[3].articulation).toBe('muted');
  expect(ringing.durationTick).toBeGreaterThanOrEqual(7680);
  expect(sounding(ringing).off).toEqual(ringing.notes.map(n => [n.endTick, n.key]).sort());
});

it('measures a distinct playback for each setting without rewriting the score', () => {
  const build = () => { const score = authored(1); note(score, 0, 0, 3, 2); note(score, 0, 0, 2, 3); note(score, 0, 1, 4, 2).isPalmMute = true; note(score, 0, 2, 5, 3); note(score, 0, 3, 5, 3); return score; };
  const score = build(); score.finish(settings);
  const before = model.JsonConverter.scoreToJson(score);
  const base = JSON.stringify(planOf(score));
  const settingsToTry: TrackInterpretation[] = [{ style: 'fingers' }, { palmMute: 'light' }, { palmMute: 'heavy' }, { accent: 'light' }, { accent: 'strong' }, { letRing: true }, { brush: 'down' }, { brush: 'up' }];
  const results = settingsToTry.map(profile => JSON.stringify(planOf(score, profile)));
  expect(new Set([base, ...results]).size).toBe(settingsToTry.length + 1);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  expect(JSON.stringify(planOf(score))).toBe(base);
});

it('keeps every interpreted plan valid for the native player', () => {
  const score = authored(2); for (let b = 0; b < 2; b++) for (let i = 0; i < 4; i++) { note(score, b, i, 1 + i, 2); note(score, b, i, 6, i); }
  for (const profile of [{ style: 'pick', palmMute: 'heavy', accent: 'strong', letRing: true, brush: 'down' }, { style: 'fingers', palmMute: 'light', accent: 'light', brush: 'up' }] as TrackInterpretation[])
    expect(() => planOf(score, profile)).not.toThrow();
});

it('validates interpretations strictly and canonically', () => {
  for (const good of [{ style: 'pick' }, { palmMute: 'heavy', letRing: true }, { style: 'fingers', palmMute: 'light', accent: 'strong', letRing: true, brush: 'up' }]) expect(() => validateInterpretation(good)).not.toThrow();
  for (const bad of [null, [], {}, { style: 'slap' }, { style: 'picking' }, { style: null }, { letRing: false }, { brush: 'sideways' }, { accent: 'strong', extra: 1 }, 'pick']) expect(() => validateInterpretation(bad), JSON.stringify(bad)).toThrow('Invalid track interpretation.');
  const mix = { gain: 1, pan: 0, mute: false, solo: false };
  expect(() => validateMix({ ...mix, interpretation: { brush: 'down' } })).not.toThrow();
  expect(() => validateMix({ ...mix, interpretation: {} })).toThrow();
  expect(() => validateMix({ ...mix, interpretation: undefined } as never)).toThrow();
  expect(() => validateMix({ ...mix, unknown: 1 } as never)).toThrow('Invalid mixer settings.');
  expect(canonicalInterpretation({ style: 'pick', letRing: undefined })).toEqual({ style: 'pick' });
  expect(canonicalInterpretation({})).toBeUndefined();
  expect(canonicalInterpretation(undefined)).toBeUndefined();
  expect(interpretationsOf({ a: mix, b: { ...mix, interpretation: { letRing: true } } })).toEqual({ b: { letRing: true } });
});

it('stores the interpretation with the track mix, replays it, copies it with a duplicated track and plans again when it changes', async () => {
  const target = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0 };
  let project = previewEdit(blankProject(), { type: 'setNote', target, string: 6, fret: 5 }).project;
  const built = buildDocument(project);
  const mix = { gain: 1, pan: 0, mute: false, solo: false };
  const bridge: NativeAudioBridge = { prepare: vi.fn(async () => {}), command: vi.fn(async () => {}), setMix: vi.fn(async () => {}), devices: vi.fn(async () => []), status: vi.fn(async () => null), subscribe: vi.fn(async () => () => {}), stageBacking: vi.fn(async () => null), stageEmbeddedBacking: vi.fn(async () => null) };
  const player = new NativePlaybackController({ bridge, onEdit: () => {} });
  await player.loadDocument(project, built);
  const first = vi.mocked(bridge.prepare).mock.calls.at(-1)![0];
  expect(first.notes[0].articulation).toBe('picked');
  const styled = previewEdit(project, { type: 'setTrackMix', trackId: 'base/0', mix: { ...mix, interpretation: { style: 'fingers', letRing: true } } }, built);
  expect(styled.settings.mixes['base/0'].interpretation).toEqual({ style: 'fingers', letRing: true });
  await player.loadDocument(styled.project, styled);
  expect(bridge.prepare).toHaveBeenCalledTimes(2);
  const second = vi.mocked(bridge.prepare).mock.calls.at(-1)![0];
  expect(second.notes[0].articulation).toBe('fingered'); expect(second.notes[0].endTick).toBeGreaterThan(first.notes[0].endTick);
  // The same interpretation again, and a pure mix change, only update the mix.
  await player.loadDocument(styled.project, styled);
  const louder = previewEdit(styled.project, { type: 'setTrackMix', trackId: 'base/0', mix: { ...mix, gain: .5, interpretation: { style: 'fingers', letRing: true } } }, styled);
  await player.loadDocument(louder.project, louder);
  expect(bridge.prepare).toHaveBeenCalledTimes(2); expect(bridge.setMix).toHaveBeenCalledTimes(1);
  // Clearing it plans the written notes again, byte for byte.
  const cleared = previewEdit(louder.project, { type: 'setTrackMix', trackId: 'base/0', mix: { ...mix, gain: .5 } }, louder);
  await player.loadDocument(cleared.project, cleared);
  expect(bridge.prepare).toHaveBeenCalledTimes(3);
  expect(vi.mocked(bridge.prepare).mock.calls.at(-1)![0].notes).toEqual(first.notes);
  // A duplicated track starts with its source's interpretation.
  const copied = previewEdit(styled.project, { type: 'duplicateTrack', track: 0 }, styled);
  expect(Object.values(copied.settings.mixes).filter(m => m.interpretation?.style === 'fingers')).toHaveLength(2);
  player.destroy(); project = styled.project; expect(project.edits.at(-1)).toMatchObject({ type: 'setTrackMix' });
});

const accents = (written: model.Score) => { const plain = planOf(written), strong = planOf(written, { accent: 'strong' }); return byBeat(strong).map((n, i) => n.velocity - byBeat(plain)[i].velocity); };

it('accents the main note of a beat, not its grace note, and counts from the written position', () => {
  const score = authored(1), voice = score.tracks[0].staves[0].bars[0].voices[0];
  voice.beats.length = 0;
  const beat = (grace: boolean, fret?: number) => {
    const b = new model.Beat(); b.duration = grace ? model.Duration.Sixteenth : model.Duration.Quarter; b.isEmpty = false;
    if (grace) b.graceType = model.GraceType.OnBeat;
    voice.addBeat(b);
    if (fret !== undefined) { const n = new model.Note(); n.string = grace ? 1 : 2; n.fret = fret; b.addNote(n); }
  };
  beat(true, 5); beat(false, 3); beat(false); beat(true, 5); beat(false, 3); beat(false);
  const result = accents(score);
  expect(result.filter(v => v !== 0)).toEqual([22, 11]);
  expect(result.length).toBe(4);
});

it('right-aligns a pickup bar and accents only the first attack of a trill', () => {
  const pickup = authored(2); pickup.masterBars[0].isAnacrusis = true;
  pickup.tracks[0].staves[0].bars[0].voices[0].beats.splice(2, 2);
  note(pickup, 0, 0, 2, 3); note(pickup, 0, 1, 3, 3); note(pickup, 1, 0, 2, 3);
  expect(accents(pickup)).toEqual([11, 0, 22]);
  const trill = authored(1), whole = trill.tracks[0].staves[0].bars[0].voices[0]; whole.beats.splice(1, 3); whole.beats[0].duration = model.Duration.Whole;
  const n = note(trill, 0, 0, 2, 3); n.trillValue = 5; n.trillSpeed = model.Duration.Sixteenth;
  const all = accents(trill); expect(all.length).toBeGreaterThan(4); expect(all.filter(v => v !== 0)).toEqual([22]);
});

it('finds strong beats after tuplet rounding without accenting its neighbours', () => {
  const score = authored(1), voice = score.tracks[0].staves[0].bars[0].voices[0];
  voice.beats.length = 0;
  for (let i = 0; i < 16; i++) { const beat = new model.Beat(); beat.duration = i < 14 ? model.Duration.Sixteenth : model.Duration.Quarter; if (i < 14) { beat.tupletNumerator = 7; beat.tupletDenominator = 4; } beat.isEmpty = false; voice.addBeat(beat); note(score, 0, i, 2 + i % 4, 3); }
  const result = accents(score);
  expect(result.filter(v => v !== 0)).toEqual([22, 11]);
  expect(result[0]).toBe(22);
});

it('changes the newest mix, not the one last loaded, when the mixer moves a fader', async () => {
  const project = blankProject(), built = buildDocument(project), onEdit = vi.fn();
  const bridge = { prepare: vi.fn(async () => {}), command: vi.fn(async () => {}), setMix: vi.fn(async () => {}), devices: vi.fn(async () => []), status: vi.fn(async () => null), subscribe: vi.fn(async () => () => {}), stageBacking: vi.fn(async () => null), stageEmbeddedBacking: vi.fn(async () => null) } as NativeAudioBridge;
  const newest = { gain: 1, pan: 0, mute: false, solo: false, interpretation: { brush: 'up' } as TrackInterpretation };
  const player = new NativePlaybackController({ bridge, onEdit, latestMix: id => id === 'base/0' ? newest : undefined });
  await player.loadDocument(project, built);
  player.setTrackVolume(0, .4);
  expect(onEdit).toHaveBeenLastCalledWith({ type: 'setTrackMix', trackId: 'base/0', mix: { ...newest, gain: .4 } });
  player.destroy();
});

it('shows a brushed chord as one onset in the next-notes instrument view', () => {
  const score = authored(1); for (const s of [6, 5, 4]) note(score, 0, 0, s, 2); note(score, 0, 1, 2, 3);
  const plan = planOf(score, { brush: 'down' });
  const input = (tick: number | null) => ({ active: [], notes: plan.notes, beats: plan.performedBeats ?? [], tick, counting: false, loop: null, range: null, target: { track: 0, staff: 0, bar: 0, voice: 0, beat: 1 } });
  expect(plan.notes.filter(n => n.startTick < 960).map(n => n.startTick).sort()).toEqual([0, 30, 60]);
  // Before the chord, and while its brush is still spreading, the next onset is the second beat, not the rest of the chord.
  expect(focusNotes('next', input(-1)).map(n => n.source.target.beat)).toEqual([0, 0, 0]);
  expect(focusNotes('next', input(10)).map(n => n.source.target.beat)).toEqual([1]);
});

it('leaves a written slap and a written pick stroke alone', () => {
  const bass = authored(1, 33, [43, 38, 33, 28]); note(bass, 0, 0, 3, 2).beat.slap = true;
  expect(planOf(bass, { style: 'pick' }).notes[0].articulation).toBe('fingered');
  const chord = authored(1); for (const s of [6, 5, 4]) note(chord, 0, 0, s, 2); chord.tracks[0].staves[0].bars[0].voices[0].beats[0].pickStroke = model.PickStroke.Down;
  expect(JSON.stringify(planOf(chord, { brush: 'down' }))).toBe(JSON.stringify(planOf(chord)));
});
