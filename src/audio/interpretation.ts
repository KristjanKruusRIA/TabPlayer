import type { ChannelMix, TrackInterpretation } from '../edit-types';
import type { PlanNote } from './types';

/**
 * Track interpretation: how a track's written notes are performed, without rewriting the score.
 * Every field is absent while at its default, so a track left alone plans exactly as before.
 * The settings live on the track's mix, the existing per-track setting that is replayed, undone
 * and copied with duplicated tracks; the playback plan applies them to stringed notes only.
 */
export const interpretationOptions = {
  style: ['pick', 'fingers'],
  palmMute: ['light', 'heavy'],
  accent: ['light', 'strong'],
  brush: ['down', 'up'],
} as const;
const keys = ['style', 'palmMute', 'accent', 'letRing', 'brush'] as const;

/** Throws unless `value` is a canonical interpretation: known keys with known values, at least one set. */
export function validateInterpretation(value: unknown): asserts value is TrackInterpretation {
  const fail = () => { throw new Error('Invalid track interpretation.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const fields = value as Record<string, unknown>, present = Object.keys(fields);
  if (!present.length || present.some(key => !(keys as readonly string[]).includes(key))) fail();
  for (const key of present) {
    const entry = fields[key];
    if (key === 'letRing' ? entry !== true : !(interpretationOptions as Record<string, readonly unknown[]>)[key].includes(entry)) fail();
  }
}
/** `value` without its default fields; undefined when nothing is left. */
export function canonicalInterpretation(value: TrackInterpretation | undefined): TrackInterpretation | undefined {
  if (!value) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (value[key] !== undefined && (value[key] as unknown) !== false) out[key] = value[key];
  return Object.keys(out).length ? out as TrackInterpretation : undefined;
}
/** The tracks' interpretations, by track identity; tracks at their defaults are left out. */
export function interpretationsOf(mixes: Record<string, ChannelMix>): Record<string, TrackInterpretation> {
  const out: Record<string, TrackInterpretation> = {};
  for (const [id, mix] of Object.entries(mixes)) if (mix.interpretation) out[id] = mix.interpretation;
  return out;
}

/** Velocity an accented strong beat gains, and the share of it that the middle of the bar gets. */
export const accentBoost = { light: 10, strong: 22 } as const;
export const midBarShare = 0.5;
/** Palm mutes fade quicker the heavier they are. */
export const heavyMuteVelocity = 0.8;
/** Ticks a beat may sit from a strong position and still count: tuplet rounding drifts a few ticks, the closest written subdivision is 15 away. */
export const accentTolerance = 7;
/** A brush spreads a chord by up to this many ticks (a 64th-note triplet's worth) between strings. */
export const brushSpacing = 30;

/** Offsets in ticks, from the start of a bar, of its main beats: the downbeat is always one. */
export function strongOffsets(numerator: number, denominator: number): { downbeat: number; middle: number[] } {
  const pulse = 3840 / denominator;
  if (denominator === 4 && numerator === 4) return { downbeat: 0, middle: [2 * pulse] };
  if (denominator >= 8 && numerator >= 6 && numerator % 3 === 0) return { downbeat: 0, middle: Array.from({ length: numerator / 3 - 1 }, (_, i) => (i + 1) * 3 * pulse) };
  return { downbeat: 0, middle: [] };
}

/** One attack of an interpreted track, with what the pass needs to know about its place in the score. */
export interface Attack {
  note: PlanNote;
  /** The note's own times and velocity, written back after the pass because they feed the plan's MIDI events. */
  raw: { start: number; end: number; velocity: number };
  staff: number;
  /** Ticks from the start of the bar to the beat as written (a grace note does not move its main note), counted so that a pickup bar ends where a full one does. */
  offset: number;
  /** Whether the attack may take an accent: the first attack of a beat that is not a grace note. */
  accentable: boolean;
  meter: readonly [number, number];
  occurrenceEnd: number;
  /** Identifies the beat that the attack belongs to, for brushing it as one chord. */
  beat: string;
  /** Whether a brush may delay this attack: no written brush or rasgueado, one attack for the note, no bend. */
  brushable: boolean;
}

const ringless = new Set(['muted', 'dead', 'staccato', 'ghost']);
/** Applies `profiles` (by track identity) to the plan notes in place; `attacks` holds every stringed attack of an interpreted track. */
export function interpretAttacks(attacks: Attack[], profiles: Record<string, TrackInterpretation>): void {
  for (const attack of attacks) {
    const profile = profiles[attack.note.trackId], note = attack.note;
    if (note.articulation === 'muted' && profile.palmMute === 'light') note.articulation = 'staccato';
    else if (note.articulation === 'muted' && profile.palmMute === 'heavy') note.velocity = Math.max(1, Math.round(note.velocity * heavyMuteVelocity));
    if (profile.accent && attack.accentable && note.articulation !== 'dead' && note.articulation !== 'ghost') {
      const marks = strongOffsets(...attack.meter), near = (tick: number) => Math.abs(attack.offset - tick) <= accentTolerance;
      const share = near(marks.downbeat) ? 1 : marks.middle.some(near) ? midBarShare : 0;
      if (share) note.velocity = Math.min(127, note.velocity + Math.round(accentBoost[profile.accent] * share));
    }
  }
  const chords = new Map<string, Attack[]>();
  for (const attack of attacks) {
    if (!profiles[attack.note.trackId].brush) continue;
    const key = `${attack.note.trackId}/${attack.beat}/${attack.note.occurrence}/${attack.note.playedBar ?? ''}`, chord = chords.get(key) ?? [];
    chord.push(attack); chords.set(key, chord);
  }
  for (const chord of chords.values()) {
    if (chord.length < 2 || chord.some(attack => !attack.brushable)) continue;
    const sign = profiles[chord[0].note.trackId].brush === 'down' ? 1 : -1;
    const ordered = [...chord].sort((a, b) => sign * (a.note.key - b.note.key) || sign * (a.note.source.string - b.note.source.string));
    const shortest = Math.min(...chord.map(attack => attack.note.endTick - attack.note.startTick));
    // Keep the whole spread inside the first half of the shortest note, so no note is lost or reordered past its successor.
    const spacing = Math.min(brushSpacing, Math.floor(shortest / (2 * chord.length)));
    if (spacing < 1) continue;
    ordered.forEach((attack, index) => {
      const delay = index * spacing;
      attack.note.startTick += delay;
      for (const point of attack.note.pitch) point.tick += delay;
    });
  }
  const strings = new Map<string, Attack[]>();
  for (const attack of attacks) {
    if (!profiles[attack.note.trackId].letRing) continue;
    const key = `${attack.note.trackId}/${attack.staff}/${attack.note.source.string}`, line = strings.get(key) ?? [];
    line.push(attack); strings.set(key, line);
  }
  for (const line of strings.values()) {
    line.sort((a, b) => a.note.startTick - b.note.startTick);
    // The next later pluck of each attack, found from the end in one pass.
    let nextPluck = Infinity;
    for (let index = line.length - 1; index >= 0; index--) {
      const note = line[index].note, later = line[index + 1]?.note;
      if (later && later.startTick > note.startTick) nextPluck = later.startTick;
      if (ringless.has(note.articulation)) continue;
      // A string rings until it is plucked again, or until the bar it is in ends.
      const until = Math.min(nextPluck, line[index].occurrenceEnd);
      if (until > note.endTick) note.endTick = until;
    }
  }
  for (const attack of attacks) {
    attack.raw.start = attack.note.startTick; attack.raw.end = attack.note.endTick; attack.raw.velocity = attack.note.velocity;
  }
}
