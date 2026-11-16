# GP8 parity P20: the backing stretcher keeps low bass at practice speeds, fourth attempt (2026-11-16)

THE-212, branch `agy/the-212-bass-stretch-2` from `develop` 5940f19. **Nobody has listened to this yet.** Every number
below is a headless render of `BackingVoice` alone (no device, no transport), with synthetic signals generated in the
tests, at a 48 kHz output and from 48 kHz files unless another rate is named, in the release profile. The desktop app,
real music, macOS and Linux were not run. Before and after clips of the synthetic signals at 50% and 75% were rendered
for listening outside the repository; they are not committed.

**Develop figures.** They were measured with the same functions on develop's stretcher: the voice built without the
new low band (`BackingVoice::without_low_band`, a hidden hook for tests), which is develop's code path. The only other
changes on it read the clock rate and the previous grain's position for the low band (unused without it), and make
develop's grain read saturate past `i64::MAX`, which changes nothing below it. Outside `backing.rs` the branch adds
`ReferenceSyncMap::frame_range` in `reference_sync.rs`, which only the low band calls: the frames the map lets through,
as a range. The develop columns of the scorecard
come from `cargo test --release --test audio_backing_bass scorecard -- --ignored --nocapture` with the voices built
that way. The develop figures written into the tests (`DEVELOP_HITS`, `DEVELOP_NOISE`, `DEVELOP_BURSTS` and
`DEVELOP_MID_COHERENCE` in `audio_backing_bass.rs`) were printed by that run. `the_develop_figures_are_develops`
measures them again from develop's code path on every run of the suite and checks they match to the precision they are
written with; it passes on the final commit. Every other comparison with develop builds both voices in the same test.

## The defect, measured

At practice speeds the backing's low bass loses weight and sustained low notes wobble or thin out, worst near 50%.

The stretcher (`backing.rs`) cuts the source into grains of HOP = 256 output frames. It splices each grain onto the
previous one where a correlation of the continuation peaks, within `radius = ceil(256 * step)` source frames of where
it aims (256 at an unshifted 48 kHz file). The `root_cause` test fits, inside each grain, the phase of the tail and
the head the grain crossfades, so it reads the phase step at every splice straight from the output:

| Tone, speed | Splice step (deg) | Drift per grain (deg) | Splices within 10 deg | A crossfade that far apart loses | Tone kept | Power at tone x speed |
| --- | --- | --- | --- | --- | --- | --- |
| 41.2 Hz, 50% | 39.6 | 39.6 | 0% | 0.34 dB | -95.4 dB | 98.4% (20.6 Hz) |
| 41.2 Hz, 60% | 31.6 | 31.6 | 0% | 0.22 dB | -84.6 dB | 98.5% |
| 41.2 Hz, 75% | 19.8 | 19.8 | 0% | 0.09 dB | -60.3 dB | 98.5% |
| 41.2 Hz, 90% | 7.9 | 7.9 | 100% | 0.01 dB | -3.1 dB | 98.4% |
| 55 Hz, 50% | 29.7 | 52.8 | 53% | 0.41 dB | -2.5 dB | 15.4% |
| 55 Hz, 60% | 42.2 | 42.2 | 0% | 0.39 dB | -99.9 dB | 98.3% |
| 55 Hz, 75% | 26.4 | 26.4 | 0% | 0.15 dB | -78.0 dB | 98.5% |
| 55 Hz, 90% | 10.6 | 10.6 | 0% | 0.02 dB | -9.8 dB | 98.4% |
| 82.4 Hz, 50 / 60 / 75% | 1.0 / 3.3 / 0.4 | 79.1 / 63.3 / 39.6 | 100 / 83 / 100% | 0.00 dB | 0.0 dB | 0% |
| 82.4 Hz, 90% | 15.8 | 15.8 | 0% | 0.06 dB | -46.8 dB | 98.5% (74.2 Hz) |
| 110, 220, 440 Hz, all four speeds | 0.0 to 1.4 | 21 to 422 | 100% | 0.00 dB | 0.0 dB | 0% |

**Root cause.**
- **The search lands on its aim.** Where the splice step equals the drift per grain, the search did not find a
  lined-up splice: it landed on its aim. Each grain then starts where the clock is, and the grains play the source at
  the clock's own rate. A sustained low tone comes out at its frequency times the speed (98% of its power there).
- **It is not cancellation in the crossfade.** Two equal sines that far apart lose at most 0.4 dB.
- **Why it happens below about 94 Hz.** A lined-up splice needs a correlation peak, a whole period away from the
  continuation, within the search window, and a match over 256 frames that tells it apart. Below about 94 Hz (a period
  over 512 frames, twice the radius; `f_lock = rate / (2 * radius)`, which is the output rate / 512 heard at the
  output) the window holds less than half a period and the search less than one.
- **So locking depends on the speed.** 41.2 Hz never locks, 55 Hz locks half the time and only at 50%, and 82.4 Hz
  locks everywhere except 90%. Every tone above 94 Hz locks.

**Why the three low-band grain variations could not fix it.**
- **What they tried.** The earlier passes (`9b85a08`, `b0759b1` and the first version) gave the low band its own,
  longer grain and search, so that it could reach a period.
- **Timing errors.** A splice that lines up on a period places the low band only to within half a period of the clock
  (12 ms at 41 Hz), and moves it by that much at any splice. Those passes measured:
  - bass notes arriving 8 to 13 ms early (first pass);
  - notes after a ringing note 15 to 60 ms earlier than develop (third pass);
  - tones on the crossover slipping apart, because two splice rules met there.
- **Pairs of partials.** Two low partials that are not harmonics of one short period (41.2 + 61.7 Hz repeat together
  only every 48 ms) need a splice that lines both up. No grain search reaches that without timing errors of this size.
- **Conclusion.** Any grain stretcher of the low band has these limits, so a fourth variation was not tried.

## The method: the low band from a phase vocoder while the voice stretches

`src-tauri/src/audio/backing/low.rs`:

    out = W(x) - W(low) + V(low)

- **W** is the grain stretcher, unchanged: the same search on the whole signal and the same splices, so everything
  above the low band is develop's output.
