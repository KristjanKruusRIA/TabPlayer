import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildPlaybackPlan, validatePlaybackPlan } from './plan';
import { effectiveTempos, fermataEffectiveBpm, millisecondsAtTick } from './fermata';
import { loadInterchangeScore } from '../interchange/gp';
import { music } from '../editor/fixtures';

const settings = new Settings();
const GPIF = 'Content/score.gpif';

function loadProbe(bpm?: number, lengths?: number[]) {
  const raw = readFileSync(new URL('../interchange/fixtures/fermata-visible-120.gp8.gp', import.meta.url));
  if (bpm === undefined && lengths === undefined) {
    return loadInterchangeScore(raw, settings);
  }
  const entries = unzipSync(raw);
  let xml = strFromU8(entries[GPIF]);
  if (bpm !== undefined) xml = xml.replace('<Value>120 2</Value>', `<Value>${bpm} 2</Value>`);
  if (lengths !== undefined) {
    let i = 0;
    xml = xml.replace(/(<Fermata>[\s\S]*?<Length>)[^<]*(<\/Length>)/g, (_, a, b) => a + lengths[i++] + b);
    expect(i).toBe(lengths.length);
  }
  entries[GPIF] = strToU8(xml);
  return loadInterchangeScore(zipSync(entries), settings);
}

it('matches Guitar Pro 8.0.0 build 18 WAV render durations at 120, 60 and 90 BPM within 1 ms', () => {
  const plan120 = buildPlaybackPlan(loadProbe(), 1);
  expect(plan120.durationMs / 1000).toBeCloseTo(237.387166, 3);
  expect(plan120.fermatas).toHaveLength(14);
  expect(plan120.tempos).toEqual([{ tick: 0, bpm: 120 }]);

  const plan60 = buildPlaybackPlan(loadProbe(60), 1);
  expect(plan60.durationMs / 1000).toBeCloseTo(294.774354, 3);

  const lengths90 = [0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 1.125, 1.25, 1.5, 1.55, 1.58, 1.59, 0.33, 0.67];
  const plan90 = buildPlaybackPlan(loadProbe(90, lengths90), 1);
  expect(plan90.durationMs / 1000).toBeCloseTo(239.647574, 3);
});

it('handles fermata types, rests, note lengths, length-2 clamp, sub-1-BPM floors, repeats, tempo changes, and simultaneous unequal beats', () => {
  // Short, Medium, Long with equal length give identical timing.
  const durations = [model.FermataType.Short, model.FermataType.Medium, model.FermataType.Long].map(type => {
    const score = music();
    score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
    score.masterBars[0].addFermata(960, Object.assign(new model.Fermata(), { type, length: 0.5 }));
    score.finish(settings);
    return buildPlaybackPlan(score, 1).durationMs;
  });
  expect(new Set(durations).size).toBe(1);

  // Rest, half note, eighth note and length 2 clamp (60 s per quarter at both 120 and 60 BPM).
  const probe120 = buildPlaybackPlan(loadProbe(), 1);
  const probe60 = buildPlaybackPlan(loadProbe(60), 1);
  const barLen = (plan: ReturnType<typeof buildPlaybackPlan>, bar: number) => {
    const occ = plan.occurrences[bar];
    return (occ.endMs - occ.startMs) / 1000;
  };
  // Bar 0 has the hand-authored 0.5-length quarter on beat 0; bar 1 is case 0 (short-0); bar 2 is plain control (2.0 s).
  expect(barLen(probe120, 2)).toBeCloseTo(2.0, 6);
  // Case 'medium-2' is bar index 11 (quarter with length 2 -> 60 s total for that beat + 3 normal quarters).
  const med2Index = probe120.occurrences.findIndex(o => probe120.fermatas!.some(f => f.startTick >= o.startTick && f.endTick <= o.endTick && f.length === 2));
  expect(barLen(probe120, med2Index)).toBeCloseTo(60 + 3 * 0.5, 6);
  expect(barLen(probe60, med2Index)).toBeCloseTo(60 + 3 * 1.0, 6);

  // Half-note fermata (2x quarter delay) and eighth-note fermata (0.5x quarter delay) at length 0.
  const quarterZeroBar = barLen(probe120, 1); // bar 2 (index 1) is short-0
  const halfZeroBar = barLen(probe120, 23); // bar 24 (index 23) is half-note, length 0
  const eighthZeroBar = barLen(probe120, 25); // bar 26 (index 25) is eighth-note, length 0
  const quarterDelay = quarterZeroBar - 2.0;
  expect(halfZeroBar - 2.0).toBeCloseTo(2 * quarterDelay, 6);
  expect(eighthZeroBar - 2.0).toBeCloseTo(0.5 * quarterDelay, 6);

  // Sub-1-BPM score never speeds up during a fermata.
  expect(fermataEffectiveBpm(0.5, 0)).toBe(0.5);
  expect(fermataEffectiveBpm(120, 2)).toBe(1);

  // Repeated bar applies the fermata on every occurrence.
  const rep = music();
  rep.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  rep.masterBars[0].isRepeatStart = true;
  rep.masterBars[0].repeatCount = 2;
  rep.masterBars[0].addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: 0.5 }));
  rep.rebuildRepeatGroups();
  rep.finish(settings);
  const repPlan = buildPlaybackPlan(rep, 1);
  expect(repPlan.fermatas).toHaveLength(2);
  expect(repPlan.occurrences[0].endMs - repPlan.occurrences[0].startMs).toBeCloseTo(repPlan.occurrences[1].endMs - repPlan.occurrences[1].startMs, 6);

  // Simultaneous unequal beats across two tracks stretch the shorter beat.
  const two = music();
  two.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  const t2 = new model.Track();
  const s2 = new model.Staff();
  s2.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
  two.addTrack(t2);
  t2.addStaff(s2);
  for (let b = 0; b < two.masterBars.length; b++) {
    const bar = new model.Bar(), voice = new model.Voice();
    s2.addBar(bar); bar.addVoice(voice);
    const beat = new model.Beat();
    beat.duration = model.Duration.Whole; beat.isEmpty = false;
    const note = new model.Note(); note.string = 6; note.fret = 0;
    beat.addNote(note); voice.addBeat(beat);
  }
  two.masterBars[0].addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: 1 }));
  two.finish(settings);
  const twoPlan = buildPlaybackPlan(two, 1);
  expect(twoPlan.fermatas).toEqual([{ startTick: 0, endTick: 960, length: 1 }]);

  // Back-to-back fermatas and tempo change inside a fermata keep effectiveTempos sorted & valid.
  const eff = effectiveTempos(
    [{ tick: 0, bpm: 120 }, { tick: 480, bpm: 60 }],
    [{ startTick: 0, endTick: 960, length: 0.5 }, { startTick: 960, endTick: 1920, length: 0.5 }],
  );
  expect(eff).toEqual([
    { tick: 0, bpm: fermataEffectiveBpm(120, 0.5) },
    { tick: 480, bpm: fermataEffectiveBpm(60, 0.5) },
    { tick: 1920, bpm: 60 },
  ]);
  expect(millisecondsAtTick(480, eff)).toBeCloseTo(0.5 * 60000 / fermataEffectiveBpm(120, 0.5), 6);

  // Score without fermatas omits plan.fermatas completely.
  const plain = music();
  plain.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  plain.finish(settings);
  const plainPlan = buildPlaybackPlan(plain, 1);
  expect(Object.hasOwn(plainPlan, 'fermatas')).toBe(false);
});

