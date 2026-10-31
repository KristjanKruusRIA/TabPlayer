import { describe, expect, it } from 'vitest';
import { blankProject } from '../project';
import { buildDocument, previewEdit, replayDocumentSettings, validateProject } from '../engine';
import { completeSound, defaultDocumentSettings, soundProblem } from '../document-settings';
import { soundPreset } from './SoundPanel';
import type { EditCommand, TrackSound } from '../edit-types';

describe('GP8 row A32 - Track sound lock against automations', () => {
  it('validates sound lock and rejects non-boolean or extra fields', () => {
    const clean = soundPreset('clean');
    expect(soundProblem(clean)).toBeNull();
    expect(soundProblem({ ...clean, locked: true })).toBeNull();
    expect(soundProblem({ ...clean, locked: false })).toBeNull();

    expect(soundProblem({ ...clean, locked: 'yes' as unknown as boolean })).toBe('Invalid sound.');
    expect(soundProblem({ ...clean, locked: 1 as unknown as boolean })).toBe('Invalid sound.');
    expect(soundProblem({ ...clean, locked: true, extra: 1 } as unknown as TrackSound)).toBe('Invalid sound.');
  });

  it('omits locked when false to keep unlocked documents byte-identical', () => {
    const clean = soundPreset('clean');
    const completedUnlocked = completeSound({ ...clean, locked: false });
    expect(completedUnlocked).not.toHaveProperty('locked');
    expect(JSON.stringify(completedUnlocked)).not.toContain('locked');

    const completedLocked = completeSound({ ...clean, locked: true });
    expect(completedLocked.locked).toBe(true);
    expect(JSON.stringify(completedLocked)).toContain('"locked":true');
  });

  it('replays old logs without locked field, keeping old projects replayable', () => {
    let project = blankProject();
    const oldEdits: EditCommand[] = [
      { type: 'setTrackSound', trackId: 'base/0', sound: soundPreset('clean') },
      { type: 'setTrackMix', trackId: 'base/0', mix: { gain: 0.8, pan: 0, mute: false, solo: false } },
    ];
    for (const edit of oldEdits) {
      project = previewEdit(project, edit).project;
    }
    const built = buildDocument(project);
    expect(built.settings.sounds['base/0']).toBeDefined();
    expect(built.settings.sounds['base/0'].locked).toBeUndefined();
    expect(JSON.stringify(built.settings.sounds['base/0'])).not.toContain('locked');

    // Replay matches full build
    expect(replayDocumentSettings(project, built).settings.sounds['base/0']).toEqual(built.settings.sounds['base/0']);
  });

  it('records locking as one setTrackSound edit that lands in the document settings and replays the same', () => {
    let project = blankProject();
    const trackId = 'base/0';
    const initial = buildDocument(project);

    const lockedSound: TrackSound = { ...soundPreset('crunch'), locked: true };
    const lockEdit: EditCommand = { type: 'setTrackSound', trackId, sound: lockedSound };
    project = previewEdit(project, lockEdit, initial).project;

    const lockedDoc = buildDocument(project);
    expect(lockedDoc.settings.sounds[trackId].locked).toBe(true);
    expect(lockedDoc.settings.sounds[trackId].presetId).toBe('crunch');
    expect(validateProject(project).edits).toEqual([lockEdit]);
    expect(replayDocumentSettings(project, lockedDoc).settings.sounds[trackId].locked).toBe(true);

    // Unlocking is a second edit on top, and leaves no `locked` field. Undo and redo of these edits are the native
    // history's, tested in src-tauri/tests/project_v2.rs.
    const unlockEdit: EditCommand = { type: 'setTrackSound', trackId, sound: soundPreset('crunch') };
    project = previewEdit(project, unlockEdit, lockedDoc).project;
    expect(validateProject(project).edits).toEqual([lockEdit, unlockEdit]);
    expect(buildDocument(project).settings.sounds[trackId]).not.toHaveProperty('locked');
  });
});
