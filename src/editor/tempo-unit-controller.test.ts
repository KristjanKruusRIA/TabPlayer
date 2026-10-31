// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { blankProject, type Project } from '../project';
import type { EditCommand } from '../edit-types';
import { buildScore, exportGp, previewEdit } from '../engine';
import { tempoUnitOf } from './tempo-unit';
import { target } from './fixtures';

const unitBase = (unit = 3): Project['base'] => {
  const score = previewEdit(blankProject(), { type: 'setMeasureSettings', bar: 0, numerator: 4, denominator: 4, pickup: false, freeTime: false, repeatStart: false, repeatCount: 0, endings: [], section: '', tempos: [{ beat: 0, bpm: 80, linear: false, unit }] }).score;
  return { kind: 'file', filename: 'unit.gp', bytesBase64: Buffer.from(exportGp(score)).toString('base64'), sha256: '0'.repeat(64) };
};

/** A native stand-in with the same refusals as `ProjectSession::mark_partial_capo`. */
async function controllerFor(base: Project['base']) {
  const { DocumentController } = await import('../controller');
  let project: Project = { ...blankProject(), base }, revision = 0;
  const record = () => ({ documentId: 'document-a', revision, snapshot: { project: structuredClone(project), canUndo: project.edits.length > 0, canRedo: false, redoEdit: null, dirty: false, path: null } });
  const markPartialCapo = vi.fn(async (expected: number) => {
    expect(expected).toBe(revision);
    project = { ...project, partialCapo: true }; revision++; return record();
  });
  const applyEdit = vi.fn(async (command: EditCommand, expected: number) => { expect(expected).toBe(revision); project = { ...project, edits: [...project.edits, command] }; revision++; return record(); });
  const controller = await DocumentController.create({ documentId: 'document-a', snapshot: async () => record(), markPartialCapo, applyEdit } as never);
  return { controller, markPartialCapo, project: () => project };
}

describe('the first edit of a file that holds a tempo unit', () => {
  it('marks the project first so the unit is still read when the log is replayed', async () => {
    const held = await controllerFor(unitBase());
    expect(tempoUnitOf(held.controller.getState().score.masterBars[0].tempoAutomations[0])).toBe(3);
    await held.controller.edit({ type: 'setNote', target, string: 6, fret: 5 });
    expect(held.markPartialCapo).toHaveBeenCalledTimes(1);
    expect(held.project().partialCapo).toBe(true);
    expect(tempoUnitOf(buildScore(held.project()).masterBars[0].tempoAutomations[0])).toBe(3);
  });
  it('does not mark a file without units', async () => {
    const plain = await controllerFor(unitBase(2));
    await plain.controller.edit({ type: 'setNote', target, string: 6, fret: 5 });
    expect(plain.markPartialCapo).not.toHaveBeenCalled();
  });
});
