import { expect, it } from 'vitest';
import { midi, model, Settings } from '@coderline/alphatab';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildPerformedBeats } from './performed-beats';
import type { PerformedBeat } from './selection-playback-types';

const settings = new Settings();
function authored(bars = 1, voices = 1, tracks = 1) {
  const score = new model.Score();
  for (let b = 0; b < bars; b++) score.addMasterBar(new model.MasterBar());
  for (let t = 0; t < tracks; t++) {
    const track = new model.Track(); track.playbackInfo.primaryChannel = t * 2; track.playbackInfo.secondaryChannel = t * 2 + 1; score.addTrack(track);
    const staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff);
    for (let b = 0; b < bars; b++) {
      const bar = new model.Bar(); staff.addBar(bar);
      for (let v = 0; v < voices; v++) {
        const voice = new model.Voice(); bar.addVoice(voice);
        for (let i = 0; i < 4; i++) { const beat = new model.Beat(); beat.isEmpty = false; beat.duration = model.Duration.Quarter; voice.addBeat(beat); }
      }
    }
  }
  return score;
}
const voiceOf = (score: model.Score, bar = 0, voice = 0, track = 0) => score.tracks[track].staves[0].bars[bar].voices[voice];
function addNote(beat: model.Beat, fret = 3) { const note = new model.Note(); note.string = 1; note.fret = fret; beat.addNote(note); return note; }
function leadingGrace(score: model.Score, kind: model.GraceType, bar = 0) {
  const voice = voiceOf(score, bar), beat = new model.Beat(); beat.duration = model.Duration.Eighth; beat.graceType = kind; beat.isEmpty = false; beat.voice = voice; addNote(beat, 9); voice.beats.unshift(beat);
}
class ShiftHandler extends midi.AlphaSynthMidiFileHandler {
  shift = 0;
  override addTickShift(value: number) { this.shift = value; super.addTickShift(value); }
}
function prepare(score: model.Score) {
  score.rebuildRepeatGroups(); score.finish(settings);
  const file = new midi.MidiFile(), handler = new ShiftHandler(file, true), generator = new midi.MidiFileGenerator(score, settings, handler); generator.generate();
  return { lookup: generator.tickLookup, shift: handler.shift, file };
}
function mapped(score: model.Score) { const { lookup, shift } = prepare(score); return buildPerformedBeats(score, lookup, shift); }
function row(bar: number, voice: number, beat: number, startTick: number, endTick: number, leadInTick = startTick, occurrence = 0, track = 0): PerformedBeat {
  return { target: { track, staff: 0, bar, voice, beat }, occurrence, startTick, endTick, leadInTick };
}

// Dropping silent rows or merging voices would lose these independent selection locations.
it('silent_and_tied_beats_have_distinct_rows', () => {
  const score = authored(1, 2), beats = voiceOf(score).beats, origin = addNote(beats[1]), destination = addNote(beats[2]);
  destination.isTieDestination = true; destination.tieOrigin = origin; origin.tieDestination = destination;
  voiceOf(score, 0, 1).beats.splice(2); voiceOf(score, 0, 1).beats[0].duration = model.Duration.Half; voiceOf(score, 0, 1).beats[1].duration = model.Duration.Half;
  const { lookup, shift, file } = prepare(score), rows = buildPerformedBeats(score, lookup, shift);
  expect(rows).toEqual([row(0, 0, 0, 0, 960), row(0, 1, 0, 0, 1920), row(0, 0, 1, 960, 1920), row(0, 0, 2, 1920, 2880), row(0, 1, 1, 1920, 3840), row(0, 0, 3, 2880, 3840)]);
  expect(file.tracks.flatMap(t => t.events).filter(e => e.type === midi.MidiEventType.NoteOn)).toHaveLength(1);
});

