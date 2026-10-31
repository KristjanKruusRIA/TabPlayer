import type { ChannelMix, DrumElementMix, DrumKitElement, DrumKitMix } from '../edit-types';

export const DRUM_KIT_ELEMENTS: readonly DrumKitElement[] = [
  'kick',
  'snare',
  'hats',
  'toms',
  'cymbals',
  'other',
] as const;

export const DRUM_KIT_ELEMENT_LABELS: Record<DrumKitElement, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hats: 'Hi-Hat',
  toms: 'Toms',
  cymbals: 'Cymbals',
  other: 'Other percussion',
};

export const defaultDrumElement = (): DrumElementMix => ({
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
});

export const isDefaultDrumElement = (mix: DrumElementMix): boolean =>
  mix.gain === 1 && mix.pan === 0 && !mix.mute && !mix.solo;

export function validateDrumElement(element: unknown): asserts element is DrumElementMix {
  const fail = () => {
    throw new Error('Invalid drum element mix.');
  };
  if (!element || typeof element !== 'object' || Array.isArray(element)) fail();
  const obj = element as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join();
  if (keys !== 'gain,mute,pan,solo') fail();
  if (
    typeof obj.gain !== 'number' ||
    !Number.isFinite(obj.gain) ||
    obj.gain < 0 ||
    obj.gain > 1
  ) {
    fail();
  }
  if (
    typeof obj.pan !== 'number' ||
    !Number.isFinite(obj.pan) ||
    obj.pan < -1 ||
    obj.pan > 1
  ) {
    fail();
  }
  if (typeof obj.mute !== 'boolean' || typeof obj.solo !== 'boolean') {
    fail();
  }
}

export function validateDrumKit(kit: unknown): asserts kit is DrumKitMix {
  const fail = () => {
    throw new Error('Invalid drum kit mix.');
  };
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) fail();
  const obj = kit as Record<string, unknown>;
  const present = Object.keys(obj);
  if (!present.length) fail();
  if (present.some(key => !DRUM_KIT_ELEMENTS.includes(key as DrumKitElement))) fail();
  for (const key of present) {
    validateDrumElement(obj[key]);
  }
}

export function canonicalDrumKitMix(kit: DrumKitMix | undefined): DrumKitMix | undefined {
  if (!kit) return undefined;
  const out: Partial<DrumKitMix> = {};
  for (const key of DRUM_KIT_ELEMENTS) {
    const el = kit[key];
    if (el && !isDefaultDrumElement(el)) {
      out[key] = { ...el };
    }
  }
  return Object.keys(out).length ? (out as DrumKitMix) : undefined;
}

export function drumKitsOf(mixes: Record<string, ChannelMix>): Record<string, DrumKitMix> {
  const out: Record<string, DrumKitMix> = {};
  for (const [id, mix] of Object.entries(mixes)) {
    if (mix.drumKit) out[id] = mix.drumKit;
  }
  return out;
}
