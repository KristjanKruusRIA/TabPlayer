import type { model } from '@coderline/alphatab';
import type { DrumTabReport } from './drum-tab';

/** How many of `track`'s hits the drum tab leaves off (more than six sounds on one beat, or a sound with no number). Zero when the track is not shown as drum tab. */
export function drumTabLeftOff(track: model.Track | undefined, report: DrumTabReport | undefined): number {
  if (!track || !report) return 0;
  const off = new Set([...report.surplusNotes, ...report.unresolvedNotes]);
  if (!off.size) return 0;
  let count = 0;
  for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) if (off.has(note.id)) count++;
  return count;
}
