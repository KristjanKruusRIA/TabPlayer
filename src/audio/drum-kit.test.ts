import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDocument, previewEdit, trackIdentity } from '../engine';
import { defaultMix, validateMix } from '../document-settings';
import type { EditCommand, Project } from '../project';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { drumPieces, instrumentOf, percussionInstruments } from '../instruments/drum-kit';
import {
  canonicalDrumKitMix,
  DRUM_KIT_ELEMENTS,
  kitElementOfInstrument,
  pitchKitElement,
  planKitElement,
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

describe('drum kit elements follow the articulation, not only its pitch', () => {
  const owner = (id: number) => {
    const entry = standardPercussionCatalog.find(item => item.id === id)!;
    return instrumentOf(entry.element, entry.outputMidiNumber);
  };
  const named = (label: string) => standardPercussionCatalog.find(item => item.label.startsWith(label))!;

  it('puts every instrument of the kit in one element', () => {
    for (const instrument of [...drumPieces, ...percussionInstruments]) {
      expect(DRUM_KIT_ELEMENTS, instrument.id).toContain(kitElementOfInstrument(instrument.id));
    }
    expect(kitElementOfInstrument('kick')).toBe('kick');
    expect(kitElementOfInstrument('snare')).toBe('snare');
    expect(kitElementOfInstrument('hi-hat')).toBe('hats');
    expect(kitElementOfInstrument('low-tom')).toBe('toms');
    expect(kitElementOfInstrument('floor-tom')).toBe('toms');
    expect(kitElementOfInstrument('crash')).toBe('cymbals');
    expect(kitElementOfInstrument('ride-2')).toBe('cymbals');
    expect(kitElementOfInstrument('cowbell')).toBe('other');
  });

  it('names the element for exactly the standard articulations whose pitch would mix them elsewhere', () => {
    const differing = standardPercussionCatalog.filter(entry => {
      const instrument = owner(entry.id);
      return instrument && planKitElement(instrument, entry.outputMidiNumber) !== undefined;
    });
    // They sound the pitch of a snare, a ride or a tom, and are not those pieces.
    expect(differing.map(entry => entry.label).sort()).toEqual([
      'Bell Tree (hit)', 'Bell Tree (return)', 'Grancassa (hit)', 'Jingle Bell (hit)', 'Metronome (bell)', 'Metronome (hit)',
      'Piatti (hand)', 'Piatti (hit)', 'Tinkle Bell (hit)',
    ]);
    for (const entry of differing) expect(planKitElement(owner(entry.id), entry.outputMidiNumber), entry.label).toBe('other');
    // An ordinary snare, bass drum, hat and ride name nothing: the player reads their pitch.
    for (const label of ['Snare (hit)', 'Kick (hit)', 'Hi-Hat (closed)', 'Ride (middle)']) {
      const entry = named(label);
      expect(planKitElement(owner(entry.id), entry.outputMidiNumber), label).toBeUndefined();
    }
  });

  it('names nothing for an articulation nobody owns', () => {
    expect(planKitElement(undefined, 38)).toBeUndefined();
    expect(instrumentOf('Mystery', 77)?.id).toBe('woodblock-low');
    expect(instrumentOf('Mystery', 1)).toBeUndefined();
  });

  it('groups pitches as the native player does', () => {
    // settings.rs `gm_kit_element` is what the player falls back to, so read its match arms and compare every pitch.
    const source = readFileSync(resolve(__dirname, '../../src-tauri/src/settings.rs'), 'utf8').replace(/\r\n/g, '\n');
    const body = /pub fn gm_kit_element\(key: u8\) -> KitElement \{\n\s*match key \{\n([\s\S]*?)\n\s*\}\n\}/.exec(source)![1];
    const native = new Map<number, string>();
    let other = '';
    for (const line of body.split('\n')) {
      const arm = /^\s*([\d |]+|_) => KitElement::(\w+),/.exec(line)!;
      if (arm[1] === '_') other = arm[2].toLowerCase();
      else for (const key of arm[1].split('|')) native.set(Number(key.trim()), arm[2].toLowerCase());
    }
    expect(other).toBe('other');
    for (let key = 0; key < 128; key++) expect(pitchKitElement(key), `pitch ${key}`).toBe(native.get(key) ?? 'other');
  });
});
