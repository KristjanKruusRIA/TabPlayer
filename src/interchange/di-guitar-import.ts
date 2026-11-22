import { model, Settings } from '@coderline/alphatab';
import type { TranscribedDiNote } from '../audio/di-transcribe';
import type { MessageKey } from '../i18n';
import {
  MEASURE_LIMIT,
  SPAN,
  WHOLE,
  buildTargetBars as buildTargetRhythmBars,
  createRhythmGrid,
  placeChords,
  safeScoreFileName,
  snapHitsToGrid,
  type QuantizedChord,
  type RhythmBar,
  type RhythmQuantization,
  type RhythmStats,
  type RhythmTupletMode,
  type TargetBar,
  type TimedHit,
  writeQuantizedStaffBars,
} from './quantize-bars';

export type DiGuitarQuantization = 8 | 16 | 32 | 64;
export type DiTupletMode = RhythmTupletMode;
export type DiTargetBar = TargetBar;
export type DiFretPosition = 'auto' | 'low' | 'mid' | 'high';

export interface DiTempoPoint {
  tick: number;
  bpm: number;
}

export type DiImportNote =
  | { code: 'unplayable_notes'; count: number }
  | { code: 'shortened_notes'; count: number }
  | { code: 'merged_notes'; count: number }
  | { code: 'appended_measures'; count: number };

export interface DiGuitarImportOptions {
  quantization: DiGuitarQuantization;
  tuplets: DiTupletMode;
  voices: 1 | 2;
  bpm: number;
  timeSignature: DiTargetBar;
  offsetMs: number;
  /** Open string MIDI pitches, highest string first (matching `staff.tuning`). */
  tuning: readonly number[];
  capo: number;
  transpositionPitch?: number;
  maxFret: number;
  position: DiFretPosition;
  detectPalmMutes: boolean;
  palmMuteThreshold: number;
  /** False when targeting a non-stringed track such as piano so string techniques are omitted. */
  allowStringTechniques?: boolean;
  targetBars?: readonly DiTargetBar[];
  targetTempoMap?: readonly DiTempoPoint[];
  trackName?: string;
}

export const defaultDiGuitarImportOptions: DiGuitarImportOptions = {
  quantization: 16,
  tuplets: 'triplets',
  voices: 1,
  bpm: 120,
  timeSignature: { numerator: 4, denominator: 4 },
  offsetMs: 0,
  tuning: [64, 59, 55, 50, 45, 40],
  capo: 0,
  transpositionPitch: 0,
  maxFret: 24,
  position: 'auto',
  detectPalmMutes: true,
  palmMuteThreshold: 0.45,
  allowStringTechniques: true,
};

export interface DiGuitarImportSummary {
  title: string;
  measures: number;
  tempo: number;
  notesCount: number;
  palmMutedCount: number;
  voices: number;
  notes: DiImportNote[];
}

export interface DiGuitarImport {
  score: model.Score;
  summary: DiGuitarImportSummary;
}

export interface FretPlacement {
  /** 1-based alphaTab string number (1 = lowest pitch string, N = highest pitch string). */
  string: number;
  fret: number;
}

const settings = new Settings();
const TICKS_PER_QUARTER = 960;
const UNITS_PER_ALPHA_TICK = SPAN / TICKS_PER_QUARTER; // 0.25 (240 / 960)
const MAX_CANDIDATES_PER_CHORD = 16;
const MAX_BRANCH_EVALUATIONS = 96;

const fail = (message: string): never => {
  throw new Error(message);
};

/**
 * Extracts a sorted tempo map (in alphaTab 960 ticks/quarter) from a score's `masterBars` and initial `score.tempo`.
 */