- **low** is a zero-phase low-pass of what the grains read (Kaiser, 70 dB):
  - flat to 1.25 `f_lock` and stopped from 4 `f_lock`;
  - decimated by `radius / 16`;
  - computed while playing, one decimated sample at a time as the clock reaches it, into a cache of 4096;
  - `W(low)` is that band read and crossfaded exactly as the grains read and crossfade the source, so the subtraction
    takes out precisely the grains' low band.
- **V** is a phase vocoder on `low`:
  - frames of N = 512 decimated samples, Hann window;
  - one frame per grain centred on the score clock, and two in a grain where V starts afresh or comes back after it
    handed the low band back;
  - the frequency of each spectral peak comes from a second frame DELTA = 8 samples away;
  - identity phase locking: every bin turns with the peak of its lobe;
  - below `pass` = 1.25 `f_lock`, a peak's phase is carried forward at its own frequency, so it keeps its pitch and
    level;
  - above `pass`, where the two bands overlap, the peak is turned to the phase the grains read at, so both halves of
    the crossover add up as before;
  - bins above 6 `f_lock` are zero;
  - both channels turn by one angle (taken from their sum, or from their difference where the channels cancel), and
    each channel has its own real transform. So a channel that is a copy, a negative, or a power-of-two multiple of the
    other stays exactly so; the tests use a right channel of exactly half the left. For other factors the channels
    stay proportional to within float rounding.
- **The frequencies scale with the output rate.** The figures below hold for a 48 kHz output, and are 8% lower for
  44.1 kHz: everything scales with the output rate, since a frame spans 8192 output frames whatever the file's rate
  or key shift.

  | Figure | 48 kHz output | 96 kHz output |
  | --- | --- | --- |
  | `f_lock` | 94 Hz | 188 Hz |
  | `pass` (1.25 `f_lock`) | 117 Hz | 234 Hz |
  | Stop band (4 `f_lock`) | 375 Hz | 750 Hz |
  | Decimated rate | 3 kHz | 6 kHz |
  | Frame length | 170 ms | 85 ms |
  | Partials resolved | 12 Hz apart | about 23 Hz apart |

  There is no scorecard at a 44.1 or 96 kHz output.
- **Attacks** in the low band split it into segments. An attack is short-term power rising past twice the loudest of
  the previous 64 ms, above about -60 dBFS.
  - A frame sees only its own segment, through a window that fades out over 32 decimated samples (11 ms) towards the
    segment's edges. A cut edge would spread a low partial down to 0 Hz and its mirror image.
  - The window's own phase at each partial is taken out of what is carried forward.
  - The grains keep their own low band, with a grain's ramp either side:
    - where a frame they hear would read across an attack;
    - where they read within 8 ms after an attack;
    - where a frame's window has faded at the point they read.
  - Below 40% of the neutral speed the grains hear only frames whose whole window lies inside their segment. A frame
    cut short has a small frequency error that adds up over a long stretch.
  - While V is not heard, its frames start from the phases the grains read at, so it comes in in step with them. When
    it comes back after handing the low band back, the frame that starts its grain is made again from those phases.
- **At the neutral speed** (100% with no key shift) V does not come in, and the output is develop's, bit for bit.
  - When the speed returns to neutral while V is heard, V keeps the low band until the next attack in it, or a seek.
  - Handing it back in the middle of a sustained partial would cross-fade two versions of it whose phases disagree
    (measured: -9.4 dB for 20 ms on a 55 Hz sine at 75% to 100%).
- **Guards** (after two adversarial reviews). V stays out:
  - where the clock is far outside the source, or the grain before was (a map steep enough before its first anchor
    sends the clock beyond any index and back within a grain);
  - when the clock moves slower than 1/32 or faster than 8 times the neutral speed (a jump that is not a seek, or a
    map far too steep);
  - where a grain reads more than 16 source frames per output frame: a file at over 16 times the output rate, or over
    8 times with the key an octave up. The search radius is at its cap there.

  V always leaves over a grain's ramp, never at once. Where it leaves because the clock leapt without a seek, it
  leaves from what its last frame carries into that grain, and makes no frame at the new place. That includes a leap
  far past the audio (a map whose last anchor is misplaced). There the grains' low band at the new place is taken as
  silence, without being read: the low-pass does not reach that far, and the place may lie beyond any index.

  That leave is never heard:
  - V is heard only after a grain near the audio.
  - The clock moves only forwards between seeks: the map rises, and the renderer seeks for every jump and loop. So a
    clock that leapt that far stays past the end.
  - Past the end the voice plays nothing, from the very frame the grain starts on.

  The output falls silent at the same frame as develop's, and from there on it is develop's, bit for bit (checked in
  the leap test). It was the same without the leave too; that was measured once, on the code before, and the test
  does not run it. Only a caller that brought the clock back within the grain without a seek would hear the leave.

  Where a low-pass sum
  is larger than any sum of audio within +12 dBFS can be, or not a number, it is taken again from the samples clipped
  at +12 dBFS. So a damaged file's sample near the largest float, or one that is not a number, leaves nothing behind
  in V.
- **Real time.** Every buffer is made when the voice is built. A grain's work is bounded by counts, not by where the
  clock goes:
  - **Frames:** at most two, each four forward real transforms of 512 and two inverse.
  - **The attack scan's low-pass:** at most a budget of decimated samples, the larger of two parts:
    - **Catch-up:** 2^18 multiplies of the low-pass, which is 2^18 / (2 × taps) samples. For a short low-pass this
      comes to more than 1096 samples: where the search radius is under about 76, as for a 22.05 kHz file an octave
      down, or a 44.1 or 48 kHz file at a 192 kHz device. It is still 2^18 multiplies.
    - **Keeping up with the clock:** twice what the clock moves the scan on. While V is heard, it also covers what a
      change of speed moves the scan on and one attack's search. So V never leaves for want of the scan at a speed it
      follows (with at most one change of speed in a grain). Under the read guard this part never exceeds 1096
      samples: 7.05 million multiplies for the longest low-pass, reached only at 8 times the neutral speed with a file
      at 16 times the output rate.

    So a grain's scan computes at most about max(2^18, 1096 × 2 × taps) multiplies, 7.05 million at most.
  - **Beyond the budget:**
    - One attack's search: at most 48 new samples once the budget is spent. From a fresh start a search and its
      detection take up to 56, the figure the leap test allows.
    - The grains' crossfade reads of the low band: up to 108 samples where all three read ranges are new. A leave
      reads two of them, 72 at most, the figure the leap test allows.
  - **The scan's steps:** over at most three quarters of the cache.

  Starting afresh needs about 850 decimated samples before V can come in. That happens after a seek, a loop, or a
  return from the neutral speed into audio the low band has not computed. Done at once, it would cost 0.5 ms in one
  128-frame callback at 48 kHz and 2.3 ms for a 192 or 384 kHz file an octave up, against the 2.67 ms the callback
  has. The budget spreads it over grains instead; until the scan has caught up, the grains keep their own low band, as
  on develop. A clock that leaps without a seek while V is heard is handled the same way: V leaves over that grain
  without a new frame, and comes back once the scan has caught up.

  Counted in `cost_of_a_second_of_audio` and the tests: the most any one grain computed was:

  | Case | Decimated samples | Multiplies |
  | --- | --- | --- |
  | 48 kHz | 370 | 0.30 million |
  | 48 kHz, an octave down | 666 | 0.27 million |
  | 192 kHz file, an octave up | 87 | 0.56 million |
  | 384 kHz file, an octave up | 87 | 0.56 million |

  Never more than two frames.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| A fourth low-band grain variation (longer grain, wider search, period lock) | The limits above: half-period timing errors, two splice rules at the crossover, pairs without a short common period |
