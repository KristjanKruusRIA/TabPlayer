import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlphaTabApiBase, exporter, importer, midi, model, Settings } from '@coderline/alphatab';
import { collectUntimedTremolo, TREMOLO_BEAT_ATTACKS, TREMOLO_GENERATION_ATTACKS, unguardedTremolo } from './tremolo-guard';
import { backingLocationsForScore, buildPlaybackPlan } from './audio/plan';
import { prepareScoreTimers } from './editor/timers';
import { exportMidi } from './export/midi';

const settings = new Settings(), { Quarter, Eighth, Whole, ThirtySecond, OneHundredTwentyEighth, TwoHundredFiftySixth } = model.Duration;
type Config = { tremolo?: boolean; marks?: number; tie?: boolean; timer?: boolean; short?: model.Duration; grace?: boolean; bars?: number };

// One bar: a quarter, a short beat with the tremolo, an optional grace beat that takes the short
// beat's time, a quarter that may be tied back to the short beat, then silence. Later bars are tied wholes.
function build(config: Config) {
  const score = new model.Score(), bars = config.bars ?? 1;
  for (let i = 0; i < bars; i++) score.addMasterBar(new model.MasterBar());
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  const track = new model.Track(), staff = new model.Staff();
  track.playbackInfo.program = 25; staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track);
  const bar = () => { const next = new model.Bar(), voice = new model.Voice(); staff.addBar(next); next.addVoice(voice); return voice; };
  const add = (voice: model.Voice, duration: model.Duration, played: boolean, configure?: (beat: model.Beat, note: model.Note) => void) => {
    const beat = new model.Beat(); beat.duration = duration; beat.isEmpty = false; voice.addBeat(beat);
    if (played) { const note = new model.Note(); note.string = 3; note.fret = 5; configure?.(beat, note); beat.addNote(note); }
    return beat;
  };
  const first = bar();
  add(first, Quarter, true);
  const short = add(first, config.short ?? ThirtySecond, true, beat => {
    if (config.tremolo !== false) { beat.tremoloPicking = new model.TremoloPickingEffect(); beat.tremoloPicking.marks = config.marks ?? 3; }
    if (config.timer) beat.showTimer = true;
  });
  if (config.grace !== false) add(first, Eighth, true, (beat, note) => { beat.graceType = model.GraceType.BeforeBeat; note.string = 1; });
  add(first, Quarter, true, (_beat, note) => { note.isTieDestination = !!config.tie; });
  add(first, Quarter, false); add(first, Quarter, false);
  for (let i = 1; i < bars; i++) add(bar(), Whole, true, (_beat, note) => { note.isTieDestination = !!config.tie; });
  score.finish(settings);
  return { score, short };
}
// The step alphaTab takes along the note, as its loop computes it.
const stepOf = (beat: model.Beat) => beat.tremoloPicking!.getDurationAsTicks(beat.duration) * (beat.playbackDuration / (3840 / beat.duration));

class Counter implements midi.IMidiFileHandler {
  attacks = 0;
  addTickShift() {} addTimeSignature() {} addRest() {} addControlChange() {} addProgramChange() {} addTempo() {} addBend() {} addNoteBend() {} finishTrack() {}
  addNote() { this.attacks++; }
}
const generate = (score: model.Score) => { const counter = new Counter(); new midi.MidiFileGenerator(score, settings, counter).generate(); return counter; };
// Plans generate from copies of the score, so a beat is named by where it is written.
const places = (beats: model.Beat[]) => beats.map(beat => `${beat.voice.bar.index}/${beat.index}`);
const json = (score: model.Score) => JSON.stringify(model.JsonConverter.scoreToJson(score));

