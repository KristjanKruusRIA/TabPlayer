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

/** The kit element each instrument of the drum kit belongs to, by its place on the kit. Every instrument not listed is `other`. */
const KIT_ELEMENT_OF_INSTRUMENT: Readonly<Record<string, DrumKitElement>> = {
  kick: 'kick',
  'kick-2': 'kick',
  snare: 'snare',
  'electric-snare': 'snare',
  'hi-hat': 'hats',
  'high-tom': 'toms',
  'hi-mid-tom': 'toms',
  'low-mid-tom': 'toms',
  'low-tom': 'toms',
  'high-floor-tom': 'toms',
  'floor-tom': 'toms',
  splash: 'cymbals',
  crash: 'cymbals',
  'crash-2': 'cymbals',
  reverse: 'cymbals',
  ride: 'cymbals',
  china: 'cymbals',
  'ride-2': 'cymbals',
};

/** The element an instrument of the kit belongs to. */
export const kitElementOfInstrument = (instrumentId: string): DrumKitElement =>
  KIT_ELEMENT_OF_INSTRUMENT[instrumentId] ?? 'other';

/**
 * The element a sounding pitch belongs to, which is all the native player knows of a note whose plan names no element.
 * It must stay equal to `gm_kit_element` in src-tauri/src/settings.rs.
 */
export function pitchKitElement(key: number): DrumKitElement {
  if (key === 35 || key === 36) return 'kick';
  if (key === 37 || key === 38 || key === 40) return 'snare';
  if (key === 42 || key === 44 || key === 46) return 'hats';
  if ([41, 43, 45, 47, 48, 50].includes(key)) return 'toms';
  if ([49, 51, 52, 53, 55, 57, 59].includes(key)) return 'cymbals';
  return 'other';
}

/**
 * The element a note names in the playback plan: the one its articulation belongs to, given the instrument that owns the
 * articulation, and only where that is not the one its pitch gives (a metronome click sounds a snare pitch). A note nobody owns
 * names none, and is mixed by its pitch.
 */
export function planKitElement(owner: { id: string } | undefined, key: number): DrumKitElement | undefined {
  if (!owner) return undefined;
  const element = kitElementOfInstrument(owner.id);
  return element === pitchKitElement(key) ? undefined : element;
}