it('matches Guitar Pro 8.0.0 build 18 WAV timings for unequal, interleaved, mid-hold tempo-change, and sustaining tracks', () => {
  type Spec = { dur: model.Duration; dots?: number };
  function probeScore(
    bar1Tracks: [Spec[], Spec[]],
    tempos: { bar: number; pos: number; bpm: number }[],
    fermata?: { offset: number; length: number },
  ) {
    const score = new model.Score();
    for (let b = 0; b < 3; b++) {
      const mb = new model.MasterBar();
      for (const t of tempos.filter(x => x.bar === b)) {
        mb.tempoAutomations.push(model.Automation.buildTempoAutomation(false, t.pos, t.bpm, 2));
      }
      if (b === 1 && fermata) {
        mb.addFermata(fermata.offset, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: fermata.length }));
      }
      score.addMasterBar(mb);
    }
    for (let ti = 0; ti < 2; ti++) {
      const track = new model.Track(), staff = new model.Staff();
      staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];
      track.addStaff(staff);
      score.addTrack(track);
      for (let b = 0; b < 3; b++) {
        const bar = new model.Bar(), voice = new model.Voice();
        const specs: Spec[] = b === 1
          ? bar1Tracks[ti]
          : Array.from({ length: 4 }, () => ({ dur: model.Duration.Quarter }));
        for (const s of specs) {
          const beat = new model.Beat();
          beat.duration = s.dur;
          beat.dots = s.dots ?? 0;
          beat.isEmpty = false;
          const note = new model.Note();
          note.string = 6;
          note.fret = ti === 0 ? 12 : 0;
          beat.addNote(note);
          voice.addBeat(beat);
        }
        bar.addVoice(voice);
        staff.addBar(bar);
      }
    }
    score.finish(settings);
    return buildPlaybackPlan(score, 1);
  }

  const q: Spec = { dur: model.Duration.Quarter };
  const w: Spec = { dur: model.Duration.Whole };
  const h: Spec = { dur: model.Duration.Half };
  const e: Spec = { dur: model.Duration.Eighth };
  const dq: Spec = { dur: model.Duration.Quarter, dots: 1 };
  const t120 = [{ bar: 0, pos: 0, bpm: 120 }];

  // 1. Control: 264,600 frames @ 44,100 Hz = 6.000000 s
  const control = probeScore([[q, q, q, q], [w]], t120);
  expect(control.durationMs).toBeCloseTo(6000, 6);

  // 2. Short-first: 330,750 frames = 7.500000 s; T1 whole note sustains across held beat 0 and releases at 5.5 s
  const shortFirst = probeScore([[q, q, q, q], [w]], t120, { offset: 0, length: 1 });
  expect(shortFirst.durationMs).toBeCloseTo(7500, 6);
  expect(shortFirst.fermatas).toEqual([{ startTick: 3840, endTick: 4800, length: 1 }]);
  const effShort = effectiveTempos(shortFirst.tempos, shortFirst.fermatas);
  const wholeShort = shortFirst.notes.find(n => n.source.target.track === 1 && n.source.target.bar === 1)!;
  expect(millisecondsAtTick(wholeShort.startTick, effShort) / 1000).toBeCloseTo(2.0, 6);
  expect(millisecondsAtTick(wholeShort.endTick, effShort) / 1000).toBeCloseTo(5.5, 6);

  // 3. Long-first: 330,750 frames = 7.500000 s; track order does not change hold duration
  const longFirst = probeScore([[w], [q, q, q, q]], t120, { offset: 0, length: 1 });
  expect(longFirst.durationMs).toBeCloseTo(7500, 6);
  expect(longFirst.fermatas).toEqual([{ startTick: 3840, endTick: 4800, length: 1 }]);
  const effLong = effectiveTempos(longFirst.tempos, longFirst.fermatas);
  const wholeLong = longFirst.notes.find(n => n.source.target.track === 0 && n.source.target.bar === 1)!;
  expect(millisecondsAtTick(wholeLong.startTick, effLong) / 1000).toBeCloseTo(2.0, 6);
  expect(millisecondsAtTick(wholeLong.endTick, effLong) / 1000).toBeCloseTo(5.5, 6);

  // 4. Interleaved: T0 [DottedQuarter, Eighth, Half], T1 [Quarter, Half, Quarter], fermata @ 960 len 1 -> 297,675 frames = 6.750000 s
  const interleaved = probeScore([[dq, e, h], [q, h, q]], t120, { offset: 960, length: 1 });
  expect(interleaved.durationMs).toBeCloseTo(6750, 6);
  expect(interleaved.fermatas).toEqual([{ startTick: 4800, endTick: 5280, length: 1 }]);
  const effInt = effectiveTempos(interleaved.tempos, interleaved.fermatas);
  expect(millisecondsAtTick(4800, effInt) / 1000).toBeCloseTo(2.5, 6);
  expect(millisecondsAtTick(5280, effInt) / 1000).toBeCloseTo(3.5, 6);
  expect(millisecondsAtTick(6720, effInt) / 1000).toBeCloseTo(4.25, 6);
  expect(millisecondsAtTick(7680, effInt) / 1000).toBeCloseTo(4.75, 6);

  // 5. Tempo control & mid-hold tempo change: 330,750 frames (7.5 s) and 529,200 frames (12.0 s)
  const midTempos = [
    { bar: 0, pos: 0, bpm: 120 },
    { bar: 1, pos: 0.25, bpm: 60 },
    { bar: 2, pos: 0, bpm: 120 },
  ];
  const tempoControl = probeScore([[h, h], [h, h]], midTempos);
  expect(tempoControl.durationMs).toBeCloseTo(7500, 6);
  const tempoHold = probeScore([[h, h], [h, h]], midTempos, { offset: 0, length: 1 });
  expect(tempoHold.durationMs).toBeCloseTo(12000, 6);
  expect(tempoHold.fermatas).toEqual([{ startTick: 3840, endTick: 5760, length: 1 }]);
  const effMid = effectiveTempos(tempoHold.tempos, tempoHold.fermatas);
  expect(millisecondsAtTick(5760, effMid) / 1000).toBeCloseTo(8.0, 6);
  expect(millisecondsAtTick(7680, effMid) / 1000).toBeCloseTo(10.0, 6);
});

