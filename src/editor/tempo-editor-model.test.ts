import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import {
  beatNumberToRatio,
  ratioToBeatNumber,
  readTempoPoints,
  removeExtraTempoPoints,
  removeTempoPoint,
  snapRatioToBeats,
  tapTempoBpm,
  upsertTempoPoint,
} from './tempo-editor-model';
import { buildTempo } from './tempo-unit';

function blankScore(bars = 4, tempo = 120): model.Score {
  const score = new model.Score();
  for (let i = 0; i < bars; i++) {
    score.addMasterBar(new model.MasterBar());
  }
  score.masterBars[0].tempoAutomations = [buildTempo(false, 0, tempo, 2)];
  return score;
}

it('reads existing tempo automations and guarantees an initial bar 0 ratio 0 point', () => {
  const score = blankScore(3, 130);
  score.masterBars[1].tempoAutomations = [buildTempo(true, 0.5, 95, 2)];
  const points = readTempoPoints(score);
  expect(points).toEqual([
    { bar: 0, ratio: 0, bpm: 130, linear: false },
    { bar: 1, ratio: 0.5, bpm: 95, linear: true },
  ]);
});

it('snaps ratios and converts between beat numbers and ratios', () => {
  expect(snapRatioToBeats(0.29, 4)).toBe(0.25);
  expect(snapRatioToBeats(0.95, 4)).toBe(0.75);
  expect(ratioToBeatNumber(0.5, 4)).toBe(3);
  expect(beatNumberToRatio(3, 4)).toBe(0.5);
});

it('upserts, sorts, removes single points, and clears extra automations while preserving bar 0', () => {
  const initial = [{ bar: 0, ratio: 0, bpm: 120, linear: false }];
  const added1 = upsertTempoPoint(initial, { bar: 2, ratio: 0.5, bpm: 150, linear: true });
  expect(added1.index).toBe(1);
  const added2 = upsertTempoPoint(added1.points, { bar: 1, ratio: 0, bpm: 90, linear: false });
  expect(added2.index).toBe(1);
  expect(added2.points.map(p => [p.bar, p.bpm])).toEqual([[0, 120], [1, 90], [2, 150]]);

  // Updating bar 0 ratio 0 replaces in place
  const updated0 = upsertTempoPoint(added2.points, { bar: 0, ratio: 0, bpm: 110, linear: false });
  expect(updated0.index).toBe(0);
  expect(updated0.points[0].bpm).toBe(110);

  // Index 0 cannot be removed; index 1 can
  expect(removeTempoPoint(updated0.points, 0)).toHaveLength(3);
  const removed = removeTempoPoint(updated0.points, 1);
  expect(removed.map(p => p.bar)).toEqual([0, 2]);
  expect(removeExtraTempoPoints(updated0.points)).toEqual([{ bar: 0, ratio: 0, bpm: 110, linear: false }]);
});

it('computes tap tempo from recent taps and ignores stale gaps', () => {
  expect(tapTempoBpm([1000])).toBeNull();
  expect(tapTempoBpm([1000, 1500, 2000])).toBe(120);
  // Stale gap of 5s before recent 600ms intervals (= 100 BPM)
  expect(tapTempoBpm([1000, 6000, 6600, 7200])).toBe(100);
});