| A phase vocoder for the whole band, or instead of the grains | Phasiness and smeared attacks in the mids and highs, where the grains already lock (every tone from 110 Hz up); the transient row must not get worse |
| Carrying peaks forward from `f_lock` (94 Hz) rather than 1.25 `f_lock` | 110 Hz at 10% speed reached -54.6 dB against the existing test's -55.6, and lost what V gains at 110 Hz |
| A cut edge on frames at an attack | Off the tone right after every attack: a step edge spreads a low partial to 0 Hz and its mirror image |
| Edge fades of 48 or 64 samples | 82 Hz at 10% failed the existing quality test |
| DELTA of 32 or 64 samples | Worse on the 55 + 82 Hz pair |
| Both channels packed in one complex transform | A right channel that is an exact multiple of the left no longer stayed exact; `backing_processing` failed |
| V hearing faded frames at every speed | 110 Hz at 10% speed: -16 dB, then -52 dB with the edge fade and -47 dB with the window-phase correction, against -55.6; hence whole windows below 40% |
| Carrying phases through frames while V is not heard | A -8 dB dip where V came in; V now starts from the grains' phases |
| Handing the low band back to the grains as soon as the speed is neutral | -9.4 dB for 20 ms at the change |
| Gliding V's phases to the grains' before handing back | Not built: up to half a turn per partial is a pitch bend on a bass note (about 23 Hz over 21 ms, or a semitone over 0.2 s) |
| Making V's frames at the new place when the clock leaps without a seek | Unbounded work in one grain (203 to 1508 decimated samples, up to 9.7 million multiplies, in the leap test); V now leaves from what it carries |
| Replacing only non-finite low-pass values | A finite sample near the largest float still put a pulse of +710 dB into every frame that spanned it; the sum is now taken from clipped samples |

## Scorecard

One fixed scorecard (`audio_backing_bass.rs`, ignored tests `scorecard`, `root_cause` and
`cost_of_a_second_of_audio`), every row at 50, 60, 75 and 90%, develop / this branch. Rows (a) to (f) were measured
again on the final code and did not change by a digit from the first version of this note.

### (a) Low-band energy

The 30-150 Hz power of the output against the unstretched source, and the share of the source's low spectrum the
output has at the same frequencies ("at its pitch"; a bass moved to another pitch keeps its power and loses this).
Cells are dB, power / at its pitch.

| Signal | 50% | 60% | 75% | 90% |
| --- | --- | --- | --- | --- |
| sine 41.2 Hz | -37.45 / -33.66 → +0.01 / -0.00 | -32.80 / -27.41 → +0.00 / -0.00 | -0.10 / -8.10 → +0.00 / -0.00 | -0.01 / -2.83 → +0.00 / -0.00 |
| sine 55 Hz | -1.51 / -2.91 → 0.00 / -0.00 | -0.40 / -29.96 → 0.00 / -0.00 | -0.15 / -14.34 → 0.00 / -0.00 | -0.02 / -3.06 → -0.00 / -0.00 |
| sine 82.4 Hz | +0.00 / -0.21 → 0.00 / -0.00 | -0.01 / -0.82 → 0.00 / -0.00 | +0.00 / -0.10 → 0.00 / -0.00 | -0.05 / -7.40 → 0.00 / -0.00 |
| pair 55 + 82.4 Hz | -0.46 / -4.82 → +0.01 / -0.01 | -0.46 / -4.02 → +0.01 / -0.01 | -0.62 / -2.66 → +0.01 / -0.01 | -0.33 / -1.73 → +0.00 / -0.01 |
| pair 41.2 + 61.7 Hz | -2.10 / -4.66 → -0.28 / -0.29 | -2.87 / -5.34 → -0.29 / -0.29 | -0.92 / -3.53 → -0.29 / -0.28 | -0.22 / -1.96 → -0.29 / -0.29 |
| bass line (E1 A1 D2 E1) | -2.75 / -3.12 → -0.14 / -0.35 | -2.56 / -3.18 → -0.20 / -0.39 | -0.28 / -2.32 → +0.01 / -0.23 | -0.15 / -1.61 → -0.06 / -0.30 |
| kick + note | -1.48 / -1.98 → -0.04 / -0.27 | -1.24 / -3.29 → -0.07 / -0.27 | -0.21 / -2.65 → +0.06 / -0.31 | -0.00 / -0.80 → +0.08 / -0.25 |
| noise | -1.67 / -1.81 → -0.32 / -0.39 | -1.91 / -2.06 → -0.32 / -0.66 | -0.78 / -0.92 → -0.18 / -0.25 | -0.84 / -0.97 → -0.27 / -0.52 |
| mix | -2.32 / -2.79 → -0.20 / -0.35 | -2.10 / -2.64 → -0.18 / -0.33 | -0.31 / -2.12 → -0.07 / -0.32 | -0.16 / -1.14 → -0.03 / -0.13 |

### (b) Amplitude modulation and flutter

A sustained tone or pair, measured three ways:
- swing: the largest slow swing of each tone's amplitude (100 ms windows every 10 ms, dB);
- level: the worst tone's level error (dB);
- off: the energy off the tones over 0.5 s (dB, lower is purer).