export function extractScoreTempoMap(score: model.Score): DiTempoPoint[] {
  const initialBpm = Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : 120;
  const raw: DiTempoPoint[] = [];
  let barStart = 0;

  for (const master of score.masterBars) {
    const duration = Math.max(1, master.calculateDuration(false));
    const sorted = [...(master.tempoAutomations ?? [])]
      .filter(
        automation =>
          automation.type === model.AutomationType.Tempo &&
          Number.isFinite(automation.value) &&
          automation.value > 0,
      )
      .sort((a, b) => a.ratioPosition - b.ratioPosition);
    for (const automation of sorted) {
      const ratio = Math.max(0, Math.min(1, automation.ratioPosition));
      raw.push({ tick: barStart + ratio * duration, bpm: automation.value });
    }
    barStart += duration;
  }

  raw.sort((a, b) => a.tick - b.tick);
  const compacted: DiTempoPoint[] = [];
  for (const point of raw) {
    const last = compacted.at(-1);
    if (last && Math.abs(point.tick - last.tick) < 1e-6) {
      last.bpm = point.bpm;
    } else {
      compacted.push({ ...point });
    }
  }
  if (!compacted.length || compacted[0].tick > 1e-6) {
    compacted.unshift({ tick: 0, bpm: initialBpm });
  }
  return compacted;
}

/**
 * Converts a timestamp in seconds to continuous alphaTab ticks (960 ticks/quarter) across a piecewise tempo map.
 */
export function secondsToTick(sec: number, tempoMap: readonly DiTempoPoint[]): number {
  const safeSec = Math.max(0, sec);
  const points =
    tempoMap.length && tempoMap[0].bpm > 0 ? tempoMap : [{ tick: 0, bpm: 120 }];
  let elapsedSec = 0;

  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[i + 1];
    if (!next) {
      return cur.tick + ((safeSec - elapsedSec) * TICKS_PER_QUARTER * cur.bpm) / 60;
    }
    const segTicks = Math.max(0, next.tick - cur.tick);
    const segSec = (segTicks * 60) / (TICKS_PER_QUARTER * cur.bpm);
    if (safeSec <= elapsedSec + segSec + 1e-9) {
      return cur.tick + ((safeSec - elapsedSec) * TICKS_PER_QUARTER * cur.bpm) / 60;
    }
    elapsedSec += segSec;
  }
  const last = points.at(-1)!;
  return last.tick + ((safeSec - elapsedSec) * TICKS_PER_QUARTER * last.bpm) / 60;
}

interface ChordCandidate {
  placements: Map<number, FretPlacement>;
  usedStrings: number[];
  frets: number[];
  anchor: number | null;
  staticCost: number;
  dropped: number;
}

function positionTargetCost(fret: number, position: DiFretPosition): number {
  if (fret === 0) return 0;
  switch (position) {
    case 'auto':
      return fret * 0.10;
    case 'low':
      return Math.max(0, fret - 4) * 0.30;
    case 'mid':
      return Math.abs(fret - 8.5) * 0.30;
    case 'high':
      return Math.abs(fret - 14.5) * 0.30;
  }
}

function scoreChordCandidate(
  items: { key: number; string: number; fret: number }[],
  stringsCount: number,
  position: DiFretPosition,
  dropped: number,
): ChordCandidate {
  const placements = new Map<number, FretPlacement>();
  const usedStrings: number[] = [];
  const frets: number[] = [];
  for (const item of items) {
    placements.set(item.key, { string: item.string, fret: item.fret });
    usedStrings.push(item.string);
    frets.push(item.fret);
  }
  const fretted = frets.filter(fret => fret > 0);
  const anchor = fretted.length
    ? fretted.reduce((sum, fret) => sum + fret, 0) / fretted.length
    : null;
  const openCount = frets.length - fretted.length;

  let cost = dropped * 100.0;

  if (fretted.length >= 2) {
    const span = Math.max(...fretted) - Math.min(...fretted);
    cost += span <= 4 ? span * 0.35 : 3.0 + (span - 4) * 2.5;
  }

  for (const item of items) {
    cost += positionTargetCost(item.fret, position);
    // Open strings slightly prefer lower hand contexts, and very high frets on the lowest wound string carry a small penalty.
    if (item.fret > 0) cost += 0.12;
    if (item.string === 1 && item.fret > 15) cost += (item.fret - 15) * 0.25;
    if (item.string === stringsCount && item.fret === 0 && position === 'high') cost += 0.4;
  }

  // String adjacency & common rock/metal shapes (bar power chords in Drop tunings, 2-fret power chords in Standard).
  if (items.length >= 2) {
    const byString = [...items].sort((a, b) => a.string - b.string);
    let skippedStrings = 0;
    let powerShapeMatches = 0;
    for (let i = 0; i < byString.length - 1; i++) {
      const low = byString[i];
      const high = byString[i + 1];
      const strDiff = high.string - low.string;
      if (strDiff > 1) skippedStrings += strDiff - 1;
      const pitchDiff = high.key - low.key;
      const fretDiff = high.fret - low.fret;
      if (strDiff === 1 && ((pitchDiff === 7 && (fretDiff === 0 || fretDiff === 2)) || (pitchDiff === 5 && fretDiff === 0))) {
        powerShapeMatches++;
      }
    }
    cost += skippedStrings * 2.6;
    cost -= powerShapeMatches * 1.4;
    if (frets.length >= 2 && frets.every(fret => fret === frets[0])) {
      cost -= 1.2; // Barre / Drop-tuning one-finger power chord bonus
    }
    if (openCount > 0 && fretted.length > 0 && Math.max(...fretted) > 6) {
      cost += 2.2; // Avoid wide stretch mixing open string + high fretted notes unless necessary
    }
  }

  return { placements, usedStrings, frets, anchor, staticCost: cost, dropped };
}