it('empty_placeholder_covers_public_bar_and_unused_voice_stays_absent', () => {
  const score = authored(1, 2);
  for (const voice of score.tracks[0].staves[0].bars[0].voices) { voice.beats.splice(1); voice.beats[0].isEmpty = true; }
  expect(mapped(score)).toEqual([row(0, 0, 0, 0, 3840)]);
  expect(voiceOf(score).beats[0].displayDuration).toBe(960);
});

it('swing_uses_public_slices_not_model_playback_start', () => {
  const score = authored(), voice = voiceOf(score); voice.beats = [];
  for (let i = 0; i < 8; i++) { const beat = new model.Beat(); beat.duration = model.Duration.Eighth; beat.isEmpty = false; voice.addBeat(beat); }
  score.masterBars[0].tripletFeel = model.TripletFeel.Triplet8th;
  expect(mapped(score)).toEqual([row(0, 0, 0, 0, 640), row(0, 0, 1, 640, 960), row(0, 0, 2, 960, 1600), row(0, 0, 3, 1600, 1920), row(0, 0, 4, 1920, 2560), row(0, 0, 5, 2560, 2880), row(0, 0, 6, 2880, 3520), row(0, 0, 7, 3520, 3840)]);
  expect(voice.beats.slice(0, 2).map(b => b.playbackStart)).toEqual([0, 480]);
});

it.each([
  [model.GraceType.BeforeBeat, 0, 120, 120, 1080],
  [model.GraceType.OnBeat, 0, 120, 120, 960],
] as const)('grace_shift_and_owned_occurrences_%i', (kind, graceStart, graceEnd, principalStart, principalEnd) => {
  const score = authored(); leadingGrace(score, kind);
  expect(mapped(score).slice(0, 2)).toEqual([row(0, 0, 0, graceStart, graceEnd), row(0, 0, 1, principalStart, principalEnd, 0)]);
});

it('bend_grace_and_trailing_orphan_keep_their_public_bodies', () => {
  const bend = authored(); voiceOf(bend).beats[0].graceType = model.GraceType.BendGrace;
  expect(mapped(bend).slice(0, 2)).toEqual([row(0, 0, 0, 0, 480), row(0, 0, 1, 480, 960, 0)]);
  const orphan = authored(); voiceOf(orphan).beats[3].graceType = model.GraceType.BeforeBeat;
  expect(mapped(orphan).at(-1)).toEqual(row(0, 0, 3, 2880, 3000));
});

it('next_measure_grace_preserves_other_voice_carried_slice', () => {
  const score = authored(2, 2); leadingGrace(score, model.GraceType.BeforeBeat, 1);
  const rows = mapped(score);
  expect(rows.filter(r => r.startTick >= 2880 && r.startTick < 4800)).toEqual([
    row(0, 0, 3, 2880, 3720), row(0, 1, 3, 2880, 3840), row(1, 0, 0, 3720, 3840), row(1, 0, 1, 3840, 4800, 3720), row(1, 1, 0, 3840, 4800),
  ]);
});

it('same_bar_repeat_does_not_merge_next_occurrence_grace', () => {
  const score = authored(1, 2); leadingGrace(score, model.GraceType.BeforeBeat);
  score.masterBars[0].isRepeatStart = true; score.masterBars[0].repeatCount = 2;
  const { lookup, shift } = prepare(score), rows = buildPerformedBeats(score, lookup, shift);
  expect(lookup.masterBars.map(m => m.start + shift)).toEqual([120, 3960]);
  expect(rows.filter(r => r.target.voice === 0 && r.target.beat <= 1)).toEqual([
    row(0, 0, 0, 0, 120), row(0, 0, 1, 120, 1080, 0), row(0, 0, 0, 3840, 3960, 3840, 1), row(0, 0, 1, 3960, 4920, 3840, 1),
  ]);
  expect(rows.filter(r => r.target.beat === 4 && r.target.voice === 0)).toEqual([row(0, 0, 4, 3000, 3960), row(0, 0, 4, 6840, 7800, 6840, 1)]);
  expect(rows.filter(r => r.target.beat === 3 && r.target.voice === 1)).toEqual([row(0, 1, 3, 3000, 3960), row(0, 1, 3, 6840, 7800, 6840, 1)]);
  expect(new Set(rows.map(r => JSON.stringify([r.target, r.occurrence]))).size).toBe(rows.length);
});

