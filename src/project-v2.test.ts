import { describe, expect, it } from 'vitest';
import { buildScore, validateProject } from './engine';
import { blankProject } from './project';

describe('runtime project compatibility', () => {
  it('migrates a version-one project without changing its music', () => {
    const legacy = JSON.parse(JSON.stringify(blankProject()));
    legacy.schemaVersion = 1;
    delete legacy.assets;
    delete legacy.baselineEdits;
    const migrated = validateProject(legacy);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.baselineEdits).toEqual([]);
    expect(migrated).toHaveProperty('assets', {});
    const score = buildScore(migrated);
    expect(score.title).toBe(legacy.base.title);
    expect(score.masterBars).toHaveLength(legacy.base.measureCount);
    expect(score.tracks[0].staves[0].tuning).toEqual(legacy.base.tuning);
    expect(legacy).not.toHaveProperty('assets');
  });

  it('accepts v2 metadata without transmitting encoded audio', () => {
    const {baselineEdits,...legacy}=blankProject();
    expect(baselineEdits).toEqual([]);
    const project = {
      ...legacy, schemaVersion: 2,
      assets: { ['a'.repeat(64)]: { filename: 'backing.wav', mediaType: 'audio/wav', byteLength: 4096 } },
    };
    const validated = validateProject(project);
    expect(validated).toEqual({...project,schemaVersion:3,baselineEdits:[]});
    expect(JSON.stringify(validated.assets)).not.toContain('bytesBase64');
  });

  it('rejects encoded blobs and invalid metadata in runtime asset records', () => {
    const asset = { filename: 'backing.wav', mediaType: 'audio/wav', byteLength: 4096 };
    for (const record of [{ ...asset, bytesBase64: 'AAAA' }, { ...asset, byteLength: -1 }, { ...asset, byteLength: 1.5 }]) {
      expect(() => validateProject({ ...blankProject(), assets: { ['a'.repeat(64)]: record } }))
        .toThrow(/asset/i);
    }
  });

  it('rejects a backing command referencing a missing asset', () => {
    const backing = { assetId: 'a'.repeat(64), offsetMs: 0, anchors: [], mix: { gain: 1, pan: 0, mute: false, solo: false } };
    expect(() => validateProject({ ...blankProject(), assets: {}, edits: [{ type: 'setBacking', backing }] }))
      .toThrow(/asset/i);
  });
});
