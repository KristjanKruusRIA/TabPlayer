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

  it('records locking as one undoable edit, saved in document settings and reversible with undo', () => {
    let project = blankProject();
    const trackId = 'base/0';
    const initial = buildDocument(project);

    // Apply locked edit
    const lockedSound: TrackSound = { ...soundPreset('crunch'), locked: true };
    const lockEdit: EditCommand = { type: 'setTrackSound', trackId, sound: lockedSound };
    project = previewEdit(project, lockEdit, initial).project;

    const lockedDoc = buildDocument(project);
    expect(lockedDoc.settings.sounds[trackId].locked).toBe(true);
    expect(lockedDoc.settings.sounds[trackId].presetId).toBe('crunch');
    expect(validateProject(project).edits).toHaveLength(1);

    // Replay settings-only matches
    expect(replayDocumentSettings(project, lockedDoc).settings.sounds[trackId].locked).toBe(true);

    // Undo unlocks / restores previous sound
    project = { ...project, edits: [] };
    const restored = buildDocument(project);
    expect(restored.settings.sounds[trackId]?.locked).toBeUndefined();
  });
});