describe('the shared tremolo guard, on the exact condition that spins alphaTab', () => {
  it('plays a grace-starved tied tremolo beat as the plain note, in the plan, and leaves the score alone', () => {
    const { score, short } = build({ tie: true });
    expect(short.playbackDuration).toBeLessThanOrEqual(0);
    expect(short.notes[0].isTieOrigin).toBe(true);
    const before = json(score);
    const { result: plan, beats } = collectUntimedTremolo(() => buildPlaybackPlan(score, 1));
    expect(places(beats)).toContain(`0/${short.index}`);
    // What the beat plays with no tremolo at all.
    const plain = buildPlaybackPlan(build({ tie: true, tremolo: false }).score, 1);
    expect(plan.notes).toEqual(plain.notes);
    expect(json(score)).toBe(before);
    expect(short.tremoloPicking!.marks).toBe(3);
  });

  it.each([
    ['a 256th with 4 marks', TwoHundredFiftySixth, 4], ['a 256th with 5 marks', TwoHundredFiftySixth, 5], ['a 128th with 5 marks', OneHundredTwentyEighth, 5],
  ] as const)('does not spin on %s, whose step truncates to zero ticks, with no grace note and no tie', (_name, duration, marks) => {
    const { score, short } = build({ short: duration, marks, grace: false });
    expect(short.tremoloPicking!.getDurationAsTicks(short.duration)).toBe(0);
    expect(short.playbackDuration).toBeGreaterThan(0);
    const { result: plan, beats } = collectUntimedTremolo(() => buildPlaybackPlan(score, 1));
    expect(places(beats)).toContain(`0/${short.index}`);
    expect(plan.notes.filter(note => note.source.target.beat === short.index)).toHaveLength(1);
  });

  it('does not spin when a file gives a tremolo no mark count (MusicXML <tremolo/>), on the routes that read the score as it is', () => {
    const { score, short } = build({ marks: NaN, grace: false });
    expect(Number.isNaN(short.tremoloPicking!.marks)).toBe(true);
    const { result: locations, beats } = collectUntimedTremolo(() => backingLocationsForScore(score));
    expect(locations).toHaveLength(1);
    expect(beats).toContain(short);
    const drawn = collectUntimedTremolo(() => generate(score));
    expect(drawn.beats).toContain(short);
    expect(drawn.result.attacks).toBeLessThan(40);
  });

  it('keeps every route into the generator finite: backing positions, MIDI export, and the source score', () => {
    const { score } = build({ tie: true }), before = json(score);
    expect(backingLocationsForScore(score).length).toBe(1);
    expect(exportMidi(score, { tracks: [0], range: null }).length).toBeGreaterThan(10);
    expect(json(score)).toBe(before);
  });

  it('keeps score timers finite for a hostile file read from bytes, as the document build and the PDF export call it', () => {
    const { score } = build({ tie: true, timer: true });
    score.title = 'hostile';
    const bytes = new exporter.Gp7Exporter().export(score, settings);
    const back = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
    expect(bytes.length).toBeLessThan(10000);
    const beat = back.tracks[0].staves[0].bars[0].voices[0].beats.find(item => item.showTimer)!;
    expect(beat).toBeDefined();
    prepareScoreTimers(back);
    expect(Number.isFinite(beat.timer)).toBe(true);
  });

  it('keeps the draw-time MIDI load finite: alphaTab loads MIDI for the rendered score on the main thread', () => {
    const { score } = build({ tie: true });
    const proto = AlphaTabApiBase.prototype as unknown as Record<string, (...args: unknown[]) => void>;
    const loads: unknown[] = [];
    let attacks = 0;
    const original = midi.AlphaSynthMidiFileHandler.prototype.addNote;
    midi.AlphaSynthMidiFileHandler.prototype.addNote = function (this: unknown, ...args: Parameters<typeof original>) {
      if (++attacks > 100000) throw new Error('the draw-time load did not stop');
      return original.apply(this as never, args);
    };
    try {
      const api = { _score: null, settings, get score() { return this._score; }, _trackIndexes: [], onError() {}, _onScoreLoaded() {}, render() {}, loadMidiForScore: proto.loadMidiForScore, _onMidiLoad() {}, tracks: score.tracks, playbackRange: null, _player: { loadMidiFile(file: unknown) { loads.push(file); }, loadBackingTrack() {}, updateSyncPoints() {}, applyTranspositionPitches() {} } };
      proto._internalRenderTracks.call(api, score, [score.tracks[0]]);
    } finally { midi.AlphaSynthMidiFileHandler.prototype.addNote = original; }
    expect(loads).toHaveLength(1);
    expect(attacks).toBeLessThan(50);
  });

  it('does not touch a tremolo it can sound: alphaTab\'s own generator and the guarded one write the same MIDI', () => {
    const pieces: Config[] = [{ grace: false }, { grace: false, tie: true, bars: 3 }, { short: Quarter, marks: 2, grace: false }, { marks: 5, short: Eighth, grace: false, tie: true, bars: 4 }, { tremolo: false }, { short: Whole, marks: 4, grace: false, bars: 2 }];
    const prototype = midi.MidiFileGenerator.prototype as unknown as { _generateTremoloPicking: unknown };
    const guarded = prototype._generateTremoloPicking;
    const render = (config: Config) => { const file = new midi.MidiFile(); new midi.MidiFileGenerator(build(config).score, settings, new midi.AlphaSynthMidiFileHandler(file, true)).generate(); return Array.from(file.toBinary()); };
    for (const config of pieces) {
      const mine = collectUntimedTremolo(() => render(config));
      prototype._generateTremoloPicking = unguardedTremolo;
      let theirs: number[];
      try { theirs = render(config); } finally { prototype._generateTremoloPicking = guarded; }
      expect(mine.beats, JSON.stringify(config)).toEqual([]);
      expect(mine.result, JSON.stringify(config)).toEqual(theirs);
    }
  });
});

