import { model } from '@coderline/alphatab';

/** Smallest note value a note may start or stop on, as the denominator of a whole note. */
export type RhythmQuantization = 4 | 8 | 16 | 32 | 64;
export type RhythmTupletMode = 'none' | 'triplets' | 'triplets-quintuplets';

export interface TargetBar {
  numerator: number;
  denominator: number;
}
export interface RhythmBar {
  start: number;
  length: number;
  numerator: number;
  denominator: number;
}
export interface RhythmLattice {
  step: number;
  n: number;
  m: number;
}
export interface TimedHit {
  key: number;
  start: number;
  end: number;
}
export interface QuantizedChord {
  start: number;
  end: number;
  keys: number[];
  voice: number;
}
export interface RhythmStats {
  shortened: number;
  merged: number;
}
export interface RhythmGrid {
  bars: RhythmBar[];
  straight: RhythmLattice;
  lattices: Map<number, RhythmLattice>;
}
export interface RhythmPiece {
  start: number;
  end: number;
  chord: QuantizedChord | null;
  tied: boolean;
}

export const MEASURE_LIMIT = 3000;
export const NAME_BYTES = 190;
/** Units per whole note: divisible by every note value to a 64th and by 3 and 5, so tuplets stay whole numbers. */
export const WHOLE = 960;
export const SPAN = WHOLE / 4;

const TARGET_DENOMINATORS = new Set([1, 2, 4, 8, 16, 32, 64]);
const STRAIGHT_VALUES: readonly [number, number, number][] = [
  [1440, 1, 1],
  [960, 1, 0],
  [720, 2, 1],
  [480, 2, 0],
  [360, 4, 1],
  [240, 4, 0],
  [180, 8, 1],
  [120, 8, 0],
  [90, 16, 1],
  [60, 16, 0],
  [45, 32, 1],
  [30, 32, 0],
  [15, 64, 0],
];
const SLOT_COUNTS = [24, 16, 12, 8, 6, 4, 3, 2, 1] as const;

const fail = (message: string): never => {
  throw new Error(message);
};

export const tuplet = (step: number, n: number, m: number): RhythmLattice => ({ step, n, m });

export const barIndex = (bars: readonly RhythmBar[], unit: number): number => {
  let low = 0;
  let high = bars.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (bars[middle].start <= unit) low = middle;
    else high = middle - 1;
  }
  return low;
};

/** Builds rhythm bars matching `targetBars`, appending final-meter bars only when notes extend meaningfully past the end. */
export function buildTargetBars(
  targetBars: readonly TargetBar[],
  maxNoteStart: number,
  quantization: RhythmQuantization,
  limitMessage: string,
): { bars: RhythmBar[]; appended: number } {
  if (!targetBars.length) fail('Target score has no measures.');
  if (targetBars.length > MEASURE_LIMIT) fail(limitMessage);
  const bars: RhythmBar[] = [];
  let start = 0;
  for (const meter of targetBars) {
    if (
      !Number.isInteger(meter.numerator) ||
      meter.numerator < 1 ||
      meter.numerator > 64 ||
      !TARGET_DENOMINATORS.has(meter.denominator)
    ) {
      fail('Unsupported target measure time signature.');
    }
    const length = (meter.numerator * WHOLE) / meter.denominator;
    bars.push({ start, length, numerator: meter.numerator, denominator: meter.denominator });
    start += length;
  }
  const existingEnd = start;
  const overhang = Math.max(WHOLE / quantization / 2, WHOLE / 64);
  let appended = 0;
  if (maxNoteStart >= existingEnd + overhang) {
    const last = targetBars.at(-1)!;
    const extraLength = (last.numerator * WHOLE) / last.denominator;
    while (start <= maxNoteStart) {
      if (bars.length >= MEASURE_LIMIT) fail(limitMessage);
      bars.push({ start, length: extraLength, numerator: last.numerator, denominator: last.denominator });
      start += extraLength;
      appended++;
    }
  }
  return { bars, appended };
}