it('rejects malformed, overlapping, negative-length, out-of-range, or ms-mismatched fermatas in validatePlaybackPlan', () => {
  const score = music();
  score.masterBars[0].tempoAutomations = [model.Automation.buildTempoAutomation(false, 0, 120, 2)];
  score.masterBars[0].addFermata(0, Object.assign(new model.Fermata(), { type: model.FermataType.Medium, length: 0.5 }));
  score.finish(settings);
  const base = buildPlaybackPlan(score, 1);

  const badCases = [
    () => ({ ...base, fermatas: 'bad' as never }),
    () => ({ ...base, fermatas: [{ startTick: 0, endTick: 960, length: -0.1 }] }),
    () => ({ ...base, fermatas: [{ startTick: 480, endTick: 480, length: 0 }] }),
    () => ({ ...base, fermatas: [{ startTick: 0, endTick: 960, length: 0.5 }, { startTick: 480, endTick: 1440, length: 0.5 }] }),
    () => ({ ...base, fermatas: [{ startTick: 0, endTick: base.durationTick + 1, length: 0.5 }] }),
    () => ({ ...base, durationMs: base.durationMs + 5 }),
    () => ({ ...base, occurrences: base.occurrences.map((o, i) => i === 0 ? { ...o, endMs: o.endMs + 5 } : o) }),
  ];
  for (const make of badCases) {
    expect(() => validatePlaybackPlan(make())).toThrow();
  }
});
