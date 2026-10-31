// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { unzipSync, zipSync } from 'fflate';
import { buildScore, exportGp, previewEdit } from '../engine';
import { blankProject, type EditCommand, type Project } from '../project';
import { buildPlaybackPlan } from '../audio/plan';
import { exportMidi } from '../export/midi';
import { loadInterchangeScore } from '../interchange/gp';
import { validateParityCommand } from '../parity-commands';
import { MeasurePanel } from './MeasurePanel';
import { readMeasureSettings } from './measure-settings';
import { displayedBpm, tempoUnitOf } from './tempo-unit';
import { selectScore } from '../export/selection';
import { scoreTemposFromSync } from '../audio/tempo-conversion';
import { reopened, target } from './fixtures';

afterEach(cleanup);
type Tempos = Extract<EditCommand, { type: 'setMeasureSettings' }>['tempos'];
const settingsEdit = (tempos: Tempos, bar = 0): EditCommand => ({
  type: 'setMeasureSettings', bar, numerator: 4, denominator: 4, pickup: false, freeTime: false, repeatStart: false, repeatCount: 0, endings: [], section: '', tempos,
});
const withNote = (): Project => previewEdit(blankProject(), { type: 'setNote', target, string: 6, fret: 3 }).project;
const planTempos = (score: model.Score) => buildPlaybackPlan(score, 1).tempos.map(tempo => [tempo.tick, tempo.bpm]);
const gpif = (bytes: Uint8Array) => new TextDecoder().decode(unzipSync(bytes)['Content/score.gpif']);
/** An independent SMF scan: the microseconds per quarter note of every tempo meta event. */
function midiTempos(bytes: Uint8Array): number[] {
  const found: number[] = [];
  for (let at = 0; at < bytes.length - 5; at++) if (bytes[at] === 0xff && bytes[at + 1] === 0x51 && bytes[at + 2] === 3) found.push(bytes[at + 3] << 16 | bytes[at + 4] << 8 | bytes[at + 5]);
  return found;
}
const shape = (score: model.Score, bar = 0) => score.masterBars[bar].tempoAutomations.map(a => [a.value, tempoUnitOf(a)]);

