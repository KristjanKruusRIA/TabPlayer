import maps from './midi-articulation-maps.json';

export type MidiArticulationPresetId = string;

export interface MidiArticulationOptions {
  enabled: boolean;
  preset: string;
  octaveShift?: number;
}

export interface ForceStringConstraint {
  anchor: 'lowest' | 'highest';
  offset: number;
}

export interface MidiNoteArticulation {
  forceString?: ForceStringConstraint;
  dead?: boolean;
  palmMute?: boolean;
  harmonic?: boolean;
  hammerPull?: boolean;
  tap?: boolean;
  slide?: 'legato' | 'shift';
  slap?: boolean;
  pop?: boolean;
  deadSlap?: boolean;
}

export type KeyswitchAction =
  | { type: 'normal' }
  | { type: 'forceString'; anchor: 'lowest' | 'highest'; offset: number }
  | ({ type: 'technique' } & Omit<MidiNoteArticulation, 'forceString'>);

export interface KeyswitchEntry {
  key: number;
  mode: 'momentary' | 'latch';
  action: KeyswitchAction;
}

export interface MidiArticulationPreset {
  id: string;
  name: string;
  switches: readonly KeyswitchEntry[];
}

export const DEFAULT_MIDI_ARTICULATION_PRESET = 'submission-audio-default';

const presets = maps.presets as readonly MidiArticulationPreset[];

/** Lists all built-in guitar/bass keyswitch articulation presets. */
export const midiArticulationPresets = (): readonly MidiArticulationPreset[] => presets;

/** Finds a keyswitch articulation preset by id. */
export const midiArticulationPresetById = (id: string): MidiArticulationPreset | undefined =>
  presets.find(entry => entry.id === id);

/** Returns MIDI note numbers (`0..127`) recognized as keyswitches for `presetId` at `octaveShift`. */
export function presetKeyswitchSet(presetId: string, octaveShift = 0): Set<number> {
  const preset = midiArticulationPresetById(presetId);
  if (!preset) return new Set();
  const shift = Math.trunc(octaveShift) * 12;
  const set = new Set<number>();
  for (const entry of preset.switches) {
    const shifted = entry.key + shift;
    if (shifted >= 0 && shifted <= 127) set.add(shifted);
  }
  return set;
}

/**
 * Counts hits belonging to keyswitch keys. When `presetId` is omitted, checks the shared
 * low (`0..22`) and high (`120..127`) keyswitch ranges across built-in presets.
 */
export function countDetectedKeyswitches(
  keys: readonly { key: number; count: number }[],
  presetId?: string,
  octaveShift = 0,
): number {
  const target = presetId
    ? presetKeyswitchSet(presetId, octaveShift)
    : new Set<number>([
        ...presetKeyswitchSet('submission-audio-default', 0),
        ...presetKeyswitchSet('the-primer', 0),
      ].filter(k => k <= 22 || k >= 120));
  let total = 0;
  for (const entry of keys) {
    if (target.has(entry.key)) total += entry.count;
  }
  return total;
}

/**
 * Maps a `forceString` constraint onto 0-based `open[]` index where `0` is the lowest string
 * and `stringCount - 1` is the highest string. Returns null when out of bounds.
 */
export function resolveForcedStringIndex(
  constraint: ForceStringConstraint,
  stringCount: number,
): number | null {
  if (!Number.isInteger(stringCount) || stringCount <= 0 || constraint.offset < 0) return null;
  if (constraint.anchor === 'lowest') {
    return constraint.offset < stringCount ? constraint.offset : null;
  }
  const index = stringCount - 1 - constraint.offset;
  return index >= 0 && index < stringCount ? index : null;
}

