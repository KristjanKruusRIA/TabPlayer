import type { model } from '@coderline/alphatab';
import type { RatioTempoPoint } from './tempo-types';
import { displayedBpm, quarterUnit, tempoUnitOf, unitQuarters, type TempoUnit } from './tempo-unit';

export function pointUnit(point: Pick<RatioTempoPoint, 'unit'>): TempoUnit {
  return (point.unit ?? quarterUnit) as TempoUnit;
}

export function soundingBpm(point: Pick<RatioTempoPoint, 'bpm' | 'unit'>): number {
  return point.bpm * unitQuarters[pointUnit(point)];
}

export function normalizeTempoPoint(point: RatioTempoPoint): RatioTempoPoint {
  const unit = pointUnit(point);
  const ratio = Math.min(0.9999, Math.max(0, Math.round(point.ratio * 10000) / 10000));
  const normalized: RatioTempoPoint = {
    bar: Math.max(0, Math.trunc(point.bar)),
    ratio: point.bar === 0 && ratio < 1e-4 ? 0 : ratio,
    bpm: Math.max(1, Math.min(999, Math.round(point.bpm * 1000) / 1000)),
    linear: Boolean(point.linear),
  };
  if (unit !== quarterUnit) normalized.unit = unit;
  return normalized;
}

export function readTempoPoints(score: model.Score): RatioTempoPoint[] {
  const result: RatioTempoPoint[] = [];
  score.masterBars.forEach((master, bar) => {
    const sorted = [...master.tempoAutomations].sort((a, b) => a.ratioPosition - b.ratioPosition);
    for (const automation of sorted) {
      const unit = tempoUnitOf(automation);
      const ratio = bar === 0 && result.length === 0 && automation.ratioPosition < 1e-4
        ? 0
        : Math.min(0.9999, Math.max(0, Math.round(automation.ratioPosition * 10000) / 10000));
      const candidate: RatioTempoPoint = {
        bar,
        ratio,
        bpm: Math.max(1, displayedBpm(automation)),
        linear: Boolean(automation.isLinear),
        ...(unit !== quarterUnit ? { unit } : {}),
      };
      const prev = result.at(-1);
      if (prev && prev.bar === candidate.bar && Math.abs(prev.ratio - candidate.ratio) < 1e-4) {
        result[result.length - 1] = candidate;
      } else {
        result.push(candidate);
      }
    }
  });
  const first = result[0];
  if (!first || first.bar !== 0 || first.ratio !== 0) {
    result.unshift({ bar: 0, ratio: 0, bpm: score.tempo > 0 ? score.tempo : 120, linear: false });
  }
  return result;
}

export function tempoPointsEqual(a: readonly RatioTempoPoint[], b: readonly RatioTempoPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((point, index) => {
    const other = b[index];
    return (
      point.bar === other.bar &&
      Math.abs(point.ratio - other.ratio) < 1e-6 &&
      Math.abs(point.bpm - other.bpm) < 1e-6 &&
      point.linear === other.linear &&
      pointUnit(point) === pointUnit(other)
    );
  });
}

export function snapRatioToBeats(ratio: number, numerator: number): number {
  const beats = Math.max(1, Math.round(numerator));
  const step = Math.min(beats - 1, Math.max(0, Math.round(ratio * beats)));
  return Math.round((step / beats) * 10000) / 10000;
}

export function ratioToBeatNumber(ratio: number, numerator: number): number {
  const beats = Math.max(1, Math.round(numerator));
  return Math.min(beats, Math.max(1, Math.round(ratio * beats) + 1));
}

export function beatNumberToRatio(beat: number, numerator: number): number {
  const beats = Math.max(1, Math.round(numerator));
  const clamped = Math.min(beats, Math.max(1, Math.round(beat)));
  return Math.round(((clamped - 1) / beats) * 10000) / 10000;
}

export function upsertTempoPoint(
  points: readonly RatioTempoPoint[],
  next: RatioTempoPoint,
): { points: RatioTempoPoint[]; index: number } {
  const normalized = normalizeTempoPoint(next);
  const copy = points.map(p => ({ ...p }));
  const existing = copy.findIndex(p => p.bar === normalized.bar && Math.abs(p.ratio - normalized.ratio) < 1e-4);
  if (existing >= 0) {
    copy[existing] = normalized;
  } else {
    copy.push(normalized);
  }
  copy.sort((a, b) => a.bar - b.bar || a.ratio - b.ratio);
  const index = copy.findIndex(p => p.bar === normalized.bar && Math.abs(p.ratio - normalized.ratio) < 1e-4);
  return { points: copy, index: Math.max(0, index) };
}

export function removeTempoPoint(points: readonly RatioTempoPoint[], index: number): RatioTempoPoint[] {
  if (index <= 0 || index >= points.length) return points.map(p => ({ ...p }));
  return points.filter((_, i) => i !== index).map(p => ({ ...p }));
}

export function removeExtraTempoPoints(points: readonly RatioTempoPoint[]): RatioTempoPoint[] {
  return points.length ? [{ ...points[0] }] : [{ bar: 0, ratio: 0, bpm: 120, linear: false }];
}

export function tapTempoBpm(timestamps: readonly number[]): number | null {
  if (timestamps.length < 2) return null;
  const intervals: number[] = [];
  for (let i = timestamps.length - 1; i > 0 && intervals.length < 6; i--) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (delta <= 0 || delta > 2500) break;
    intervals.push(delta);
  }
  if (!intervals.length) return null;
  const avgMs = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  const bpm = Math.max(1, Math.min(999, 60000 / avgMs));
  return Math.round(bpm * 10) / 10;
}