Cells are swing / level / off.

| Signal | 50% | 60% | 75% | 90% |
| --- | --- | --- | --- | --- |
| sine 41.2 Hz | 0.00 / -14.01 / -0.0 → 0.00 / 0.00 / -85.4 | 0.01 / -8.29 / -0.0 → 0.00 / 0.00 / -86.1 | 0.00 / -2.77 / -0.0 → 0.00 / 0.00 / -86.4 | 0.00 / -0.13 / -3.0 → 0.00 / 0.00 / -86.7 |
| sine 55 Hz | 9.22 / -2.61 / -1.9 → 0.00 / 0.00 / -73.9 | 0.00 / -17.67 / -0.0 → 0.00 / 0.00 / -74.8 | 0.00 / -6.07 / -0.0 → 0.00 / 0.00 / -75.3 | 0.00 / -0.39 / -0.5 → 0.00 / 0.00 / -75.5 |
| sine 82.4 Hz | 0.01 / -0.01 / -28.1 → 0.00 / 0.00 / -96.7 | 0.03 / -0.04 / -22.2 → 0.00 / 0.00 / -94.1 | 0.00 / 0.00 / -34.5 → 0.00 / 0.00 / -96.8 | 0.00 / -1.59 / -0.0 → 0.00 / 0.00 / -91.1 |
| pair 55 + 82.4 Hz | 25.12 / -6.45 / -1.8 → 0.04 / +0.03 / -51.6 | 22.37 / -3.78 / -1.0 → 0.05 / +0.03 / -50.0 | 12.58 / -3.87 / -2.3 → 0.05 / +0.03 / -49.7 | 14.28 / -1.51 / -4.5 → 0.07 / +0.03 / -50.3 |
| pair 41.2 + 61.7 Hz | 34.93 / -4.78 / -0.7 → 0.78 / -0.62 / -25.6 | 26.65 / -12.71 / -1.2 → 0.92 / -0.60 / -25.7 | 39.31 / -5.39 / -1.5 → 1.12 / -0.59 / -26.0 | 14.77 / -1.51 / -1.2 → 1.24 / -0.58 / -32.0 |

At 100% both are the source (swing 0, off -150 dB).

### (c) Transients

Medians over the hits, three figures per cell:
- pre-echo: energy before the clock's onset against after it, dB; -300 is none;
- attack: 10 to 90% of the 1 ms envelope, ms;
- onset against the clock: ms, negative is early.

**Identical to develop in every cell except two:** the kick below 150 Hz at 60% (pre-echo -44.3 → -44.2 dB) and at
90% (none → -141 dB, far below hearing).

| Hit | 50% | 60% | 75% | 90% |
| --- | --- | --- | --- | --- |
| kick, full band | -7.9 dB, 1.52 ms, -3.73 ms | -10.6, 1.48, -2.10 | -29.3, 1.65, -0.65 | none, 1.54, -0.08 |
| kick, below 150 Hz | -25.3, 7.33, -4.00 | -44.3 (-44.2), 7.10, -2.42 | -112.1, 7.04, -0.90 | none (-141.0), 7.02, -0.27 |
| beater click over a note, above 500 Hz | 1.0, 1.21, -6.60 | 3.0, 8.48, -10.88 | 0.1, 8.48, -8.06 | 13.2, 1.06, -6.15 |
| drum hit | -4.8, 0.88, -3.33 | -8.3, 2.67, -2.08 | -9.4, 0.88, -0.67 | none, 1.77, -0.27 |
| plucked 82 Hz | -8.3, 1.23, -3.33 | -13.3, 16.12, -2.10 | -14.1, 1.17, -0.67 | none, 2.52, -0.27 |

### (d) Mid and high band energy and noise flatness

White noise. Cells give the band power against the source (dB) in 30-150, 150-500, 500-4000 and 4000-16000 Hz, then
the change of spectral flatness over 100-16000 Hz (dB).

| Speed | develop | this branch |
| --- | --- | --- |
| 50% | -1.58, -0.57, -0.66, -2.08; flatness -0.13 | -0.22, -0.57, -0.66, -2.08; -0.13 |
| 60% | -1.82, -1.44, -1.43, -2.64; -0.09 | -0.23, -1.42, -1.43, -2.64; -0.09 |
| 75% | -0.68, -0.30, -0.35, -1.12; -0.03 | -0.11, -0.30, -0.35, -1.12; -0.03 |
| 90% | -0.70, -1.35, -1.36, -2.64; -0.10 | -0.14, -1.31, -1.36, -2.64; -0.11 |

### (e) Alignment

The worst energy-centroid error of Hann-windowed bursts against the score clock (ms, negative is early). The 1 kHz and
noise bursts are identical to develop. The 200 ms burst of 55 Hz moves onto the clock.

| Speed | 1 kHz, 40 ms | 1 kHz, 200 ms | noise, 40 ms | 55 Hz, 200 ms: develop → this branch |
| --- | --- | --- | --- | --- |
| 50% | -0.25 | -0.01 | -1.95 | -2.01 → -0.41 |
| 60% | -0.35 | -0.08 | -1.99 | -5.38 → -1.15 |
| 75% | -0.24 | -0.00 | -3.50 | -5.39 → -1.78 |
| 90% | -0.19 | -0.04 | +1.68 | -5.08 → -1.38 |

The existing alignment suite (`audio_backing_alignment`, 12 tests) passes unchanged.

### (f) Stereo coherence and mono

The test signals:
- a busy mix whose right channel is exactly half its left (proportional channels);
- a low pair the same in both channels (right 0.9 of left);
- noise correlated 0.6 between the channels;
- a 55 Hz tone whose right channel lags 60 degrees.

Source: low coherence 0.9997, mid (500-4000 Hz) coherence 0.3716, low mono sum -0.01 dB.

| Speed | Proportional channels, largest error | Low coherence | Low mono sum | 55 Hz phase between channels, error | Mid coherence |
| --- | --- | --- | --- | --- | --- |
| 50% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | +0.3 → -0.0 deg | 0.3728 → 0.3710 |
| 60% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -217.5 → -0.0 deg | 0.3726 → 0.3709 |
| 75% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -0.0 → -0.0 deg | 0.3719 → 0.3716 |
| 90% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -0.0 → -0.0 deg | 0.3784 → 0.3782 |

