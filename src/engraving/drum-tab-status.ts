import type { model } from '@coderline/alphatab';
import type { DrumTabReport } from './drum-tab';

/** The counts already made, per conversion report and then per track: a report is made afresh by every projection, so a count never outlives the score it was made for. */
const counted=new WeakMap<DrumTabReport,WeakMap<model.Track,number>>();

/** How many of `track`'s hits the drum tab leaves off (more than six sounds on one beat, or a sound with no number). Zero when the track is not shown as drum tab. */
export function drumTabLeftOff(track: model.Track | undefined, report: DrumTabReport | undefined): number {
  if (!track || !report) return 0;
  const known = counted.get(report)?.get(track);
  if (known !== undefined) return known;
  const off = new Set([...report.surplusNotes, ...report.unresolvedNotes]);
  let count = 0;
  if (off.size) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) if (off.has(note.id)) count++;
  let perTrack = counted.get(report);
  if (!perTrack) counted.set(report, perTrack = new WeakMap());
  perTrack.set(track, count);
  return count;
}