describe('the shared tremolo guard, on the number of attacks', () => {
  it('has a step far from zero and a count far below the limit for tremolo as written in real scores', () => {
    // Three marks on a quarter note: a 32nd every 120 ticks, 8 attacks, however the beat is written.
    const { score, short } = build({ short: Quarter, marks: 3, grace: false });
    expect(stepOf(short)).toBe(120);
    expect(generate(score).attacks).toBeLessThan(40);
    expect(TREMOLO_BEAT_ATTACKS).toBeGreaterThan(500 * 32);
  });

  it('bounds one tied tremolo beat: just inside the limit it still sounds, just over it plays the plain note', () => {
    // A whole note with 5 marks: a 32nd every 120 ticks, 32 attacks per tied bar.
    const bars = (attacks: number) => Math.ceil(attacks / 32);
    const within = build({ short: Whole, marks: 5, tie: true, grace: false, bars: bars(TREMOLO_BEAT_ATTACKS) - 4 });
    const over = build({ short: Whole, marks: 5, tie: true, grace: false, bars: bars(TREMOLO_BEAT_ATTACKS) + 4 });
    const kept = collectUntimedTremolo(() => generate(within.score)), dropped = collectUntimedTremolo(() => generate(over.score));
    expect(kept.beats).toEqual([]);
    expect(kept.result.attacks).toBeGreaterThan(TREMOLO_BEAT_ATTACKS - 300);
    expect(dropped.beats).toContain(over.short);
    expect(dropped.result.attacks).toBeLessThan(40);
  });

  it('bounds a small positive step: a 1-tick beat with 5 marks over a tied bar would add over a hundred thousand attacks', () => {
    const { score, short } = build({ short: Whole, marks: 5, tie: true, grace: false, bars: 2 });
    short.tupletNumerator = 3840; short.tupletDenominator = 1;
    score.finish(settings);
    expect(short.playbackDuration).toBeGreaterThan(0);
    expect(stepOf(short)).toBeGreaterThan(0);
    expect(stepOf(short)).toBeLessThan(0.5);
    const { result, beats } = collectUntimedTremolo(() => generate(score));
    expect(beats).toContain(short);
    expect(result.attacks).toBeLessThan(40);
  });

  it('bounds the whole generation, so many tremolos that are each small cannot add up to exhaust memory', () => {
    const bars = Math.ceil(TREMOLO_GENERATION_ATTACKS / 128) + 100;
    const score = new model.Score();
    for (let i = 0; i < bars; i++) score.addMasterBar(new model.MasterBar());
    score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
    const track = new model.Track(), staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; track.addStaff(staff); score.addTrack(track);
    for (let i = 0; i < bars; i++) {
      const bar = new model.Bar(), voice = new model.Voice(); staff.addBar(bar); bar.addVoice(voice);
      for (let k = 0; k < 4; k++) {
        const beat = new model.Beat(); beat.duration = Quarter; beat.isEmpty = false; beat.tremoloPicking = new model.TremoloPickingEffect(); beat.tremoloPicking.marks = 5; voice.addBeat(beat);
        const note = new model.Note(); note.string = 3; note.fret = 5; beat.addNote(note);
      }
    }
    score.finish(settings);
    const { result, beats } = collectUntimedTremolo(() => generate(score));
    expect(beats.length).toBeGreaterThan(0);
    expect(result.attacks).toBeLessThanOrEqual(TREMOLO_GENERATION_ATTACKS + beats.length);
    expect(result.attacks).toBeGreaterThan(TREMOLO_GENERATION_ATTACKS / 2);
  });
});

describe('every route into alphaTab\'s MIDI generator goes through the guard', () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [path] : [];
  });
  it('is imported by each module that generates, loads or renders MIDI', () => {
    const root = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
    const routes = sources(root).filter(path => /MidiFileGenerator|new AlphaTabApi\(|\.renderScore\(/.test(readFileSync(path, 'utf8')));
    expect(routes.map(path => path.slice(root.length).replace(/\\/g, '/')).sort()).toEqual(expect.arrayContaining(['ScoreView.tsx', 'audio/NativePlaybackController.ts', 'audio/plan.ts', 'editor/timers.ts', 'export/midi.ts', 'export/pdf.ts']));
    for (const path of routes) if (!path.endsWith('tremolo-guard.ts')) expect(readFileSync(path, 'utf8'), path).toMatch(/import\s+'(\.\.?\/)+tremolo-guard'/);
  });
});
