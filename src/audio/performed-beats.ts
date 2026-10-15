import { model, type midi } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import type { PerformedBeat } from './selection-playback-types';

const keyOf = (target: BeatTarget, occurrence: number) => `${target.track}/${target.staff}/${target.bar}/${target.voice}/${target.beat}/${occurrence}`;
function targetOf(beat: model.Beat): BeatTarget {
  const voice = beat.voice, bar = voice.bar, staff = bar.staff;
  return { track: staff.track.index, staff: staff.index, bar: bar.index, voice: voice.index, beat: beat.index };
}
function fail(target: BeatTarget, reason: string): never {
  throw new Error(`Cannot map performed beat (track ${target.track}, staff ${target.staff}, bar ${target.bar}, voice ${target.voice}, beat ${target.beat}): ${reason}.`);
}

// Read the full reference generation's public linked slices; a carried highlight
// is part of the same beat, and the cached first relative range loses repeats.
export function buildPerformedBeats(score: model.Score, lookup: midi.MidiTickLookup, tickShift: number): PerformedBeat[] {
  if (!Number.isFinite(tickShift) || tickShift < 0) throw new Error('Invalid performed-beat tick shift.');
  const counts = new Map<number, number>();
  const duration = lookup.masterBars.length ? lookup.masterBars[lookup.masterBars.length - 1].end + tickShift : 0;
  const grouped = new Map<string, { row: PerformedBeat; beat: model.Beat; parts: [number, number][] }>();
  for (const [index, master] of lookup.masterBars.entries()) {
    const bar = master.masterBar.index, occurrence = counts.get(bar) ?? 0; counts.set(bar, occurrence + 1);
    for (let slice = master.firstBeat; slice; slice = slice.nextBeat) {
      for (const item of slice.highlightedBeats) {
        const beat = item.beat, target = targetOf(beat);
        if (Object.values(target).some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
          || !score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]) fail(target, 'missing canonical address');
        // Relocated grace can belong to the same written bar on its next pass.
        // Test this before accepting the containing bar's equal source index.
        const next = master.nextMasterBar;
        const moved = beat.graceType !== model.GraceType.None && beat.playbackStart < 0 && item.playbackStart >= 0 && next?.masterBar.index === target.bar;
        if (moved ? next !== lookup.masterBars[index + 1] : bar !== target.bar) fail(target, 'unexpected performed occurrence ownership');
        const owningOccurrence = moved ? counts.get(target.bar) ?? 0 : occurrence;
        const startTick = master.start + item.playbackStart + tickShift;
        const sliceStart = master.start + slice.start + tickShift, endTick = master.start + slice.end + tickShift;
        if (![startTick, sliceStart, endTick, duration].every(Number.isFinite) || startTick < 0 || sliceStart < 0 || endTick < startTick || endTick < sliceStart || endTick > duration) fail(target, 'invalid public slice time');
        const key = keyOf(target, owningOccurrence), existing = grouped.get(key);
        if (existing) {
          if (existing.row.startTick !== startTick) fail(target, 'ambiguous repeated start in one occurrence');
          existing.row.endTick = Math.max(existing.row.endTick, endTick);
          existing.parts.push([Math.max(startTick, sliceStart), endTick]);
        } else {
          grouped.set(key, { row: { target, occurrence: owningOccurrence, startTick, endTick, leadInTick: startTick }, beat, parts: [[Math.max(startTick, sliceStart), endTick]] });
        }
      }
    }
  }
  for (const { row, parts } of grouped.values()) {
    parts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = row.startTick;
    for (const part of parts) {
      if (part[0] > end) fail(row.target, 'ambiguous disjoint highlighted slices');
      end = Math.max(end, part[1]);
    }
  }
  for (const { row, beat } of grouped.values()) {
    if (beat.graceType !== model.GraceType.None || beat.voice.bar.simileMark !== model.SimileMark.None) continue;
    for (const grace of beat.graceGroup?.beats ?? []) {
      const attached = grouped.get(keyOf(targetOf(grace), row.occurrence));
      if (attached) row.leadInTick = Math.min(row.leadInTick, attached.row.startTick);
    }
  }
  return [...grouped.values()].map(group => group.row).sort((a, b) => a.startTick - b.startTick || a.target.track - b.target.track || a.target.staff - b.target.staff || a.target.bar - b.target.bar || a.target.voice - b.target.voice || a.target.beat - b.target.beat || a.occurrence - b.occurrence);
}
