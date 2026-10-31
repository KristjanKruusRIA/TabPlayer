import { expect, it } from 'vitest';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { defaultEffects, soundProblem } from '../document-settings';
import { blankProject } from '../project';
import { drumKitFor, drumKits, kitDifferences, sharedSounds } from './drum-kits';

it('lists the kits the sound bank carries, each different from Standard, Standard first', () => {
  expect(drumKits.map(kit => [kit.program, kit.label])).toEqual([[0, 'Standard'], [8, 'Room'], [32, 'Jazz'], [40, 'Brush']]);
  expect(drumKits[0].changes).toEqual([]);
  for (const kit of drumKits.slice(1)) expect(kit.changes.length, kit.label).toBeGreaterThan(0);
});
it('a program that names no kit plays Standard', () => {
  for (const program of [1, 7, 25, 33, 41, 127]) expect(drumKitFor(program).label).toBe('Standard');
  expect(drumKitFor(32).label).toBe('Jazz');
});
it('names the standard hits each kit changes', () => {
  expect(kitDifferences(drumKitFor(32))).toEqual(['Kick (hit)', 'Kick (hit) 2']);
  expect(kitDifferences(drumKitFor(40))).toContain('Snare (hit)');
});
it('lists notations that share one sound, with rim shot, choke and half-open among them', () => {
  const groups = sharedSounds();
  const containing = (label: string) => groups.find(group => group.labels.includes(label))?.labels ?? [];
  expect(containing('Snare (rim shot)')).toContain('Snare (hit)');
  expect(containing('Hi-Hat (half)')).toContain('Hi-Hat (open)');
  expect(containing('Ride (choke)')).toContain('Ride (middle)');
  expect(containing('Crash high (choke)')).toContain('Crash high (hit)');
  expect(containing('Snare (side stick)')).not.toContain('Snare (hit)');
  expect(new Set(groups.map(group => group.key)).size).toBe(groups.length);
});
it('a log written before kits replays unchanged, and a kit is one setTrackSound edit that undoes and survives save', () => {
  const added = previewEdit(blankProject(), { type: 'addPercussionTrack', name: 'Drums', program: 0 });
  const trackId = trackIdentity(added.score.tracks[1]);
  const plain = { voiceId: null, presetId: 'gm' as const, effects: defaultEffects() };
  // An old log: a sound edit with no kit field.
  const old = previewEdit(added.project, { type: 'setTrackSound', trackId, sound: plain });
  expect(old.settings.sounds[trackId].drumKit).toBeUndefined();
  expect('drumKit' in JSON.parse(JSON.stringify(old.project.edits.at(-1)!))['sound']).toBe(false);
  const kitted = previewEdit(old.project, { type: 'setTrackSound', trackId, sound: { ...plain, drumKit: 40 } });
  expect(kitted.project.edits.length).toBe(old.project.edits.length + 1);
  expect(kitted.settings.sounds[trackId].drumKit).toBe(40);
  const saved = buildDocument(JSON.parse(JSON.stringify(kitted.project)));
  expect(saved.settings.sounds[trackId].drumKit).toBe(40);
  const undone = buildDocument({ ...kitted.project, edits: kitted.project.edits.slice(0, -1) });
  expect(undone.settings.sounds[trackId].drumKit).toBeUndefined();
  // The old edit log replays to exactly the settings it did before.
  expect(buildDocument(old.project).settings).toEqual(old.settings);
  expect(soundProblem({ ...plain, drumKit: 40 })).toBeNull();
  for (const bad of [0, 1, 25, 128, '40', null]) expect(soundProblem({ ...plain, drumKit: bad as number }), String(bad)).toBe('Unknown drum kit.');
});