function generateChordCandidates(
  chord: QuantizedChord,
  openLowToHigh: readonly number[],
  maxFret: number,
  position: DiFretPosition,
): ChordCandidate[] {
  const strings = openLowToHigh.length;
  const keys = [...new Set(chord.keys)].sort((a, b) => a - b);

  // Per-pitch candidate placements ranked individually so backtracking explores idiomatic shapes first.
  const perPitch = keys.map(key => {
    const opts: { key: number; string: number; fret: number; rank: number }[] = [];
    for (let idx = 0; idx < strings; idx++) {
      const fret = key - openLowToHigh[idx];
      if (fret >= 0 && fret <= maxFret) {
        const rank = positionTargetCost(fret, position) + (fret === 0 ? -0.15 : 0);
        opts.push({ key, string: idx + 1, fret, rank });
      }
    }
    opts.sort((a, b) => a.rank - b.rank || a.string - b.string);
    return { key, opts };
  });

  const candidates: ChordCandidate[] = [];
  const used = new Set<number>();
  const current: { key: number; string: number; fret: number }[] = [];
  let bestCount = 0;
  let branches = 0;

  // First try placing every note; only if zero full voicings exist allow dropping unplayable ones.
  const runSearch = (allowDrops: boolean) => {
    branches = 0;
    const search = (index: number, dropped: number) => {
      if (branches >= MAX_BRANCH_EVALUATIONS && candidates.length >= 4) return;
      if (index === perPitch.length) {
        branches++;
        if (current.length > bestCount) bestCount = current.length;
        candidates.push(scoreChordCandidate(current, strings, position, dropped));
        return;
      }
      const { opts } = perPitch[index];
      let triedString = false;
      for (const opt of opts) {
        if (used.has(opt.string)) continue;
        triedString = true;
        used.add(opt.string);
        current.push({ key: opt.key, string: opt.string, fret: opt.fret });
        search(index + 1, dropped);
        current.pop();
        used.delete(opt.string);
      }
      if (allowDrops && (!triedString || opts.length === 0)) {
        search(index + 1, dropped + 1);
      }
    };
    search(0, 0);
  };

  runSearch(false);
  if (!candidates.length) {
    runSearch(true);
  }
  if (!candidates.length) {
    return [scoreChordCandidate([], strings, position, keys.length)];
  }

  candidates.sort((a, b) => a.staticCost - b.staticCost);
  // Keep only candidates with minimal drops, deduplicated by `(string, fret)` pairs, capped to MAX_CANDIDATES_PER_CHORD.
  const minDrops = candidates.reduce((best, c) => Math.min(best, c.dropped), Infinity);
  const seen = new Set<string>();
  const top: ChordCandidate[] = [];
  for (const cand of candidates) {
    if (cand.dropped > minDrops) continue;
    const sig = [...cand.placements.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, p]) => `${k}:${p.string}@${p.fret}`)
      .join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    top.push(cand);
    if (top.length >= MAX_CANDIDATES_PER_CHORD) break;
  }
  return top;
}