### (g) CPU

One thread, release profile (`cost_of_a_second_of_audio`): a stereo mix (bass line, kicks, chord, hiss) played to a
48 kHz output. The last four rows play the mix from files at 192 and 384 kHz (interpolated) an octave up: the steepest
reads V takes. The test measures:
- **Milliseconds per second of audio:** the median of five runs of 10 s.
- **The slowest 128-frame block after a seek** (one device callback of 2.67 ms): among the first 16384 output frames
  after a seek, in microseconds, median and worst of 41 seeks. The 16384 frames are 64 grains, which hold the grain
  where the scan catches up (the 3rd to 7th at 48 kHz, the 20th to 31st for the 192 and 384 kHz files) and V's first
  frames. The seeks jump 4.8 s forward or 10.4 s back, so nothing the low band computed before is near: a cold start,
  the costliest case.
- **About a second later:** the same 16384 frames from 47 000 frames after the seek.
- **The most work in one grain:** the low-pass's decimated samples and V's frames, counted in each window.

Develop is the same voice without the low band, measured in the same run, row by row, on the final code. One row
(192 kHz, 75%) was disturbed in that run: its five runs of 10 s spanned 19.05 to 30.15 ms. A repeat run of the whole
test gave that row as 11.55 → 19.27 ms, with a block median of 63 → 261 us after a seek and 66 → 203 us later; the
other rows of the repeat were within the noise of these.

| File, speed, key shift | ms per second: develop → this branch | Slowest block after a seek, median (worst): develop → this branch | About a second later, median (worst) | Most in one grain: after a seek / later |
| --- | --- | --- | --- | --- |
| 48 kHz, 100%, 0 | 7.98 → 7.99 | 49 (1006) → 48 (105) | 51 (137) → 49 (120) | none |
| 48 kHz, 50%, 0 | 7.96 → 13.82 | 45 (97) → 226 (980) | 44 (1022) → 88 (943) | 370, 2 / 53, 2 |
| 48 kHz, 60%, 0 | 7.85 → 14.01 | 44 (1361) → 228 (1213) | 44 (88) → 91 (891) | 369, 2 / 57, 2 |
| 48 kHz, 75%, 0 | 7.93 → 14.40 | 44 (104) → 228 (1652) | 44 (67) → 92 (174) | 366, 2 / 59, 2 |
| 48 kHz, 90%, 0 | 8.01 → 14.83 | 46 (1056) → 230 (1175) | 46 (137) → 95 (598) | 364, 2 / 62, 2 |
| 48 kHz, 50%, +12 | 8.31 → 13.57 | 49 (121) → 193 (316) | 48 (116) → 96 (1049) | 207, 2 / 51, 2 |
| 48 kHz, 100%, -12 | 4.42 → 12.18 | 28 (108) → 298 (895) | 28 (582) → 83 (103) | 659, 2 / 79, 2 |
| 48 kHz, 300%, +12 | 8.26 → 17.73 | 50 (1407) → 204 (828) | 51 (242) → 120 (440) | 208, 2 / 71, 2 |
| 48 kHz, 300%, -12 | 4.55 → 17.40 | 26 (42) → 299 (1363) | 26 (1547) → 114 (173) | 666, 2 / 142, 2 |
| 192 kHz, 50%, +12 | 11.23 → 17.82 | 67 (152) → 252 (920) | 63 (1116) → 154 (217) | 87, 2 / 51, 2 |
| 192 kHz, 75%, +12 (disturbed) | 12.65 → 20.50 | 64 (153) → 404 (1853) | 64 (1208) → 206 (899) | 85, 2 / 54, 2 |
| 384 kHz, 50%, +12 | 11.27 → 20.40 | 67 (1474) → 219 (1544) | 68 (1593) → 168 (1529) | 87, 2 / 53, 2 |
| 384 kHz, 75%, +12 | 11.39 → 22.56 | 72 (1434) → 269 (2254) | 72 (936) → 197 (299) | 87, 2 / 59, 2 |

**Single worst blocks of 0.8 to 2.3 ms are not explained by the stretcher's work.** They were not traced to the
operating system either: no system trace was taken. The evidence:
- **Develop's own code has them.** In the same run, develop's code path had worst blocks of 936 to 1593 us on ten
  rows, against medians of 26 to 72 us.
- **So does the 100% row.** At 100% this branch runs develop's code, bit for bit; in the repeat run it had a worst
  block of 1156 us.
- **They move between runs.** In the repeat run, and in two earlier runs of the same test, they fell on other rows
  each time.
- **The work is counted.** The stretcher's own work per grain is bounded (the last column), and the block medians
  show what it costs: 0.19 to 0.30 ms after a seek. A worst block of five times the median is not more of that work.

Before the scan was spread over grains (same seeks, an earlier session), the slowest block after a cold seek was:
- 517 to 522 us at 48 kHz and 50 to 90% (549 to 576 worst);
- 760 us at +12 and 786 us at 300% +12;
- 2256 to 2293 us for the 192 and 384 kHz files (5598 worst): close to or over a whole 128-frame callback.

The seek tests of the earlier commits did not show it, since their seeks landed where the low band had already been
computed. Spreading the work delays V after a cold seek. A probe (not committed) found the first grain after the seek
in which V made frames, on a 55 Hz sine at 50, 75 and 90%:
- the 3rd to 7th grain at 44.1 and 48 kHz (16 to 37 ms of output);
- the 13th or 14th for a 96 kHz file an octave up (69 to 75 ms);
- the 20th to 31st for the 192 and 384 kHz files an octave up (107 to 165 ms).

Building the voice takes 7 to 9 ms at 48 kHz on both, about 13 ms for the 192 kHz file and 24 to 34 ms for the
384 kHz file.

### Speed change while playing

A steady 55 Hz sine at 75%, 100%, 75%, 100%: the worst level of any 20 ms against the source. Develop is -1.39 dB (its
wobble at 75%); this branch stays within 0.05 dB through every change.

## Tests

New in `src-tauri/tests/audio_backing_bass.rs`. The bass rows fail on develop and pass here; the other rows hold
develop's own figures, measured with these functions, within the margins stated in each test.