/** Chooses, for each quarter note of a track, whether its onsets fit the straight grid or a tuplet grid better. */
export function chooseLattices(
  grid: RhythmGrid,
  hits: readonly TimedHit[],
  quantization: RhythmQuantization,
  tuplets: RhythmTupletMode,
): void {
  const step = WHOLE / quantization;
  const candidates = [grid.straight];
  if (tuplets !== 'none' && quantization >= 8) candidates.push(tuplet((step * 2) / 3, 3, 2));
  if (tuplets === 'triplets-quintuplets' && quantization >= 16) candidates.push(tuplet((step * 4) / 5, 5, 4));
  if (candidates.length === 1) return;
  const total = grid.bars.at(-1)!.start + grid.bars.at(-1)!.length;
  const votes = new Map<number, number[]>();
  const vote = (unit: number) => {
    if (unit < 0 || unit >= total) return;
    const bar = grid.bars[barIndex(grid.bars, unit)];
    const span = Math.floor((unit - bar.start) / SPAN);
    const at = bar.start + span * SPAN;
    if ((span + 1) * SPAN > bar.length) return;
    const list = votes.get(at);
    if (list) list.push(unit - at);
    else votes.set(at, [unit - at]);
  };
  for (const hit of hits) {
    vote(hit.start);
    vote(hit.end);
  }
  for (const [at, offsets] of votes) {
    const cost = (lattice: RhythmLattice) =>
      offsets.reduce((sum, offset) => sum + Math.abs(offset - Math.round(offset / lattice.step) * lattice.step), 0) +
      (lattice.n === 0 ? 0 : (lattice.n === 3 ? 0.06 : 0.1) * step * (offsets.length + 1));
    let best = grid.straight;
    let bestCost = cost(best);
    for (const lattice of candidates.slice(1)) {
      const value = cost(lattice);
      if (value < bestCost) {
        best = lattice;
        bestCost = value;
      }
    }
    if (best !== grid.straight) grid.lattices.set(at, best);
  }
}

export function createRhythmGrid(
  bars: RhythmBar[],
  hits: readonly TimedHit[],
  quantization: RhythmQuantization,
  tuplets: RhythmTupletMode,
): RhythmGrid {
  const grid: RhythmGrid = { bars, straight: tuplet(WHOLE / quantization, 0, 0), lattices: new Map() };
  chooseLattices(grid, hits, quantization, tuplets);
  return grid;
}

/** Start of the quarter-note span holding a unit, counted from its bar line. */
export function spanStart(bars: readonly RhythmBar[], unit: number): number {
  const clamped = Math.max(0, unit);
  const bar = bars[barIndex(bars, clamped)];
  return bar.start + Math.floor((clamped - bar.start) / SPAN) * SPAN;
}

/** Snaps to the nearest grid point, never past the bar line that ends the unit's bar. */
export function snap(grid: RhythmGrid, unit: number): number {
  const clamped = Math.max(0, unit);
  const at = spanStart(grid.bars, clamped);
  const lattice = grid.lattices.get(at) ?? grid.straight;
  const bar = grid.bars[barIndex(grid.bars, clamped)];
  return Math.min(at + Math.round((clamped - at) / lattice.step) * lattice.step, bar.start + bar.length);
}

export function snapDown(grid: RhythmGrid, unit: number): number {
  const clamped = Math.max(0, unit);
  const at = spanStart(grid.bars, clamped);
  const lattice = grid.lattices.get(at) ?? grid.straight;
  return at + Math.floor((clamped - at) / lattice.step) * lattice.step;
}

export function snapHitsToGrid(grid: RhythmGrid, rawHits: readonly TimedHit[], percussion: boolean): TimedHit[] {
  const total = grid.bars.at(-1)!.start + grid.bars.at(-1)!.length;
  const quantum = grid.straight.step;
  let hits: TimedHit[] = rawHits
    .map(hit => {
      let start = snap(grid, hit.start);
      let end = snap(grid, hit.end);
      // A note starting so near the end that it rounds onto the last bar line starts on the last grid point before it.
      if (start >= total) start = snapDown(grid, total - 1);
      if (end <= start) {
        const bar = grid.bars[barIndex(grid.bars, start)];
        end = Math.min(start + (grid.lattices.get(spanStart(grid.bars, start))?.step ?? quantum), bar.start + bar.length);
      }
      return { key: hit.key, start, end: Math.min(end, total) };
    })
    .filter(hit => hit.end > hit.start);
  if (percussion) {
    // A drum hit has no useful length: it lasts until the next hit, up to the end of its quarter note.
    const onsets = [...new Set(hits.map(hit => hit.start))].sort((a, b) => a - b);
    const after = new Map(onsets.map((onset, index) => [onset, onsets[index + 1]]));
    hits = hits.map(hit => {
      const bar = grid.bars[barIndex(grid.bars, hit.start)];
      return {
        key: hit.key,
        start: hit.start,
        end: Math.min(spanStart(grid.bars, hit.start) + SPAN, bar.start + bar.length, after.get(hit.start) ?? total, total),
      };
    });
  }
  const merged = new Map<string, TimedHit>();
  for (const hit of hits) {
    const id = `${hit.key}/${hit.start}`;
    const other = merged.get(id);
    if (!other || hit.end > other.end) merged.set(id, hit);
  }
  return [...merged.values()];
}