function transitionCost(
  prevChord: QuantizedChord,
  prev: ChordCandidate,
  prevAnchor: number,
  curChord: QuantizedChord,
  cur: ChordCandidate,
): { cost: number; nextAnchor: number } {
  const nextAnchor = cur.anchor ?? prevAnchor;
  const dt = Math.max(15, curChord.start - prevChord.start);
  const speedWeight = dt <= 60 ? 1.55 : dt <= 120 ? 1.15 : 0.80;

  let cost = 0;
  if (cur.anchor !== null) {
    const shift = Math.abs(cur.anchor - prevAnchor);
    cost += shift * 0.48 * speedWeight;
    if (shift > 5) cost += (shift - 5) * 0.55;
  }

  // Reward smooth single-note phrasing on the same string for small melodic steps, or exact same placement on repeats.
  if (prevChord.keys.length === 1 && curChord.keys.length === 1) {
    const prevKey = prevChord.keys[0];
    const curKey = curChord.keys[0];
    const p1 = prev.placements.get(prevKey);
    const p2 = cur.placements.get(curKey);
    if (p1 && p2) {
      const interval = Math.abs(curKey - prevKey);
      if (prevKey === curKey) {
        cost += p1.string === p2.string && p1.fret === p2.fret ? -1.4 : 1.2;
      } else if (interval <= 3) {
        if (p1.string === p2.string && Math.abs(p2.fret - p1.fret) <= 4) {
          cost -= 0.7;
        } else if (p1.string !== p2.string && Math.abs(p1.string - p2.string) > 1) {
          cost += 0.9;
        }
      }
    }
  }

  return { cost, nextAnchor };
}

/**
 * Globally solves guitar/bass string & fret placements across a chronological chord sequence via Viterbi DP.
 *
 * Open strings (`fret === 0`) do not reset the fretted hand anchor so pedal-tone riffs keep their fretted position.
 */
export function solveGuitarFingering(
  chords: readonly QuantizedChord[],
  tuningHighToLow: readonly number[],
  capo = 0,
  maxFret = 24,
  position: DiFretPosition = 'auto',
  transpositionPitch = 0,
): { placements: Map<QuantizedChord, Map<number, FretPlacement>>; unplayableCount: number } {
  const placements = new Map<QuantizedChord, Map<number, FretPlacement>>();
  if (!chords.length) return { placements, unplayableCount: 0 };

  const strings = tuningHighToLow.length;
  if (!Number.isInteger(strings) || strings < 1 || strings > 12) {
    fail('Guitar transcription requires 1 to 12 strings.');
  }
  const openLowToHigh = [...tuningHighToLow]
    .reverse()
    .map(pitch => pitch + capo - transpositionPitch);

  const perChordCandidates = chords.map(chord =>
    generateChordCandidates(chord, openLowToHigh, maxFret, position),
  );

  const initialDefaultAnchor =
    position === 'high' ? 14 : position === 'mid' ? 8 : position === 'low' ? 2 : 4;

  let dp = perChordCandidates[0].map((cand, index) => ({
    index,
    cost: cand.staticCost,
    anchor: cand.anchor ?? initialDefaultAnchor,
    prev: -1,
  }));
  const backpointers: number[][] = [];

  for (let i = 1; i < chords.length; i++) {
    const prevChord = chords[i - 1];
    const curChord = chords[i];
    const prevList = perChordCandidates[i - 1];
    const curList = perChordCandidates[i];
    const nextDp: typeof dp = [];
    const stepPtrs: number[] = [];

    for (let cIdx = 0; cIdx < curList.length; cIdx++) {
      const cur = curList[cIdx];
      let bestPrevIdx = 0;
      let bestCost = Infinity;
      let bestAnchor = cur.anchor ?? dp[0].anchor;

      for (let pIdx = 0; pIdx < dp.length; pIdx++) {
        const trans = transitionCost(prevChord, prevList[pIdx], dp[pIdx].anchor, curChord, cur);
        const total = dp[pIdx].cost + cur.staticCost + trans.cost;
        if (total < bestCost) {
          bestCost = total;
          bestPrevIdx = pIdx;
          bestAnchor = trans.nextAnchor;
        }
      }
      nextDp.push({ index: cIdx, cost: bestCost, anchor: bestAnchor, prev: bestPrevIdx });
      stepPtrs.push(bestPrevIdx);
    }
    backpointers.push(stepPtrs);
    dp = nextDp;
  }

  let chosenIdx = 0;
  for (let i = 1; i < dp.length; i++) {
    if (dp[i].cost < dp[chosenIdx].cost) chosenIdx = i;
  }

  const chosenIndices = new Array<number>(chords.length);
  chosenIndices[chords.length - 1] = chosenIdx;
  for (let step = chords.length - 2; step >= 0; step--) {
    chosenIndices[step] = backpointers[step][chosenIndices[step + 1]];
  }

  let unplayableCount = 0;
  for (let i = 0; i < chords.length; i++) {
    const picked = perChordCandidates[i][chosenIndices[i]];
    placements.set(chords[i], picked.placements);
    unplayableCount += picked.dropped;
  }
  return { placements, unplayableCount };
}