function actionToArticulation(action: KeyswitchAction): MidiNoteArticulation | undefined {
  if (action.type === 'normal') return undefined;
  if (action.type === 'forceString') {
    return { forceString: { anchor: action.anchor, offset: action.offset } };
  }
  const result: MidiNoteArticulation = {};
  if (action.dead) result.dead = true;
  if (action.palmMute) result.palmMute = true;
  if (action.harmonic) result.harmonic = true;
  if (action.hammerPull) result.hammerPull = true;
  if (action.tap) result.tap = true;
  if (action.slide) result.slide = action.slide;
  if (action.slap) result.slap = true;
  if (action.pop) result.pop = true;
  if (action.deadSlap) result.deadSlap = true;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Combines two note articulation records, with later boolean flags ORed and later `forceString` winning. */
export function mergeArticulations(
  a?: MidiNoteArticulation,
  b?: MidiNoteArticulation,
): MidiNoteArticulation | undefined {
  if (!a && !b) return undefined;
  if (!a) return { ...b };
  if (!b) return { ...a };
  const merged: MidiNoteArticulation = {};
  const forceString = b.forceString ?? a.forceString;
  if (forceString) merged.forceString = forceString;
  if (a.dead || b.dead) merged.dead = true;
  if (a.palmMute || b.palmMute) merged.palmMute = true;
  if (a.harmonic || b.harmonic) merged.harmonic = true;
  if (a.hammerPull || b.hammerPull) merged.hammerPull = true;
  if (a.tap || b.tap) merged.tap = true;
  const slide = b.slide ?? a.slide;
  if (slide) merged.slide = slide;
  if (a.slap || b.slap) merged.slap = true;
  if (a.pop || b.pop) merged.pop = true;
  if (a.deadSlap || b.deadSlap) merged.deadSlap = true;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Strips recognized keyswitch notes from `notes` before pitch-shifting/quantization and attaches
 * active latch and momentary articulations onto overlapping playable notes.
 */
export function extractMidiArticulations<T extends { key: number; start: number; end: number }>(
  notes: readonly T[],
  presetId: string,
  division: number,
  octaveShift = 0,
): {
  notes: (T & { articulation?: MidiNoteArticulation })[];
  keyswitchesFound: number;
  notesAnnotated: number;
} {
  const preset = midiArticulationPresetById(presetId);
  if (!preset) {
    return { notes: notes.map(entry => ({ ...entry })), keyswitchesFound: 0, notesAnnotated: 0 };
  }
  const shift = Math.trunc(octaveShift) * 12;
  const switchMap = new Map<number, KeyswitchEntry>();
  for (const sw of preset.switches) {
    const k = sw.key + shift;
    if (k >= 0 && k <= 127) switchMap.set(k, sw);
  }

  const keyswitches: { start: number; end: number; entry: KeyswitchEntry }[] = [];
  const playable: T[] = [];
  for (const item of notes) {
    const found = switchMap.get(item.key);
    if (found) keyswitches.push({ start: item.start, end: item.end, entry: found });
    else playable.push(item);
  }
  if (!keyswitches.length) {
    return { notes: playable.map(entry => ({ ...entry })), keyswitchesFound: 0, notesAnnotated: 0 };
  }

  keyswitches.sort((a, b) => a.start - b.start || a.end - b.end);
  const latchSwitches = keyswitches.filter(item => item.entry.mode === 'latch');
  const momentarySwitches = keyswitches.filter(item => item.entry.mode === 'momentary');
  const leadTicks = Math.max(1, Math.round(Math.max(1, division) / 64));

  let notesAnnotated = 0;
  const annotated = playable.map(note => {
    let active: MidiNoteArticulation | undefined;
    // Apply most recent latch switch active at note onset.
    for (let i = latchSwitches.length - 1; i >= 0; i--) {
      if (latchSwitches[i].start <= note.start + leadTicks) {
        active = actionToArticulation(latchSwitches[i].entry.action);
        break;
      }
    }
    // Compose all momentary switches spanning note.start.
    for (const ks of momentarySwitches) {
      if (ks.start - leadTicks > note.start) break;
      const zeroLengthHit = ks.end <= ks.start && note.start <= ks.start + leadTicks;
      const spannedHit = ks.end > ks.start && note.start < ks.end;
      if (zeroLengthHit || spannedHit) {
        const next = actionToArticulation(ks.entry.action);
        if (next) active = mergeArticulations(active, next);
      }
    }
    if (active) {
      notesAnnotated++;
      return { ...note, articulation: active };
    }
    return { ...note };
  });

  return { notes: annotated, keyswitchesFound: keyswitches.length, notesAnnotated };
}
