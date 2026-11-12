import { model } from '@coderline/alphatab';

/**
 * A golpe is a tap on the guitar's body. Playback adds it to its beat as a short General MIDI percussion hit on the
 * percussion channel of the beat's own track; the beat's notes still sound as written. Only sounds the bundled sound
 * bank already holds are used, chosen to read as a knock on wood rather than a drum kit:
 * - thumb, a low and duller knock: 77, Low Wood Block, at 85;
 * - finger or nail, a higher and sharper tap: 37, Side Stick (a dry rim click), at 75.
 * The renderer plays a track's percussion-channel hits from the bank's Standard kit whatever the track's own voice is.
 */
export const GOLPE_CHANNEL = 9;
export const GOLPE_TICKS = 120;
const sounds = new Map<model.GolpeType, { key: number; velocity: number }>([
  [model.GolpeType.Thumb, { key: 77, velocity: 85 }],
  [model.GolpeType.Finger, { key: 37, velocity: 75 }],
]);

/** The bar whose beats a similed bar plays. */
export function playbackBar(bar: model.Bar): model.Bar {
  switch (bar.simileMark) {
    case model.SimileMark.Simple: return bar.previousBar ? playbackBar(bar.previousBar) : bar;
    case model.SimileMark.FirstOfDouble:
    case model.SimileMark.SecondOfDouble: return bar.previousBar?.previousBar ? playbackBar(bar.previousBar.previousBar) : bar;
    default: return bar;
  }
}

export interface GolpeHit { track: number; tick: number; length: number; key: number; velocity: number }

/**
 * The knocks of every golpe beat of a pitched track, one set per played bar. `starts` gives each played bar's first tick
 * on the clock the caller writes in, in playing order, so a repeated bar knocks on every pass. Percussion tracks and
 * grace beats take none. A knock never outlasts its beat.
 */
export function golpeHits(score: model.Score, starts: readonly { bar: number; startTick: number }[]): GolpeHit[] {
  const hits: GolpeHit[] = [];
  for (const { bar: index, startTick } of starts) {
    for (const track of score.tracks) {
      if (track.isPercussion) continue;
      for (const staff of track.staves) {
        const written = staff.bars[index];
        if (!written) continue;
        for (const voice of playbackBar(written).voices) for (const beat of voice.beats) {
          const sound = sounds.get(beat.golpe);
          if (!sound || beat.graceType !== model.GraceType.None || beat.playbackStart < 0) continue;
          hits.push({ track: track.index, tick: startTick + beat.playbackStart, length: Math.max(1, Math.min(GOLPE_TICKS, beat.playbackDuration)), ...sound });
        }
      }
    }
  }
  return hits;
}
