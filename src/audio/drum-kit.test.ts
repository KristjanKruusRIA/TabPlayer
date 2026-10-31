import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { defaultMix, validateMix } from '../document-settings';
import type { EditCommand, Project } from '../project';
import {
  canonicalDrumKitMix,
  DRUM_KIT_ELEMENTS,
  validateDrumElement,
  validateDrumKit,
} from './drum-kit';

describe('drum-kit settings and validation', () => {
  it('validates drum element mixes and rejects out of bounds or extra fields', () => {
    expect(() => validateDrumElement({ gain: 0.8, pan: -0.2, mute: false, solo: false })).not.toThrow();
    expect(() => validateDrumElement({ gain: 1, pan: 1, mute: true, solo: true })).not.toThrow();
    expect(() => validateDrumElement({ gain: -0.1, pan: 0, mute: false, solo: false })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 1.1, pan: 0, mute: false, solo: false })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 0.5, pan: -1.5, mute: false, solo: false })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 0.5, pan: 1.5, mute: false, solo: false })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 0.5, pan: 0, mute: 'yes' as never, solo: false })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 0.5, pan: 0, mute: false, solo: 0 as never })).toThrow(/Invalid drum element mix/);
    expect(() => validateDrumElement({ gain: 0.5, pan: 0, mute: false, solo: false, extra: true } as never)).toThrow(/Invalid drum element mix/);
  });

  it('validates drum kit mixes and rejects unknown elements or empty kits', () => {
    expect(() => validateDrumKit({ kick: { gain: 0.5, pan: 0, mute: false, solo: false } })).not.toThrow();
    expect(() => validateDrumKit({})).toThrow(/Invalid drum kit mix/);
    expect(() => validateDrumKit(null)).toThrow(/Invalid drum kit mix/);
    expect(() => validateDrumKit({ cowbell: { gain: 0.5, pan: 0, mute: false, solo: false } } as never)).toThrow(/Invalid drum kit mix/);
  });

  it('canonicalizes drum kit mixes, dropping default elements and returning undefined if empty', () => {
    expect(canonicalDrumKitMix(undefined)).toBeUndefined();
    expect(canonicalDrumKitMix({})).toBeUndefined();
    expect(canonicalDrumKitMix({
      kick: { gain: 1, pan: 0, mute: false, solo: false },
      snare: { gain: 1, pan: 0, mute: false, solo: false },
    })).toBeUndefined();

    const custom = canonicalDrumKitMix({
      kick: { gain: 0.6, pan: 0, mute: false, solo: false },
      snare: { gain: 1, pan: 0, mute: false, solo: false },
    });
    expect(custom).toEqual({
      kick: { gain: 0.6, pan: 0, mute: false, solo: false },
    });
  });

  it('validateMix allows drumKit and rejects invalid drumKit structures', () => {
    const base = defaultMix();
    expect(() => validateMix({
      ...base,
      drumKit: {
        kick: { gain: 0.7, pan: -0.1, mute: false, solo: false },
      },
    })).not.toThrow();

    expect(() => validateMix({
      ...base,
      drumKit: {} as never,
    })).toThrow(/Invalid drum kit mix/);

    expect(() => validateMix({
      ...base,
      drumKit: {
        snare: { gain: 2.0, pan: 0, mute: false, solo: false },
      },
    })).toThrow(/Invalid drum element mix/);
  });

  it('replays an old .tabplayer project and handles new drum kit edits through previewEdit', () => {
    const oldPath = resolve(__dirname, '../../assets/library/templates/factory-drums.tabplayer');
    const raw = readFileSync(oldPath, 'utf8');
    const project: Project = JSON.parse(raw);

    // Old project must build without errors
    const built = buildDocument(project);
    expect(built.score.tracks.length).toBe(1);
    expect(built.score.tracks[0].isPercussion).toBe(true);

    const trackId = trackIdentity(built.score.tracks[0]);
    expect(trackId).toBeDefined();
    const originalMix = built.settings.mixes[trackId];
    expect(originalMix.drumKit).toBeUndefined();

    // Apply a setTrackMix edit with drumKit
    const editCommand: EditCommand = {
      type: 'setTrackMix',
      trackId,
      mix: {
        ...originalMix,
        drumKit: {
          kick: { gain: 0.5, pan: 0, mute: false, solo: true },
          snare: { gain: 0.8, pan: 0.2, mute: false, solo: false },
        },
      },
    };

    const next = previewEdit(project, editCommand, built);
    expect(next.settings.mixes[trackId].drumKit).toEqual({
      kick: { gain: 0.5, pan: 0, mute: false, solo: true },
      snare: { gain: 0.8, pan: 0.2, mute: false, solo: false },
    });

    // Replay from scratch through buildDocument matches previewEdit
    const fullBuild = buildDocument(next.project);
    expect(fullBuild.settings.mixes[trackId].drumKit).toEqual(next.settings.mixes[trackId].drumKit);

    // Save and parse produces identical structure
    const serialized = JSON.stringify(next.project);
    const restored: Project = JSON.parse(serialized);
    const restoredBuild = buildDocument(restored);
    expect(restoredBuild.settings.mixes[trackId].drumKit).toEqual(next.settings.mixes[trackId].drumKit);
  });
});