describe('tempo units', () => {
  it.each([[1, 240, 120], [2, 120, 120], [3, 80, 120], [4, 60, 120], [5, 40, 120], [3, 100, 150], [4, 90, 180]])('unit %i at %f per minute sounds as %f quarter notes per minute', (unit, bpm, quarter) => {
    const edited = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm, linear: false, unit }]));
    const automation = edited.score.masterBars[0].tempoAutomations[0];
    expect(automation.value).toBeCloseTo(quarter, 9);
    expect(tempoUnitOf(automation)).toBe(unit);
    expect(displayedBpm(automation)).toBeCloseTo(bpm, 9);
    // The native player is built from this plan, so the timing authority hears the quarter-note tempo.
    expect(planTempos(edited.score)[0]).toEqual([0, quarter]);
  });

  it('one gesture is one edit, undone by dropping it, and survives save and reopen', () => {
    const base = withNote(), edited = previewEdit(base, settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }, { beat: 2, bpm: 60, linear: true, unit: 4 }]));
    expect(edited.project.edits).toHaveLength(base.edits.length + 1);
    const saved = JSON.parse(JSON.stringify(edited.project)) as Project, replayed = buildScore(saved);
    expect(replayed.masterBars[0].tempoAutomations.map(a => [a.value, tempoUnitOf(a), a.isLinear])).toEqual([[150, 3, false], [120, 4, true]]);
    expect(readMeasureSettings(replayed, 0).tempos).toEqual([{ beat: 0, bpm: 100, linear: false, unit: 3 }, { beat: 2, bpm: 60, linear: true, unit: 4 }]);
    expect(shape(buildScore({ ...saved, edits: saved.edits.slice(0, -1) }))).toEqual([[120, 2]]);
  });

  it('an edit logged before units existed replays as quarter notes and never invents a unit', () => {
    const base = withNote(), old: Project = { ...base, edits: [...base.edits, settingsEdit([{ beat: 0, bpm: 90, linear: false }])] };
    expect(JSON.stringify(old.edits.at(-1))).not.toContain('unit');
    const score = buildScore(JSON.parse(JSON.stringify(old)));
    expect(shape(score)).toEqual([[90, 2]]);
    expect(readMeasureSettings(score, 0).tempos).toEqual([{ beat: 0, bpm: 90, linear: false }]);
    expect(JSON.stringify(readMeasureSettings(score, 0))).not.toContain('unit');
  });

  it('replaceTempoAutomations takes units and rejects unknown ones', () => {
    const points = [{ bar: 0, ratio: 0, bpm: 100, linear: false, unit: 3 }, { bar: 1, ratio: 0.5, bpm: 70, linear: true }];
    const edited = previewEdit(withNote(), { type: 'replaceTempoAutomations', points });
    expect(shape(edited.score, 0)).toEqual([[150, 3]]);
    expect(shape(edited.score, 1)).toEqual([[70, 2]]);
    for (const unit of [0, 6, 2.5, '3', null]) {
      expect(() => validateParityCommand({ type: 'replaceTempoAutomations', points: [{ ...points[0], unit }] })).toThrow();
      expect(() => previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: unit as number }]))).toThrow();
    }
    expect(() => validateParityCommand({ type: 'replaceTempoAutomations', points })).not.toThrow();
  });

  it('the unit survives copies of the score, and the song tempo field keeps it only for the tempo it shows', () => {
    const edited = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }]));
    expect(shape(reopened(edited.score))).toEqual([[150, 3]]);
    expect(shape(previewEdit(edited.project, { type: 'setScoreInfo', title: 'T', artist: 'A', tempo: 150 }).score)).toEqual([[150, 3]]);
    expect(shape(previewEdit(edited.project, { type: 'setScoreInfo', title: 'T', artist: 'A', tempo: 140 }).score)).toEqual([[140, 2]]);
  });

  it('MIDI export plays the quarter-note tempo', () => {
    const dotted = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }])).score;
    expect(midiTempos(exportMidi(dotted, { tracks: [0], range: null }))).toEqual([400000]);
    const half = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 60, linear: false, unit: 4 }])).score;
    expect(midiTempos(exportMidi(half, { tracks: [0], range: null }))).toEqual([500000]);
  });

  it('GP export writes the unit and a reimport keeps both the unit and the playing tempo', () => {
    const score = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }, { beat: 2, bpm: 45, linear: true, unit: 5 }])).score;
    const bytes = exportGp(score), text = gpif(bytes);
    expect(text).toContain('<Value>100 3</Value>');
    expect(text).toContain('<Value>45 5</Value>');
    expect(text).not.toContain('<Value>150 2</Value>');
    const again = loadInterchangeScore(bytes, new Settings());
    expect(again.masterBars[0].tempoAutomations.map(a => [a.value, tempoUnitOf(a), displayedBpm(a), a.isLinear])).toEqual([[150, 3, 100, false], [135, 5, 45, true]]);
    expect(planTempos(again)[0]).toEqual([0, 150]);
    // A score that never used units still writes the quarter code alphaTab always wrote.
    expect(gpif(exportGp(buildScore(withNote())))).toContain('<Value>120 2</Value>');
  });

  it('a GP file from another program keeps the unit it names and plays at the quarter tempo', () => {
    const files = unzipSync(exportGp(buildScore(withNote())));
    const patched = new TextDecoder().decode(files['Content/score.gpif']).replace('<Value>120 2</Value>', '<Value>80 3</Value>');
    const loaded = loadInterchangeScore(zipSync({ ...files, 'Content/score.gpif': new TextEncoder().encode(patched) }), new Settings());
    const automation = loaded.masterBars[0].tempoAutomations[0];
    expect([automation.value, tempoUnitOf(automation), displayedBpm(automation)]).toEqual([120, 3, 80]);
  });

  it('two tempos at one position keep their own units through a GP round trip', () => {
    const files = unzipSync(exportGp(buildScore(withNote())));
    const first = '<Value>120 2</Value>', text = new TextDecoder().decode(files['Content/score.gpif']);
    const automation = text.slice(text.lastIndexOf('<Automation>', text.indexOf(first)), text.indexOf('</Automation>', text.indexOf(first)) + '</Automation>'.length);
    const doubled = text.replace(automation, automation.replace(first, '<Value>100 3</Value>') + automation);
    const loaded = loadInterchangeScore(zipSync({ ...files, 'Content/score.gpif': new TextEncoder().encode(doubled) }), new Settings());
    expect(shape(loaded)).toEqual([[150, 3], [120, 2]]);
    // Exporting writes each back in the unit it came with, not both in the first one's.
    const exported = gpif(exportGp(loaded));
    expect(exported.indexOf('<Value>100 3</Value>')).toBeGreaterThan(-1);
    expect(exported.indexOf('<Value>100 3</Value>')).toBeLessThan(exported.indexOf('<Value>120 2</Value>'));
  });

  it('a title that looks like the end of the master track does not stop the units being written', () => {
    const score = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }])).score;
    score.title = '</MasterTrack><MasterTrack>';
    expect(gpif(exportGp(score))).toContain('<Value>100 3</Value>');
  });

  it('a unit-free score serializes exactly as before, and inserted or removed measures keep the opening unit', () => {
    expect(model.JsonConverter.scoreToJson(buildScore(withNote()))).not.toContain('tabplayertempounit');
    const dotted = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }]));
    expect(model.JsonConverter.scoreToJson(dotted.score)).toContain('tabplayertempounit');
    const inserted = previewEdit(dotted.project, { type: 'insertMeasures', beforeBar: 0, count: 1 });
    expect(shape(inserted.score, 0)).toEqual([[150, 3]]);
    expect(planTempos(inserted.score)[0]).toEqual([0, 150]);
    const removed = previewEdit(dotted.project, { type: 'removeMeasure', bar: 0 });
    expect(shape(removed.score, 0)).toEqual([[150, 3]]);
  });

  it('an excerpt that starts after a unit tempo inherits the unit', () => {
    const score = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }])).score;
    const excerpt = selectScore(score, { tracks: [0], range: { first: 2, last: 3 } } as never);
    expect(shape(excerpt, 0)).toEqual([[150, 3]]);
  });

  it('writing score tempos keeps a unit the score already counts in', () => {
    const score = previewEdit(withNote(), settingsEdit([{ beat: 0, bpm: 100, linear: false, unit: 3 }])).score;
    const plan = buildPlaybackPlan(score, 1), locations = plan.occurrences;
    const timing = { entryTick: 0, exitTick: locations.at(-1)!.endTick, entrySourceMs: 0, exitSourceMs: locations.at(-1)!.endMs, segments: [{ startTick: 0, endTick: locations.at(-1)!.endTick, startSourceMs: 0, endSourceMs: locations.at(-1)!.endMs, bpm: 150 }] };
    const points = scoreTemposFromSync(score, timing as never, locations as never);
    expect(points[0]).toEqual({ bar: 0, ratio: 0, bpm: 100, linear: false, unit: 3 });
    expect(points.slice(1).every(point => point.bpm === 150 && point.unit === undefined)).toBe(true);
  });

  it('the measure panel offers units and sends the unit with a kept sounding tempo', () => {
    const score = buildScore(withNote()), onEdit = vi.fn();
    render(<MeasurePanel score={score} target={target} string={6} busy={false} onEdit={onEdit} />);
    fireEvent.change(screen.getByLabelText('Tempo 1 unit'), { target: { value: '3' } });
    expect(screen.getByLabelText('Tempo 1 BPM')).toHaveValue(80);
    fireEvent.click(screen.getByRole('button', { name: 'Apply measure settings' }));
    expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'setMeasureSettings', tempos: [{ beat: 0, bpm: 80, linear: false, unit: 3 }] }));
    fireEvent.change(screen.getByLabelText('Tempo 1 unit'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply measure settings' }));
    expect(JSON.stringify(onEdit.mock.calls.at(-1)![0])).not.toContain('unit');
  });
});