it('simile_is_played_placeholder_only', () => {
  const score = authored(4);
  score.tracks[0].staves[0].bars[1].simileMark = model.SimileMark.Simple;
  score.tracks[0].staves[0].bars[2].simileMark = model.SimileMark.FirstOfDouble;
  score.tracks[0].staves[0].bars[3].simileMark = model.SimileMark.SecondOfDouble;
  expect(mapped(score).filter(r => r.target.bar > 0)).toEqual([row(1, 0, 0, 3840, 7680), row(2, 0, 0, 7680, 11520), row(3, 0, 0, 11520, 15360)]);
  const borrowed = authored(2); leadingGrace(borrowed, model.GraceType.BeforeBeat); borrowed.tracks[0].staves[0].bars[1].simileMark = model.SimileMark.Simple;
  const { lookup, shift, file } = prepare(borrowed);
  expect(buildPerformedBeats(borrowed, lookup, shift).filter(r => r.target.bar === 1)).toEqual([row(1, 0, 0, 3960, 7800)]);
  expect(file.tracks.flatMap(t => t.events).filter(e => e.type === midi.MidiEventType.NoteOn).map(e => e.tick)).toEqual([0, 3840]);
});

it('pickup_and_free_time_keep_public_occurrence_ends', () => {
  const pickup = authored(2); pickup.masterBars[0].isAnacrusis = true; voiceOf(pickup).beats.splice(1);
  expect(mapped(pickup).slice(0, 2)).toEqual([row(0, 0, 0, 0, 960), row(1, 0, 0, 960, 1920)]);
  const free = authored(); free.masterBars[0].isFreeTime = true; voiceOf(free).beats.splice(2);
  const { lookup, shift } = prepare(free);
  expect(buildPerformedBeats(free, lookup, shift)).toEqual([row(0, 0, 0, 0, 960), row(0, 0, 1, 960, 1920)]);
  expect(lookup.masterBars[0].end).toBe(3840);
});

it('repeat_endings_and_directions_follow_performed_itinerary', () => {
  const repeat = authored(3); repeat.masterBars[0].isRepeatStart = true; repeat.masterBars[1].repeatCount = 2; repeat.masterBars[1].alternateEndings = 1; repeat.masterBars[2].alternateEndings = 2;
  expect(mapped(repeat).filter(r => r.target.beat === 0).map(r => [r.target.bar, r.occurrence, r.startTick])).toEqual([[0, 0, 0], [1, 0, 3840], [0, 1, 7680], [2, 0, 11520]]);
  const directed = authored(4); directed.masterBars[1].directions = new Set([model.Direction.TargetFine]); directed.masterBars[3].directions = new Set([model.Direction.JumpDaCapoAlFine]);
  expect(mapped(directed).filter(r => r.target.beat === 0).map(r => [r.target.bar, r.occurrence, r.startTick])).toEqual([[0, 0, 0], [1, 0, 3840], [2, 0, 7680], [3, 0, 11520], [0, 1, 15360], [1, 1, 19200]]);
});

it('preserves_source_links_json_and_full_midi_bytes', () => {
  const score = authored(2), origin = addNote(voiceOf(score).beats[1]), destination = addNote(voiceOf(score).beats[2]);
  destination.isTieDestination = true; destination.tieOrigin = origin; origin.tieDestination = destination; leadingGrace(score, model.GraceType.BeforeBeat);
  const { lookup, shift, file } = prepare(score), source = JSON.stringify(model.JsonConverter.scoreToJson(score)), bytes = file.toBinary();
  const sourceHash = createHash('sha256').update(source).digest('hex'), midiHash = createHash('sha256').update(bytes).digest('hex');
  expect(buildPerformedBeats(score, lookup, shift)).toHaveLength(9);
  expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(source); expect(file.toBinary()).toEqual(bytes);
  expect(origin.tieDestination).toBe(destination); expect(destination.tieOrigin).toBe(origin);
  console.log(JSON.stringify({ preservation: { sourceHash, midiHash } }));
});