- `sustained_low_tones_keep_their_pitch_level_and_steadiness` (a, b): swing, level and off-tone limits per tone set.
  - Sines: 0.5 dB, 0.5 dB, -60 dB.
  - 55 + 82.4 Hz: 1.0, 0.5, -40.
  - 41.2 + 61.7 Hz: 2.5, 1.0, -20.
  - Develop: the 41.2 Hz sine is 14 dB down at 50%, and the pairs swing 12 to 39 dB.
- `the_low_band_keeps_its_power_at_its_own_pitch` (a): five signals at 50 and 75%. Power within 1 dB, and at least
  -1 dB at its pitch. Develop: -33.7 dB for the 41.2 Hz sine.
- `transients_are_no_worse_than_before` (c): pre-echo at most 1 dB more than develop (or under -60 dB), attack at most
  0.5 ms slower, onset within 0.5 ms. Passes on both.
- `noise_keeps_its_bands_and_flatness` (d): the 150-16000 Hz bands within 0.25 dB of develop, flatness no more than
  0.05 dB lower, and the lowest band within 1 dB of the source. Develop loses up to 2 dB there.
- `bursts_stay_on_the_score_clock` (e): within 0.25 ms of develop's errors, and the 55 Hz burst within 2.5 ms.
  Develop: 5.4 ms early.
- `the_stereo_image_and_the_mono_sum_are_kept` (f). Develop: -217.5 degrees at 60%. The limits:
  - proportional channels exactly so;
  - phase within 0.5 degrees;
  - low coherence within 0.002 of the source;
  - mono within 0.1 dB;
  - mid coherence within 0.005 of develop.
- `changing_the_speed_while_playing_makes_no_level_jump`: every 20 ms within 1 dB. Develop: -1.39 dB.
- `handing_the_low_band_over_and_back_keeps_the_level`: the level at V's hand-ins and hand-outs.
  - The signal: notes of one pitch every 0.37 s, each starting over 3 ms and dying away over 0.3 s. The speed changes
    every 1499 output frames, among 20 to 100%.
  - The measure: the note's level at its own pitch in every 10 ms window, outside the 20 ms after an attack, against
    the exact level in the source at the score clock.
  - 110 and 100 Hz, which the grains splice coherently: no window more than 0.25 dB under (this branch: 0.11 dB),
    except where develop's grains are too.
  - Below the grains' reach the hand-over dips, because V and the grains carry the tone at phases that disagree, and
    its deepest window is deeper than develop's:
    - 82.4 Hz: the deepest window -2.89 dB, none under -3 dB (develop: -0.78 dB, none);
    - 55 Hz: -6.45 dB, with 8 of 507 windows under -3 dB (develop: -4.83 dB, 25 of 507).

    The bounds on the deepest window (-3.25 and -7.0 dB) are this branch's own measured values; the test's comment says
    so. The count of windows under -3 dB is bounded by this branch's own values (none, 10) and by develop's count. See
    the limits.
- `leaving_and_coming_back_on_consecutive_grains_makes_no_level_dip`: V leaves in one grain and comes back in the
  next. The signal is a sustained tone at 100 and 110 Hz, with five patterns of 35% grains among 45%, from 25 to 90 ms
  after the attack. Every 20 ms window is within 0.05 dB (measured: 0.02 dB).
  - It passes without the frame made again too (see the next test). On a sustained tone at those pitches, V's own
    phase stays in step with the grains', so there was no dip to see.
- `coming_back_after_one_grain_starts_from_the_grains_phases`: the frame made again when V comes back. When V comes
  back in the grain after it left, the frame whose second half carries into that grain is made again from the grains'
  phases.
  - The signal: a sustained tone at 61.7, 55 and 41.2 Hz, played at 45% with one grain at 35%, at each of the 30
    grains from 25 ms after the attack. The measure: the deepest 10 ms window at the tone's own pitch.

  | Tone | Bound: mean of the deepest | This branch | Without the frame made again | Develop | Bound: positions deeper | This branch | Without | Develop |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 61.7 Hz | -1.6 dB | -1.39 dB | -1.82 dB | -3.89 dB | 3 deeper than 3 dB | 2 | 6 | 30 |
  | 55 Hz | -4.3 dB | -3.99 dB | -4.65 dB | -4.74 dB | 8 deeper than 6 dB | 7 | 10 | 0 |
  | 41.2 Hz | -6.5 dB | -6.26 dB | -6.77 dB | -7.41 dB | 11 deeper than 6 dB | 10 | 13 | 30 |

  - The mean must also be no lower than develop's.
  - No position may dip deeper than -8.0, -12.5 and -25.5 dB, this branch's own values: it measured -7.50, -11.95 and
    -24.49 dB.
  - It fails without the frame made again: at 61.7 Hz the mean of the deepest is -1.82 dB, with 6 positions deeper
    than 3 dB.
  - The bounds are this branch's own measured values. The frame made again is not better everywhere: at 41.2 Hz it
    dips deeper at 5 of the 30 positions, and shallower at 14.
  - The deepest single windows are far deeper than develop's: -7.50, -11.95 and -24.49 dB, against develop's -3.95,
    -4.92 and -8.75 dB. See the limits.
- `the_develop_figures_are_develops`: develop's figures in the tests above, measured again from develop's code path.

`src-tauri/tests/audio_backing_realtime.rs`:

- `rendering_seeking_and_changing_speed_allocate_nothing`: a counting global allocator, with a check that it counts.
  - It covers:
    - rendering at 50, 100, 75, neutral, 300, 10, 90 and 100%;
    - loop-wrap seeks, and clock jumps that are not seeks;
    - 60 speed changes every 700 frames, mid-hop, to and from neutral;
    - 44.1, 48 and 96 kHz, with key shifts 0, -5, +7 and +12;
    - a sustained bass with clicks, and kicks and plucks from silence.
  - No allocation, and the sustained 41.2 Hz bass keeps its level within 1 dB at its own pitch (develop: -21 dB).
- `extreme_maps_and_rates_neither_stall_nor_panic`. It covers offsets of plus and minus 1e22 ms, and these files at
  10 to 300%:
  - a file at 6.144 MHz;
  - a file at 768 kHz, +12, at a 22.05 kHz output;
  - a file at 384 kHz, +12, the steepest read V still takes.

  What it catches:
  - Without the read guard, the 6.144 MHz file panics (index out of bounds).
  - Without the clock guards, the review found that a 1e22 ms offset makes the attack scan loop without end in
    release. That was not run, since it would hang the test.
  - In the debug test profile, the 1e22 ms offset also hit develop's own grain read (`sample`). A position past what
    an i64 holds floors to `i64::MAX`, and the next index overflowed; release wraps it to silence. That read now
    saturates, which changes nothing below `i64::MAX`.