/** Sorted by start; notes that start together and last as long join one chord, the rest go to free voices. */
export function placeChords(hits: readonly TimedHit[], limit: number, stats: RhythmStats): QuantizedChord[] {
  const lanes: QuantizedChord[][] = Array.from({ length: limit }, () => []);
  const ordered = [...hits].sort((a, b) => a.start - b.start || b.key - a.key || a.end - b.end);
  for (const hit of ordered) {
    const lastOf = (voice: number) => lanes[voice].at(-1);
    let target = lanes.findIndex(lane => {
      const last = lane.at(-1);
      return !!last && last.start === hit.start && last.end === hit.end && !last.keys.includes(hit.key);
    });
    if (target < 0) target = lanes.findIndex(lane => !lane.length || lane.at(-1)!.end <= hit.start);
    if (target >= 0) {
      const last = lastOf(target);
      if (last && last.start === hit.start && last.end === hit.end) last.keys.push(hit.key);
      else lanes[target].push({ start: hit.start, end: hit.end, keys: [hit.key], voice: target });
      continue;
    }
    // Every voice is busy. A note starting with a chord joins it; otherwise the voice that frees soonest is cut short.
    const sameStart = lanes.findIndex(lane => lane.at(-1)!.start === hit.start);
    if (sameStart >= 0) {
      const chord = lastOf(sameStart)!;
      if (!chord.keys.includes(hit.key)) {
        chord.keys.push(hit.key);
        if (chord.end !== hit.end) stats.merged++;
      }
      continue;
    }
    let victim = 0;
    for (let voice = 1; voice < lanes.length; voice++) {
      if (lastOf(voice)!.end < lastOf(victim)!.end) victim = voice;
    }
    lastOf(victim)!.end = hit.start;
    stats.shortened++;
    lanes[victim].push({ start: hit.start, end: hit.end, keys: [hit.key], voice: victim });
  }
  return lanes.flat().sort((a, b) => a.start - b.start || a.voice - b.voice);
}

export function straightParts(length: number): { den: number; dots: number }[] {
  const parts: { den: number; dots: number }[] = [];
  let remaining = length;
  while (remaining > 0) {
    const value = STRAIGHT_VALUES.find(entry => entry[0] <= remaining);
    if (!value) throw new Error('A rhythm in this file does not fit a 64th-note grid.');
    parts.push({ den: value[1], dots: value[2] });
    remaining -= value[0];
  }
  return parts;
}

export function tupletParts(slots: number, quantization: number): { den: number; dots: number }[] {
  const parts: { den: number; dots: number }[] = [];
  let remaining = slots;
  while (remaining > 0) {
    const count = SLOT_COUNTS.find(entry => entry <= remaining)!;
    const dotted = count % 3 === 0;
    const base = dotted ? (count / 3) * 2 : count;
    parts.push({ den: quantization / base, dots: dotted ? 1 : 0 });
    remaining -= count;
  }
  return parts;
}

export function splitAt(segments: readonly RhythmPiece[], cuts: readonly number[]): RhythmPiece[] {
  const result: RhythmPiece[] = [];
  for (const segment of segments) {
    let start = segment.start;
    let tied = segment.tied;
    let low = 0;
    let high = cuts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cuts[middle] <= start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < cuts.length && cuts[index] < segment.end; index++) {
      result.push({ start, end: cuts[index], chord: segment.chord, tied });
      start = cuts[index];
      tied = !!segment.chord;
    }
    result.push({ start, end: segment.end, chord: segment.chord, tied });
  }
  return result;
}