it('maps_100_bars_four_tracks_without_second_generation_or_cache', () => {
  const score = authored(100, 1, 4), { lookup, shift } = prepare(score), started = performance.now();
  const rows = buildPerformedBeats(score, lookup, shift), elapsedMs = performance.now() - started;
  expect(rows).toHaveLength(1600); expect(rows[0]).toEqual(row(0, 0, 0, 0, 960)); expect(rows.at(-1)).toEqual(row(99, 0, 3, 383040, 384000, 383040, 0, 3));
  console.log(JSON.stringify({ benchmark: { bars: 100, tracks: 4, rows: rows.length, elapsedMs } }));
});


it('public_overlapping_slices_merge_without_restarting_carried_item', () => {
  const score = authored(), { lookup } = prepare(score), beat = voiceOf(score).beats[0];
  const first = new midi.BeatTickLookup(0, 500), second = new midi.BeatTickLookup(400, 960);
  first.highlightBeat(beat, 0); second.highlightBeat(beat, 0); first.nextBeat = second; second.previousBeat = first; lookup.masterBars[0].firstBeat = first;
  expect(buildPerformedBeats(score, lookup, 0)).toEqual([row(0, 0, 0, 0, 960)]);
});

it('zero_duration_public_row_is_retained', () => {
  const score = authored(), { lookup } = prepare(score), slice = new midi.BeatTickLookup(0, 0);
  slice.highlightBeat(voiceOf(score).beats[0], 0); lookup.masterBars[0].firstBeat = slice;
  expect(buildPerformedBeats(score, lookup, 0)).toEqual([row(0, 0, 0, 0, 0)]);
});

it.each(['gap', 'different-start'] as const)('ambiguous_disjoint_or_restarted_rows_fail_with_source_coordinates_%s', kind => {
  const score = authored(), { lookup } = prepare(score), beat = voiceOf(score).beats[0];
  const first = new midi.BeatTickLookup(0, 120), second = new midi.BeatTickLookup(kind === 'gap' ? 240 : 120, 360);
  first.highlightBeat(beat, 0); second.highlightBeat(beat, kind === 'gap' ? 0 : 120); first.nextBeat = second; second.previousBeat = first; lookup.masterBars[0].firstBeat = first;
  expect(() => buildPerformedBeats(score, lookup, 0)).toThrow(/track 0, staff 0, bar 0, voice 0, beat 0/);
});

it('unexpected_non_grace_ownership_and_noncanonical_address_fail', () => {
  const score = authored(2), { lookup } = prepare(score), slice = new midi.BeatTickLookup(0, 960);
  slice.highlightBeat(voiceOf(score, 1).beats[0], 0); lookup.masterBars[0].firstBeat = slice;
  expect(() => buildPerformedBeats(score, lookup, 0)).toThrow(/track 0, staff 0, bar 1, voice 0, beat 0/);
  const bad = authored(), prepared = prepare(bad); voiceOf(bad).beats[0].index = 99;
  expect(() => buildPerformedBeats(bad, prepared.lookup, 0)).toThrow(/track 0, staff 0, bar 0, voice 0, beat 99/);
});

it('invalid_shift_and_nonfinite_slice_fail_before_returning_a_map', () => {
  const score = authored(), { lookup } = prepare(score);
  for (const shift of [-1, Infinity, NaN]) expect(() => buildPerformedBeats(score, lookup, shift)).toThrow();
  lookup.masterBars[0].firstBeat!.end = Infinity;
  expect(() => buildPerformedBeats(score, lookup, 0)).toThrow(/track 0, staff 0, bar 0, voice 0, beat 0/);
});