- `speed_changes_near_attacks_never_click`: low notes every 0.37 s, with the speed changing every 1499 frames among
  20 to 100%, across the 40% line, unshifted and at +7. No step from one output frame to the next may be larger than
  the largest develop's grains make of the same notes, nor reach 0.008. This branch: 0.0069 unshifted and 0.0072 at +7,
  the same steps develop's grains make at the same frames; the source's largest is under 0.02. Before, V left over its
  ramp only some of the time, and made a step of 0.51.
- `a_clock_that_leaps_without_a_seek_stays_within_a_grains_budget`: a sync map 100 times steeper than the speed for
  10 ms of score, and a jump of the clock, while V is heard. Each is also run so that it lands past the end of the
  audio: 2 s past it with the map, 0.98 s with the jump. It runs at 48 kHz and for files at 192 and 384 kHz an octave
  up. The work is counted, not timed.
  - No grain across the leap computes more than the worst grain after a cold seek, plus one attack's search (56
    samples, which a grain may always compute while V is heard), plus its own crossfade reads (72 at most). No grain
    makes more than two frames, and V leaves once.
  - The tone's level before and after is within 0.1 dB.
  - The largest step across the leap is at most a quarter more than develop's (this branch: 13% more at most).
  - Measured across the leap: 344 samples at 48 kHz (324 after a seek), 40 to 102 at 192 kHz (40 after a seek), and
    76 to 126 at 384 kHz (40).
  - On 0b3d7cc the grain where the clock leapt computed everything up to the new place at once: 203 to 1508 samples
    (0.36 to 9.7 million multiplies). The test failed there.
  - **Past the end of the audio:**
    - The same work bound holds: 0 to 8 samples in a grain, at most one frame.
    - V leaves once, over a grain. On 9a7c696 V stopped at once there, without counting a leave, and the test fails
      on that count.
    - The output falls silent at the same frame as develop's. From there on it is develop's, bit for bit. With the
      jump that is from the first frame after it, so there the test checks only the work and the leave.
    - The audio rendered on the code before was the same, bit for bit (measured once with a hash; the test does not
      run that code). The clock stays past the end, where the voice plays nothing, so the step a review predicted
      there cannot be heard.
    - The step into that silence is develop's own cut, so it is not compared with develop's. Its size is where the tone
      is in its cycle at that frame, and V's phase differs from the grains'. Measured: 0.39 against develop's 0.35 at
      48 kHz, 0.006 against 0.012 at 192 kHz, and 0.40 against 0.19 at 384 kHz.
- `samples_near_the_largest_float_leave_nothing_behind`: one sample of 3e38, sixteen of plus and minus 3e38, and
  sixteen that are not numbers, in a 55 Hz tone, unshifted and at +7.
  - The output stays finite.
  - It is out of range for no more frames than develop's (91 and 53, the same).
  - Every 20 ms window where develop is in range is within 1 dB (measured: 0.46 dB), and the tone ends at 0.00 dB.
  - On 0b3d7cc: 16 985 frames out of range at up to +710 dB, then silence.
- `the_vocoder_never_leaves_for_want_of_the_scan_at_a_speed_it_follows`: plucked low notes at 48 kHz and from files
  at 192 and 384 kHz, unshifted and an octave up. It plays at steady 50% and 75%, and with the speed jumping mid-grain
  between 10 and 300% and between 25 and 200%. V must never leave because the scan ran out of a grain's budget.
  - On 317b4d4, for the 192 kHz file an octave up at half speed, V left 8 times in 3 s of output, ahead of the notes.
- `a_grain_after_one_beyond_any_index_does_not_overflow`: anchors 1e-30 of a bar apart make the slope before the first
  one about 5e29.
  - The clock passes from beyond any index onto the audio at half speed.
  - No overflow in the debug profile, a finite output, and the tone within 0.1 dB afterwards.
  - On 317b4d4 the debug build panicked (`attempt to subtract with overflow` in the scan).

Unit tests in `low.rs`: the real transform against its definition and its inverse, and the low-pass's response.

Existing suites all pass, release and debug:
- `audio_backing` 6;
- `audio_backing_alignment` 12;
- `audio_backing_stretch` 9 (2 ignored tables);
- `backing_processing` 14, including bit-identity at 100% and of proportional channels;
- `backing_processing_protocol` 6;
- `backing_waveform` 5;
- library backing tests 41.

## Final verification

Run on ba59e20, the final code.

- `cargo fmt --all -- --check`: clean.
- `cargo test --locked --workspace --no-fail-fast`, debug: 98 test programs; 2084 passed, 0 failed, 99 ignored.
- `selected_real_100bar_fourtrack_resource_budget` (`audio_resources`, ignored, release): passed in 3.01 s.
- The five `audio_backing*` suites in release, all passed:
  - `audio_backing` 6;
  - `audio_backing_alignment` 12;
  - `audio_backing_bass` 11, with 3 ignored tables;
  - `audio_backing_realtime` 7;
  - `audio_backing_stretch` 9, with 2 ignored tables.
- Two compiler warnings come from develop's code, not this branch: `list_inputs` is unused in a release build, and a
  `mut` in `audio_backing_stretch.rs` is not needed.
- The listening clips were rendered again from ba59e20 into a separate folder for a check. All 28 are byte-identical
  to the clips in `stretch2-listen`, so the changes since 87247e7 do not change the output for the synthetic signals,
  and the clips were not replaced.

## Review

A fresh-context, read-only reviewer was briefed to break the change.

1. **0b3d7cc: changes needed.**
   - One grain was unbudgeted when the clock leapt.
   - One bad sample silenced the backing.
   - The level dipped on a leave and a return.
   - The click threshold was loose.
   - The note needed corrections.

   All fixed in 317b4d4.
2. **317b4d4: changes needed.**
   - The scan's budget fell short of a clock that V follows at high file rates.
   - The check on the grain before could overflow in the debug profile.

   Both fixed in 2659b65, with a failing-first test for each.
3. **2659b65: changes needed.** A stale rate made the first grains after a seek compute more than they need. Fixed
   in 864d396.