const emptyVoice = () => {
  const voice = new model.Voice();
  const beat = new model.Beat();
  beat.isEmpty = true;
  voice.addBeat(beat);
  return voice;
};

/** Populates `staff` bars across `bars` for quantized `chords`, adding notes through `populateBeat`. */
export function writeQuantizedStaffBars(
  staff: model.Staff,
  bars: readonly RhythmBar[],
  grid: RhythmGrid,
  chords: readonly QuantizedChord[],
  voicesUsed: number,
  quantization: RhythmQuantization,
  clef: model.Clef,
  populateBeat: (piece: RhythmPiece, beat: model.Beat, partIndex: number) => void,
): void {
  const total = bars.at(-1)!.start + bars.at(-1)!.length;
  const quantum = grid.straight.step;
  const edges = new Map<number, boolean>();
  for (const chord of chords) {
    for (const point of [chord.start, chord.end]) {
      const at = spanStart(bars, point);
      if (grid.lattices.has(at) && point > at && point < at + SPAN && (point - at) % quantum !== 0) edges.set(at, true);
    }
  }
  const notated = [...edges.keys()].sort((a, b) => a - b);
  const cuts = [...bars.map(bar => bar.start), ...notated.flatMap(at => [at, at + SPAN])];
  const cutPoints = [...new Set(cuts)].sort((a, b) => a - b);

  const timelines: RhythmPiece[][] = Array.from({ length: voicesUsed }, (_, voice) => {
    const pieces: RhythmPiece[] = [];
    let cursor = 0;
    for (const chord of chords.filter(item => item.voice === voice)) {
      if (chord.start > cursor) pieces.push({ start: cursor, end: chord.start, chord: null, tied: false });
      pieces.push({ start: chord.start, end: chord.end, chord, tied: false });
      cursor = chord.end;
    }
    if (cursor < total) pieces.push({ start: cursor, end: total, chord: null, tied: false });
    return splitAt(pieces, cutPoints);
  });

  const pointers = timelines.map(() => 0);
  for (const bar of bars) {
    const barEnd = bar.start + bar.length;
    const staffBar = new model.Bar();
    staffBar.clef = clef;
    for (const [voiceIndex, timeline] of timelines.entries()) {
      const voice = new model.Voice();
      const beats: model.Beat[] = [];
      let sounded = false;
      while (pointers[voiceIndex] < timeline.length && timeline[pointers[voiceIndex]].start < barEnd) {
        const piece = timeline[pointers[voiceIndex]++];
        const at = spanStart(bars, piece.start);
        const lattice = edges.has(at) && piece.end <= at + SPAN ? grid.lattices.get(at)! : null;
        const slots = lattice ? (piece.end - piece.start) / lattice.step : 0;
        if (lattice && !Number.isInteger(slots)) fail('A rhythm in this file could not be placed on the tuplet grid.');
        const parts = lattice ? tupletParts(slots, quantization) : straightParts(piece.end - piece.start);
        for (const [partIndex, part] of parts.entries()) {
          const beat = new model.Beat();
          beat.duration = part.den as model.Duration;
          beat.dots = part.dots;
          if (lattice) {
            beat.tupletNumerator = lattice.n;
            beat.tupletDenominator = lattice.m;
          }
          if (piece.chord) {
            sounded = true;
            populateBeat(piece, beat, partIndex);
          }
          beats.push(beat);
        }
      }
      if (voiceIndex > 0 && !sounded) {
        staffBar.addVoice(emptyVoice());
        continue;
      }
      for (const beat of beats) voice.addBeat(beat);
      staffBar.addVoice(voice);
    }
    staff.addBar(staffBar);
  }
}

/** Builds a safe `.gp` score file name short enough for the native file name byte limit. */
export function safeScoreFileName(source: string, fallback: string): string {
  let base = source.replace(/\.[^.\\/]*$/, '').replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  const encoder = new TextEncoder();
  while (encoder.encode(base).length > NAME_BYTES) base = [...base].slice(0, -1).join('').trimEnd();
  return `${base || fallback}.gp`;
}