function velocityToDynamic(velocity: number): model.DynamicValue {
  if (velocity <= 28) return model.DynamicValue.PP;
  if (velocity <= 48) return model.DynamicValue.P;
  if (velocity <= 68) return model.DynamicValue.MP;
  if (velocity <= 90) return model.DynamicValue.MF;
  if (velocity <= 110) return model.DynamicValue.F;
  if (velocity <= 122) return model.DynamicValue.FF;
  return model.DynamicValue.FFF;
}

function isLikelyBassTuning(tuningHighToLow: readonly number[]): boolean {
  const lowest = tuningHighToLow.at(-1) ?? 40;
  return lowest <= 31 && tuningHighToLow.length <= 6;
}

/**
 * Converts transcribed DI audio notes into an editable alphaTab guitar/bass tablature score aligned to either a
 * constant BPM & meter (`New score`) or an existing score's tempo map & measure meters (`Add to current score` /
 * `Replace track`).
 */
export function importDiGuitarNotes(
  rawNotes: readonly TranscribedDiNote[],
  options: DiGuitarImportOptions,
  fallbackTitle = 'Imported Guitar DI',
): DiGuitarImport {
  if (!rawNotes.length) fail('No guitar notes were detected with these settings.');
  if (!options.tuning.length || options.tuning.length > 12 || options.tuning.some(p => !Number.isInteger(p) || p < 0 || p > 127)) {
    fail('Choose a valid guitar or bass tuning (1 to 12 strings).');
  }
  if (!Number.isInteger(options.capo) || options.capo < 0 || options.capo > 24) {
    fail('Capo fret must be between 0 and 24.');
  }
  if (!Number.isInteger(options.maxFret) || options.maxFret < 12 || options.maxFret > 36) {
    fail('Maximum fret must be between 12 and 36.');
  }

  const bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? Math.max(20, Math.min(350, options.bpm)) : 120;
  const tempoMap: readonly DiTempoPoint[] = options.targetTempoMap?.length
    ? options.targetTempoMap
    : [{ tick: 0, bpm }];
  const offsetSec = (Number.isFinite(options.offsetMs) ? options.offsetMs : 0) / 1000;

  const timedNotes: {
    startUnit: number;
    endUnit: number;
    pitch: number;
    velocity: number;
    palmMuteScore: number;
  }[] = [];

  for (const item of rawNotes) {
    if (!Number.isFinite(item.startSec) || !Number.isFinite(item.endSec)) continue;
    const adjStart = item.startSec + offsetSec;
    const adjEnd = item.endSec + offsetSec;
    if (adjEnd <= 0.005) continue;
    const startSec = Math.max(0, adjStart);
    const endSec = Math.max(startSec + 0.03, adjEnd);
    const startUnit = secondsToTick(startSec, tempoMap) * UNITS_PER_ALPHA_TICK;
    const endUnit = Math.max(startUnit + 1, secondsToTick(endSec, tempoMap) * UNITS_PER_ALPHA_TICK);
    timedNotes.push({
      startUnit,
      endUnit,
      pitch: Math.max(0, Math.min(127, Math.round(item.pitch))),
      velocity: Math.max(1, Math.min(127, Math.round(item.velocity))),
      palmMuteScore: item.palmMuteScore,
    });
  }

  if (!timedNotes.length) {
    fail('No guitar notes remain in range with this offset.');
  }

  const notes: DiImportNote[] = [];
  const rawHits: TimedHit[] = timedNotes.map(n => ({
    key: n.pitch,
    start: n.startUnit,
    end: n.endUnit,
  }));
  const maxNoteStart = rawHits.reduce((best, h) => Math.max(best, h.start), 0);

  let bars: RhythmBar[];
  if (options.targetBars?.length) {
    const built = buildTargetRhythmBars(
      options.targetBars,
      maxNoteStart,
      options.quantization,
      `DI import is limited to ${MEASURE_LIMIT} measures.`,
    );
    bars = built.bars;
    if (built.appended) notes.push({ code: 'appended_measures', count: built.appended });
  } else {
    const num = options.timeSignature.numerator;
    const den = options.timeSignature.denominator;
    const barLength = (num * WHOLE) / den;
    const maxEnd = rawHits.reduce((best, h) => Math.max(best, h.end), 0);
    const overhang = Math.max(WHOLE / options.quantization / 2, WHOLE / 64);
    const count = Math.max(1, Math.min(MEASURE_LIMIT, Math.ceil((Math.max(maxNoteStart + 1, maxEnd - overhang)) / barLength)));
    bars = Array.from({ length: count }, (_, idx) => ({
      start: idx * barLength,
      length: barLength,
      numerator: num,
      denominator: den,
    }));
  }

  const grid = createRhythmGrid(bars, rawHits, options.quantization, options.tuplets);
  const hits = snapHitsToGrid(grid, rawHits, false);

  // Align per-note attributes (velocity & palm-mute score) onto quantized `(pitch, start)` pairs.
  const totalUnits = bars.at(-1)!.start + bars.at(-1)!.length;
  const noteMeta = new Map<string, { velocity: number; palmMuteScore: number }>();
  for (const item of timedNotes) {
    // Recompute the quantized start unit consistently via `snapHitsToGrid` logic by matching `snap` in grid:
    const snappedList = snapHitsToGrid(grid, [{ key: item.pitch, start: item.startUnit, end: item.endUnit }], false);
    const snapped = snappedList[0];
    if (!snapped || snapped.start >= totalUnits) continue;
    const id = `${snapped.key}/${snapped.start}`;
    const prev = noteMeta.get(id);
    if (!prev) {
      noteMeta.set(id, { velocity: item.velocity, palmMuteScore: item.palmMuteScore });
    } else {
      prev.velocity = Math.max(prev.velocity, item.velocity);
      prev.palmMuteScore = Math.max(prev.palmMuteScore, item.palmMuteScore);
    }
  }

  const stats: RhythmStats = { shortened: 0, merged: 0 };
  const chords = placeChords(hits, options.voices, stats);
  const voicesUsed = chords.reduce((most, chord) => Math.max(most, chord.voice), 0) + 1;

  // Enforce physical polyphony limit (<= tuning.length) by keeping the widest/highest+root pitches when crowded.
  let droppedPoly = 0;
  for (const chord of chords) {
    if (chord.keys.length > options.tuning.length) {
      const sorted = [...chord.keys].sort((a, b) => a - b);
      droppedPoly += sorted.length - options.tuning.length;
      chord.keys = sorted.slice(0, options.tuning.length);
    }
  }

  const solved = solveGuitarFingering(
    chords,
    options.tuning,
    options.capo,
    options.maxFret,
    options.position,
    options.transpositionPitch ?? 0,
  );
  const unplayableTotal = droppedPoly + solved.unplayableCount;
  if (unplayableTotal) notes.push({ code: 'unplayable_notes', count: unplayableTotal });
  if (stats.shortened) notes.push({ code: 'shortened_notes', count: stats.shortened });
  if (stats.merged) notes.push({ code: 'merged_notes', count: stats.merged });

  const score = new model.Score();
  score.title = fallbackTitle.trim() || 'Imported Guitar DI';
  score.artist = '';
  const initialTempo = Math.round(tempoMap[0]?.bpm ?? bpm);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const master = new model.MasterBar();
    master.timeSignatureNumerator = bar.numerator;
    master.timeSignatureDenominator = bar.denominator;
    if (i === 0) {
      master.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, initialTempo, 2));
    }
    score.addMasterBar(master);
  }

  const isBass = isLikelyBassTuning(options.tuning);
  const track = new model.Track();
  const trackLabel = options.trackName?.trim() || (isBass ? 'Bass DI' : 'Guitar DI');
  track.name = trackLabel;
  track.shortName = trackLabel.slice(0, 12);
  track.playbackInfo.program = isBass ? 33 : 29;
  track.playbackInfo.primaryChannel = 0;
  track.playbackInfo.secondaryChannel = 1;

  const staff = new model.Staff();
  staff.isPercussion = false;
  staff.showStandardNotation = true;
  staff.showTablature = true;
  staff.stringTuning.tunings = [...options.tuning];
  staff.capo = options.capo;
  staff.transpositionPitch = options.transpositionPitch ?? 0;
  track.addStaff(staff);
  score.addTrack(track);

  const allowPalmMute = options.detectPalmMutes && options.allowStringTechniques !== false;
  let notesCount = 0;
  let palmMutedCount = 0;
  const clef = isBass ? model.Clef.F4 : model.Clef.G2;

  writeQuantizedStaffBars(staff, bars, grid, chords, voicesUsed, options.quantization, clef, (piece, beat, partIndex) => {
    const chord = piece.chord!;
    const chordPlacements = solved.placements.get(chord);
    for (const keyValue of [...chord.keys].sort((a, b) => a - b)) {
      const placement = chordPlacements?.get(keyValue);
      if (!placement) continue;
      const meta = noteMeta.get(`${keyValue}/${chord.start}`);
      const alphaNote = new model.Note();
      alphaNote.string = placement.string;
      alphaNote.fret = placement.fret;
      alphaNote.dynamics = velocityToDynamic(meta?.velocity ?? 90);
      if (allowPalmMute && meta && meta.palmMuteScore >= options.palmMuteThreshold) {
        alphaNote.isPalmMute = true;
      }
      if (piece.tied || partIndex > 0) {
        alphaNote.isTieDestination = true;
      } else {
        notesCount++;
        if (alphaNote.isPalmMute) palmMutedCount++;
      }
      beat.addNote(alphaNote);
    }
  });

  if (notesCount === 0) {
    fail('No playable notes fit the chosen tuning and fret range.');
  }

  score.finish(settings);
  return {
    score,
    summary: {
      title: score.title,
      measures: bars.length,
      tempo: initialTempo,
      notesCount,
      palmMutedCount,
      voices: voicesUsed,
      notes,
    },
  };
}

export function formatDiImportNote(
  note: DiImportNote,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  switch (note.code) {
    case 'unplayable_notes':
      return t(
        note.count === 1 ? 'di_import.note_unplayable_one' : 'di_import.note_unplayable_other',
        { count: note.count },
      );
    case 'shortened_notes':
      return t(
        note.count === 1
          ? 'midi_import.note_shortened_notes_one'
          : 'midi_import.note_shortened_notes_other',
        { count: note.count },
      );
    case 'merged_notes':
      return t(
        note.count === 1
          ? 'midi_import.note_merged_notes_one'
          : 'midi_import.note_merged_notes_other',
        { count: note.count },
      );
    case 'appended_measures':
      return t(
        note.count === 1
          ? 'midi_import.note_appended_measures_one'
          : 'midi_import.note_appended_measures_other',
        { count: note.count },
      );
  }
}

export function diImportFileName(source: string): string {
  return safeScoreFileName(source, 'Imported Guitar DI');
}