4. **864d396: approved.** Its two nits are fixed in 87247e7: the ceiling is now stated as 1096 samples, and a comment
   is rewrapped.
5. **A further fresh review of 0b3d7cc..9a7c696: changes needed.**
   - V stopped at once when the clock leapt far past the audio.
   - The note overstated the cap on the scan's budget.
   - No test failed without the frame made again when V comes back.
   - The hand-over bounds should be relative to develop where that is honest.

   All addressed in 6919987. The leap far past the audio turned out not to be audible: the output there is develop's,
   bit for bit, with or without the leave (see the leap test). The leave was made anyway, so V leaves over a grain
   everywhere.
6. **6919987: approved by a new reviewer.** It had two suggestions: keep the 55 Hz count bound at this branch's own
   value, and bound the deepest single position in the new test. Both are in ba59e20, which the same reviewer
   approved.

## Limits

- **Nobody has listened.** The clips need the owner's ears. They were rendered again from the final code: sine
  41.2 Hz, the two pairs, the bass line, kicks over a 55 Hz bed, the mix and the stereo signal, before and after, at
  50% and 75%, level-matched.
- **CPU is higher than develop's:**
  - 1.8 times at practice speeds (7.9 to 8.0 → 13.8 to 14.8 ms per second of audio at 48 kHz);
  - twice at 300% an octave up;
  - 2.8 to 3.8 times with the key an octave down (4.4 to 4.6 → 12.2 to 17.4);
  - 1.6 to 2.0 times for 192 and 384 kHz files an octave up (11.2 to 11.6 → 17.8 to 22.6).

  That is 1.2 to 2.3% of one core per backing. The slowest 128-frame callback after a cold seek carries 0.19 to
  0.30 ms of the backing (develop: 0.03 to 0.07 ms), and 0.08 to 0.21 ms about a second later.
- **After a seek into audio the low band has not computed**, V comes in later than it would with all the work done at
  once. The same holds for a loop that long, or the speed leaving 100% there.
  - When: the 3rd to 7th grain after the seek at 44.1 and 48 kHz (16 to 37 ms), the 13th or 14th for a 96 kHz file
    an octave up (69 to 75 ms), and the 20th to 31st for 192 and 384 kHz files an octave up (107 to 165 ms).
  - Until then the bass is develop's.
  - The scan's budget always covers what a clock V follows needs, so it cannot fall behind for good.
- **A clock that leaps without a seek while V is heard** makes V leave over that grain, from what its last frame
  carries, and the bass is develop's until the scan has caught up. Such a leap is a sync map steeper than 8 times the
  neutral speed, which the anchors allow, or a jump. The leap test covers a steep map and a jump, each also landing
  past the end of the audio, where the voice is silent; nothing else about how often real maps do this was measured.
- **Near attacks the low band is the grains'.** That covers:
  - about 8 ms after a low attack;
  - where a frame they would hear reads across one;
  - where its window has faded (about 17 to 20 ms of source from an attack at 40% and up).

  Below 40% of the speed the grains hear only whole windows, so the bass is develop's for about 96 ms of source after
  each low attack (0.27 to 0.96 s of playing at 10 to 35%).
- **Hand-overs below about 94 Hz dip for a moment, deeper than develop's.** Where V hands the low band to the grains,
  or takes it back, a tone the grains cannot splice coherently is carried at phases that disagree, and the hand-over
  crossfades the two. Measured in 10 ms windows at the tone's own pitch:
  - **Notes with the speed changing** (the hand-over test):
    - 82.4 Hz: down to -2.89 dB (develop: -0.78 dB);
    - 55 Hz: down to -6.45 dB, with 8 windows of 507 under -3 dB (develop: -4.83 dB, 25 windows).
  - **V out for one grain** soon after an attack (45% with one grain at 35%, at 30 positions):
    - on average shallower than develop: the mean of the deepest windows is -1.39, -3.99 and -6.26 dB at 61.7, 55 and
      41.2 Hz, against develop's -3.89, -4.74 and -7.41 dB;
    - at single positions far deeper: -7.50, -11.95 and -24.49 dB, against develop's -3.95, -4.92 and -8.75 dB at
      worst;
    - the deep dips last about one 10 ms window.

  Whether they are audible needs the owner's ear. The bounds the tests hold for these dips are this branch's own
  measured values. Two are also compared with develop: the count of windows under -3 dB, and the mean over the 30
  positions.
- **At the end of the audio** the voice falls silent at once, as develop's does. The size of that cut is where the tone
  is in its cycle at that frame, and V's phase differs from the grains'. So at a given frame it can be larger or
  smaller than develop's: 0.40 against 0.19 at 384 kHz in the leap test, and 0.006 against 0.012 at 192 kHz.
- **Not measured:**
  - **Note changes without an attack.** A legato or slid bass note change, a hammer-on, or a sustained synth bass
    changing note at a steady level never triggers the attack detector. V's 170 ms frame then spans both notes, so the
    change may smear, or the old note may ring briefly into the new one.
  - **Note releases.** A note that stops or is muted with no new attack, where V's frame spans the end, may fade
    rather than stop.
  - **Phasiness on low-band noise.** This covers the low rumble of drums and noise. Row (d) measures its power and
    flatness, not how it sounds.
- **The 41.2 + 61.7 Hz pair** keeps a swing of up to 1.24 dB, and -26 to -32 dB off its tones: 20.5 Hz apart is close
  to what a 170 ms frame separates. Develop swings 15 to 39 dB.
- **Other output rates.** At a 96 kHz output, V takes the band up to 234 Hz with 85 ms frames, so partials closer than
  about 23 Hz are not separated. There is no scorecard at a 44.1 or 96 kHz output.
- **After the speed returns to 100%** while V is heard, V keeps the low band until the next low attack or seek: the
  same pitch and level, but not develop's samples. From a seek, or the start, at 100% the output is develop's, bit
  for bit.
- **V carries each low partial at its own phase**, not the source's, so the shape of a waveform below 117 Hz is not
  kept: the phase of a fundamental against its harmonics across the crossover. The scorecard measures power, pitch,
  level, steadiness, timing and stereo, not waveform shape.
- **Outside what V was made for**, the backing behaves as on develop. That is a clock slower than 1/32 or faster than
  8 times the neutral speed, or a grain reading more than 16 source frames per output frame.
- Not run: the desktop app, real recordings, macOS and Linux, any listening.
