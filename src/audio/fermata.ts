import { model } from '@coderline/alphatab';
import { playbackBar } from './golpe';
import type { PlanFermata, PlanTempo } from './types';

// Empirical model from Guitar Pro 8.0.0 build 18 WAV exports (120, 60 and 90 BPM).
export const FERMATA_BASE_FACTOR = 0.66;
export const FERMATA_LENGTH_SLOPE = 0.41;
export const FERMATA_MIN_BPM = 1;

/** Effective BPM during a fermata with authored tempo `tempoBpm` and stored `Length`. */
export function fermataEffectiveBpm(tempoBpm: number, storedLength: number): number {
  const floor = Math.min(FERMATA_MIN_BPM, tempoBpm);
  return Math.max(floor, tempoBpm * (FERMATA_BASE_FACTOR - FERMATA_LENGTH_SLOPE * storedLength));
}

/**
 * Resolves every master-bar fermata across performed occurrences into sorted, disjoint
 * `[startTick, endTick)` hold intervals using the marked beat's written duration.
 */
export function planFermatas(
  score: model.Score,
  occurrences: readonly { bar: number; startTick: number; endTick: number }[],
  durationTick: number,
): PlanFermata[] {
  const result: PlanFermata[] = [];
  for (let i = 0; i < occurrences.length; i++) {
    const occurrence = occurrences[i];
    const master = score.masterBars[occurrence.bar];
    if (!master?.fermata?.size) continue;
    const entries = [...master.fermata.entries()]
      .filter(([offset, fermata]) => Number.isFinite(offset) && offset >= 0 && Number.isFinite(fermata.length) && fermata.length >= 0)
      .sort(([a], [b]) => a - b);
    if (!entries.length) continue;

    const beats: { start: number; end: number }[] = [];
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        const bar = staff.bars[occurrence.bar];
        if (!bar) continue;
        for (const voice of playbackBar(bar).voices) {
          for (const beat of voice.beats) {
            if (beat.isEmpty || beat.graceType !== model.GraceType.None || beat.playbackDuration <= 0) continue;
            beats.push({ start: beat.playbackStart, end: beat.playbackStart + beat.playbackDuration });
          }
        }
      }
    }

    const barLimit = Math.min(durationTick, occurrences[i + 1]?.startTick ?? durationTick);
    for (let k = 0; k < entries.length; k++) {
      const [offset, fermata] = entries[k];
      const startTick = occurrence.startTick + offset;
      if (startTick >= barLimit) continue;

      const nextBoundary = beats.reduce((best, b) => {
        if (b.start > offset && b.start < best) best = b.start;
        if (b.end > offset && b.end < best) best = b.end;
        return best;
      }, occurrence.endTick - occurrence.startTick);
      const nextStart = k + 1 < entries.length ? occurrence.startTick + entries[k + 1][0] : Infinity;
      const endTick = Math.min(occurrence.startTick + nextBoundary, barLimit, nextStart);
      if (endTick > startTick) {
        result.push({ startTick, endTick, length: fermata.length });
      }
    }
  }
  return result;
}

/** Combines authored tempos with fermata holds into a piecewise-constant effective tempo map. */
export function effectiveTempos(
  tempos: readonly PlanTempo[],
  fermatas: readonly PlanFermata[] | undefined,
): PlanTempo[] {
  if (!fermatas?.length) return [...tempos];
  const ticks = new Set<number>();
  for (const t of tempos) ticks.add(t.tick);
  for (const f of fermatas) {
    ticks.add(f.startTick);
    ticks.add(f.endTick);
  }
  const sorted = [...ticks].sort((a, b) => a - b);
  const out: PlanTempo[] = [];
  let tempoIndex = 0;
  let fermataIndex = 0;
  for (const tick of sorted) {
    while (tempoIndex + 1 < tempos.length && tempos[tempoIndex + 1].tick <= tick) tempoIndex++;
    while (fermataIndex < fermatas.length && fermatas[fermataIndex].endTick <= tick) fermataIndex++;
    const authored = tempos[tempoIndex].bpm;
    const active = fermataIndex < fermatas.length && fermatas[fermataIndex].startTick <= tick
      ? fermatas[fermataIndex]
      : undefined;
    const bpm = active ? fermataEffectiveBpm(authored, active.length) : authored;
    if (!out.length || out[out.length - 1].bpm !== bpm) {
      out.push({ tick, bpm });
    }
  }
  return out;
}

/** Integrates milliseconds from tick 0 to `tick` over a piecewise-constant `tempos` map. */
export function millisecondsAtTick(tick: number, tempos: readonly PlanTempo[]): number {
  let seconds = 0, previous = 0, bpm = tempos[0].bpm;
  for (const tempo of tempos) {
    if (tempo.tick > tick) break;
    seconds += (tempo.tick - previous) * 60 / (960 * bpm);
    previous = tempo.tick;
    bpm = tempo.bpm;
  }
  return (seconds + (tick - previous) * 60 / (960 * bpm)) * 1000;
}
