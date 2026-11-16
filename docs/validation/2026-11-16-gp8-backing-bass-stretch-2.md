# GP8 parity P20: the backing stretcher keeps low bass at practice speeds, fourth attempt (2026-11-16)

THE-212, branch `agy/the-212-bass-stretch-2` from `develop` 5940f19. **Nobody has listened to this yet.** Every number
below is a headless render of `BackingVoice` alone (no device, no transport), with synthetic signals generated in the
tests, at 48 kHz unless another rate is named, in the release profile. The desktop app, real music, macOS and Linux
were not run. Before and after clips of the synthetic signals at 50% and 75% were rendered for listening outside the
repository; they are not committed.

"Develop" figures were measured with the same functions on develop's stretcher: the voice built without the new low
band, which is develop's code path (the only other change in `prepare_grain` reads the clock rate and the previous
grain's position for the low band).

## The defect, measured

At practice speeds the backing's low bass loses weight and sustained low notes wobble or thin out, worst near 50%.

The stretcher (`backing.rs`) cuts the source into grains of HOP = 256 output frames and splices each onto the
previous one where a correlation of the continuation peaks, within `radius = ceil(256 * step)` source frames of where
it aims (256 at an unshifted 48 kHz file). The `root_cause` test fits, inside each grain, the phase of the tail and the
head the grain crossfades, so it reads the phase step at every splice straight from the output:

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

**Root cause.** Where the splice step equals the drift per grain, the search did not find a lined-up splice: it landed
on its aim, so each grain starts where the clock is, and the grains then play the source at the clock's own rate. A
sustained low tone comes out at its frequency times the speed (98% of its power there). It is not cancellation in the
crossfade: two equal sines that far apart lose at most 0.4 dB. A lined-up splice needs a correlation peak, a whole
period away from the continuation, within the search window, and a match over 256 frames that tells it apart. Below
about 94 Hz (a period over 512 frames, twice the radius; `f_lock = rate / (2 * radius)`) the window holds less than
half a period and the search less than one, so whether a splice lines up depends on the speed: 41.2 Hz never does,
55 Hz half the time at 50% only, 82.4 Hz everywhere except 90%. Every tone above that locks.

**Why the three low-band grain variations could not fix it.** The earlier passes (`9b85a08`, `b0759b1` and the first
version) gave the low band its own, longer grain and search so that it could reach a period. A splice that lines up on
a period places the low band only to within half a period of the clock (12 ms at 41 Hz) and moves it by that much at
any splice; those passes measured bass notes arriving 8 to 13 ms early (first), notes after a ringing note 15 to 60 ms
earlier than develop (third), and tones on the crossover slipping apart because two splice rules met there. Two low
partials that are not harmonics of one short period (41.2 + 61.7 Hz repeat together only every 48 ms) need a splice
that lines both up, which no grain search reaches without timing errors of that size. Any grain stretcher of the low
band has these limits; a fourth variation was not tried.

## The method: the low band from a phase vocoder while the voice stretches

`src-tauri/src/audio/backing/low.rs`:

    out = W(x) - W(low) + V(low)

- **W** is the grain stretcher, unchanged: the same search on the whole signal, the same splices, so everything above
  the low band is develop's output.
- **low** is a zero-phase low-pass of what the grains read (Kaiser, 70 dB): flat to 1.25 `f_lock` (117 Hz at 48 kHz),
  stopped from 4 `f_lock` (375 Hz), decimated by `radius / 16` (to 3 kHz at 48 kHz), computed while playing, one
  decimated sample at a time as the clock reaches it, into a cache of 4096. `W(low)` is that band read and crossfaded
  exactly as the grains read and crossfade the source, so the subtraction takes out precisely the grains' low band.
- **V** is a phase vocoder on `low`: frames of N = 512 decimated samples (170 ms at 48 kHz, partials 12 Hz apart
  resolved), Hann window, one frame per grain centred on the score clock, the frequency of each spectral peak from a
  second frame DELTA = 8 samples away, identity phase locking (every bin turns with the peak of its lobe). Below `pass`
  = 1.25 `f_lock` a peak's phase is carried forward at its own frequency, so it keeps its pitch and level; above it,
  where the two bands overlap, the peak is turned to the phase the grains read at, so both halves of the crossover add
  up as before. Bins above 6 `f_lock` are zero. Both channels turn by one angle (from their sum, or from their
  difference where the channels cancel), so proportional channels stay exactly proportional; each channel has its own
  real transform for that reason.
- **Attacks** in the low band (short-term power rising past twice the loudest of the previous 64 ms, above about
  -60 dBFS) split it into segments. A frame sees only its own segment through a window that fades out over 32 decimated
  samples (11 ms) towards the segment's edges (a cut edge spreads a low partial down to 0 Hz and its mirror image); the
  window's own phase at each partial is taken out of what is carried forward. The grains keep their own low band where
  a frame they hear would read across an attack, where they read within 8 ms after one, or where a frame's window has
  faded at the point they read; a grain's ramp either side. Below 40% of the neutral speed the grains hear only frames
  whose whole window lies inside their segment (a frame cut short has a small frequency error that adds up over a long
  stretch). While V is not heard its frames start from the phases the grains read at, so it comes in in step with them.
- **At the neutral speed** (100% with no key shift) V does not come in, and the output is develop's, bit for bit. When
  the speed returns to neutral while V is heard, V keeps the low band until the next attack in it or a seek: handing
  it back in the middle of a sustained partial cross-fades two versions of it whose phases disagree (measured: -9.4 dB
  for 20 ms on a 55 Hz sine at 75% to 100%).
- **Guards** (after an adversarial review): V stays out where the clock is far outside the source, when the clock moves
  slower than 1/32 or faster than 8 times the neutral speed (a jump that is not a seek, or a map far too steep), and
  where a grain reads more than 16 source frames per output frame (a file at over 16 times the output rate, or over 8
  times with the key an octave up: the search radius is at its cap there). V always leaves over a grain's ramp, never
  at once.
- **Real time.** Every buffer is made when the voice is built. A grain's work is bounded: one frame (four forward real
  transforms of 512 and two inverse), the newly reached decimated samples of the low-pass, and an attack scan over at
  most half the cache. Starting afresh (a seek, a loop or a return from the neutral speed into audio the low band has
  not computed) needs about 850 decimated samples before V can come in: 0.5 ms in one 128-frame callback at 48 kHz and
  2.3 ms for a 192 or 384 kHz file an octave up, against the 2.67 ms the callback has. While V is out, the scan
  therefore computes at most 2^18 multiplies of the low-pass per grain (and at least twice what the clock moves on),
  and V comes in once it has caught up; until then the grains keep their own low band, as on develop.

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

## Scorecard

One fixed scorecard (`audio_backing_bass.rs`, ignored tests `scorecard`, `root_cause` and
`cost_of_a_second_of_audio`), every row at 50, 60, 75 and 90%, develop / this branch.

### (a) Low-band energy

30-150 Hz power of the output against the unstretched source, and the share of the source's low spectrum the output
has at the same frequencies ("at its pitch"; a bass moved to another pitch keeps its power and loses this). dB, power
/ at its pitch.

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

A sustained tone or pair: the largest slow swing of each tone's amplitude (100 ms windows every 10 ms, dB), the worst
tone's level error (dB) and the energy off the tones over 0.5 s (dB, lower is purer). swing / level / off.

| Signal | 50% | 60% | 75% | 90% |
| --- | --- | --- | --- | --- |
| sine 41.2 Hz | 0.00 / -14.01 / -0.0 → 0.00 / 0.00 / -85.4 | 0.01 / -8.29 / -0.0 → 0.00 / 0.00 / -86.1 | 0.00 / -2.77 / -0.0 → 0.00 / 0.00 / -86.4 | 0.00 / -0.13 / -3.0 → 0.00 / 0.00 / -86.7 |
| sine 55 Hz | 9.22 / -2.61 / -1.9 → 0.00 / 0.00 / -73.9 | 0.00 / -17.67 / -0.0 → 0.00 / 0.00 / -74.8 | 0.00 / -6.07 / -0.0 → 0.00 / 0.00 / -75.3 | 0.00 / -0.39 / -0.5 → 0.00 / 0.00 / -75.5 |
| sine 82.4 Hz | 0.01 / -0.01 / -28.1 → 0.00 / 0.00 / -96.7 | 0.03 / -0.04 / -22.2 → 0.00 / 0.00 / -94.1 | 0.00 / 0.00 / -34.5 → 0.00 / 0.00 / -96.8 | 0.00 / -1.59 / -0.0 → 0.00 / 0.00 / -91.1 |
| pair 55 + 82.4 Hz | 25.12 / -6.45 / -1.8 → 0.04 / +0.03 / -51.6 | 22.37 / -3.78 / -1.0 → 0.05 / +0.03 / -50.0 | 12.58 / -3.87 / -2.3 → 0.05 / +0.03 / -49.7 | 14.28 / -1.51 / -4.5 → 0.07 / +0.03 / -50.3 |
| pair 41.2 + 61.7 Hz | 34.93 / -4.78 / -0.7 → 0.78 / -0.62 / -25.6 | 26.65 / -12.71 / -1.2 → 0.92 / -0.60 / -25.7 | 39.31 / -5.39 / -1.5 → 1.12 / -0.59 / -26.0 | 14.77 / -1.51 / -1.2 → 1.24 / -0.58 / -32.0 |

At 100% both are the source (swing 0, off -150 dB).

### (c) Transients

Medians over the hits: pre-echo (energy before the clock's onset against after it, dB; -300 is none), attack (10 to
90% of the 1 ms envelope, ms) and onset against the clock (ms, negative is early). **Identical to develop in every cell
except two**: the kick below 150 Hz at 60% (pre-echo -44.3 → -44.2 dB) and at 90% (none → -141 dB, far below
hearing).

| Hit | 50% | 60% | 75% | 90% |
| --- | --- | --- | --- | --- |
| kick, full band | -7.9 dB, 1.52 ms, -3.73 ms | -10.6, 1.48, -2.10 | -29.3, 1.65, -0.65 | none, 1.54, -0.08 |
| kick, below 150 Hz | -25.3, 7.33, -4.00 | -44.3 (-44.2), 7.10, -2.42 | -112.1, 7.04, -0.90 | none (-141.0), 7.02, -0.27 |
| beater click over a note, above 500 Hz | 1.0, 1.21, -6.60 | 3.0, 8.48, -10.88 | 0.1, 8.48, -8.06 | 13.2, 1.06, -6.15 |
| drum hit | -4.8, 0.88, -3.33 | -8.3, 2.67, -2.08 | -9.4, 0.88, -0.67 | none, 1.77, -0.27 |
| plucked 82 Hz | -8.3, 1.23, -3.33 | -13.3, 16.12, -2.10 | -14.1, 1.17, -0.67 | none, 2.52, -0.27 |

### (d) Mid and high band energy and noise flatness

White noise: band power against the source (dB) in 30-150, 150-500, 500-4000 and 4000-16000 Hz, and the change of
spectral flatness over 100-16000 Hz (dB).

| Speed | develop | this branch |
| --- | --- | --- |
| 50% | -1.58, -0.57, -0.66, -2.08; flatness -0.13 | -0.22, -0.57, -0.66, -2.08; -0.13 |
| 60% | -1.82, -1.44, -1.43, -2.64; -0.09 | -0.23, -1.42, -1.43, -2.64; -0.09 |
| 75% | -0.68, -0.30, -0.35, -1.12; -0.03 | -0.11, -0.30, -0.35, -1.12; -0.03 |
| 90% | -0.70, -1.35, -1.36, -2.64; -0.10 | -0.14, -1.31, -1.36, -2.64; -0.11 |

### (e) Alignment

Worst energy-centroid error of Hann-windowed bursts against the score clock (ms, negative is early). Identical to
develop for the 1 kHz and noise bursts; the 200 ms burst of 55 Hz moves onto the clock.

| Speed | 1 kHz, 40 ms | 1 kHz, 200 ms | noise, 40 ms | 55 Hz, 200 ms: develop → this branch |
| --- | --- | --- | --- | --- |
| 50% | -0.25 | -0.01 | -1.95 | -2.01 → -0.41 |
| 60% | -0.35 | -0.08 | -1.99 | -5.38 → -1.15 |
| 75% | -0.24 | -0.00 | -3.50 | -5.39 → -1.78 |
| 90% | -0.19 | -0.04 | +1.68 | -5.08 → -1.38 |

The existing alignment suite (`audio_backing_alignment`, 12 tests) passes unchanged.

### (f) Stereo coherence and mono

A low pair the same in both channels (right 0.9 of left), noise correlated 0.6 between them, and a 55 Hz tone whose
right channel lags 60 degrees. Source: low coherence 0.9997, mid (500-4000 Hz) coherence 0.3716, low mono sum -0.01 dB.

| Speed | Proportional channels, largest error | Low coherence | Low mono sum | 55 Hz phase between channels, error | Mid coherence |
| --- | --- | --- | --- | --- | --- |
| 50% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | +0.3 → -0.0 deg | 0.3728 → 0.3710 |
| 60% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -217.5 → -0.0 deg | 0.3726 → 0.3709 |
| 75% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -0.0 → -0.0 deg | 0.3719 → 0.3716 |
| 90% | 0 → 0 | 0.9997 → 0.9997 | -0.01 → -0.01 dB | -0.0 → -0.0 deg | 0.3784 → 0.3782 |

### (g) CPU

One thread, release profile (`cost_of_a_second_of_audio`), a stereo mix (bass line, kicks, chord, hiss), a 48 kHz
output: milliseconds per second of audio (median of five runs of 10 s); the slowest 128-frame block (one device callback
of 2.67 ms) among the first 1024 output frames after a seek, microseconds, median and worst of 41 seeks; and the same a
second later. The seeks jump 4.8 s forward or 10.4 s back, so nothing the low band computed before is near (a cold
start, the costliest case). The last four rows play the mix from files at 192 and 384 kHz (interpolated), an octave up:
the steepest reads V takes. Develop and this branch were measured one after the other in one session; this machine ran
about 20% slower than for the earlier figures in this note's history (develop at 100%: 7.95 against 6.40 ms), so all
of them were taken again. Single worst values above 700 us that also appear a second later (1108 us at 50%) are the
operating system, not the stretcher.

| File, speed, key shift | ms per second: develop → this branch | Slowest block after a seek, median (worst): develop → this branch | A second later |
| --- | --- | --- | --- |
| 48 kHz, 100%, 0 | 7.95 → 7.81 | 41 (52) → 41 (59) | 41 → 41 |
| 48 kHz, 50%, 0 | 7.88 → 13.40 | 41 (42) → 232 (377) | 41 → 71 |
| 48 kHz, 60%, 0 | 7.85 → 13.52 | 41 (93) → 233 (288) | 41 → 72 |
| 48 kHz, 75%, 0 | 7.84 → 13.82 | 41 (45) → 233 (259) | 41 → 73 |
| 48 kHz, 90%, 0 | 8.01 → 14.14 | 41 (68) → 232 (264) | 41 → 75 |
| 48 kHz, 50%, +12 | 8.30 → 13.09 | 44 (56) → 189 (311) | 44 → 70 |
| 48 kHz, 100%, -12 | 4.51 → 11.65 | 23 (34) → 302 (327) | 23 → 60 |
| 48 kHz, 300%, +12 | 8.35 → 17.18 | 44 (54) → 189 (1040) | 44 → 97 |
| 48 kHz, 300%, -12 | 4.47 → 17.03 | 23 (31) → 300 (386) | 23 → 90 |
| 192 kHz, 50%, +12 | 11.24 → 17.57 | 60 (204) → 168 (747) | 59 → 94 |
| 192 kHz, 75%, +12 | 11.22 → 18.40 | 60 (93) → 168 (192) | 59 → 99 |
| 384 kHz, 50%, +12 | 11.36 → 19.77 | 61 (117) → 168 (213) | 60 → 106 |
| 384 kHz, 75%, +12 | 11.42 → 21.85 | 61 (65) → 170 (222) | 60 → 118 |

Before the scan was spread over grains (same session, same seeks), the slowest block after a cold seek was 517 to 522 us
at 48 kHz and 50 to 90% (549 to 576 worst), 760 us at +12, 786 us at 300% +12, and 2256 to 2293 us for the 192 and
384 kHz files (worst 5598): close to or over a whole 128-frame callback. The seek tests of the earlier commits did not
show it, since their seeks landed where the low band had already been computed. Spreading the work delays V after a
cold seek: in a probe (not committed) on a 41.2 Hz sine, V came in at the 5th grain after the seek instead of the 3rd
at 48 kHz (27 ms instead of 16), the 8th at +12 and 50% (43 ms), the 4th at -12, and the 25th and 28th for the 192 and
384 kHz files an octave up (133 and 149 ms). The scorecard's rows (a) to (f) did not change by a digit.

Building the voice takes 6 to 8 ms at 48 kHz on both, 12 to 25 ms for the 192 and 384 kHz files. The ignored
`selected_real_100bar_fourtrack_resource_budget` test passes (1600 requests, 390 samples loaded in 0.42 s); it is a
sample-pack load budget and does not run the backing stretcher.

### Speed change while playing

A steady 55 Hz sine at 75%, 100%, 75%, 100%: the worst level of any 20 ms against the source. Develop -1.39 dB (its
wobble at 75%); this branch within 0.05 dB, through every change.

## Tests

New in `src-tauri/tests/audio_backing_bass.rs` (the bass rows fail on develop and pass here; the other rows hold
develop's own figures, measured with these functions, within the margins stated in each test):

- `sustained_low_tones_keep_their_pitch_level_and_steadiness` (a, b): per tone set, swing, level and off-tone limits
  (sines 0.5 dB, 0.5 dB, -60 dB; 55 + 82.4 Hz 1.0, 0.5, -40; 41.2 + 61.7 Hz 2.5, 1.0, -20). Develop: the 41.2 Hz sine
  is 14 dB down at 50%, the pairs swing 12 to 39 dB.
- `the_low_band_keeps_its_power_at_its_own_pitch` (a): five signals at 50 and 75%, power within 1 dB and at least
  -1 dB at its pitch. Develop: -33.7 dB for the 41.2 Hz sine.
- `transients_are_no_worse_than_before` (c): pre-echo at most 1 dB more than develop (or under -60 dB), attack at most
  0.5 ms slower, onset within 0.5 ms. Passes on both.
- `noise_keeps_its_bands_and_flatness` (d): the 150-16000 Hz bands within 0.25 dB of develop, flatness no more than
  0.05 dB lower, the lowest band within 1 dB of the source. Develop loses up to 2 dB there.
- `bursts_stay_on_the_score_clock` (e): within 0.25 ms of develop's errors, and the 55 Hz burst within 2.5 ms.
  Develop: 5.4 ms early.
- `the_stereo_image_and_the_mono_sum_are_kept` (f): proportional channels exactly so, phase within 0.5 degrees, low
  coherence within 0.002 of the source, mono within 0.1 dB, mid coherence within 0.005 of develop. Develop: -217.5
  degrees at 60%.
- `changing_the_speed_while_playing_makes_no_level_jump`: every 20 ms within 1 dB. Develop: -1.39 dB.

New `src-tauri/tests/audio_backing_realtime.rs`:

- `rendering_seeking_and_changing_speed_allocate_nothing`: a counting global allocator (with a check that it counts)
  over rendering at 50, 100, 75, neutral, 300, 10, 90 and 100%, loop-wrap seeks, clock jumps that are not seeks, and
  60 speed changes every 700 frames (mid-hop, to and from neutral), at 44.1, 48 and 96 kHz, key shifts 0, -5, +7 and
  +12, on a sustained bass with clicks and on kicks and plucks from silence: no allocation; and the sustained 41.2 Hz
  bass keeps its level within 1 dB at its own pitch (develop: -21 dB).
- `extreme_maps_and_rates_neither_stall_nor_panic`: offsets of plus and minus 1e22 ms, and files at 6.144 MHz, 768 kHz
  (+12 at a 22.05 kHz output) and 384 kHz (+12, the steepest read V still takes) at 10 to 300%. Without the read guard
  the 6.144 MHz file panics (index out of bounds). Without the clock guards the review found that a 1e22 ms offset
  makes the attack scan loop without end in release; that was not run, since it would hang the test. In the debug test
  profile the 1e22 ms offset also hit develop's own grain read (`sample`: a position past what an i64 holds floors to
  `i64::MAX`, and the next index overflowed; release wraps it to silence). That read now saturates, which changes
  nothing below `i64::MAX`.
- `speed_changes_near_attacks_never_click`: low notes every 0.37 s, the speed changing every 1499 frames among 20 to
  100%, across the 40% line: no step from one output frame to the next above 0.05 (the source's largest is under
  0.02). Before V always left over its ramp: a step of 0.51.

Unit tests in `low.rs`: the real transform against its definition and its inverse, and the low-pass's response.

Existing suites, release and debug: `audio_backing` 6, `audio_backing_alignment` 12, `audio_backing_stretch` 9 (2
ignored tables), `backing_processing` 14 (bit-identity at 100% and of proportional channels included),
`backing_processing_protocol` 6, `backing_waveform` 5, library backing tests 41: all pass.

On the final code (67d7a34), in this worktree:

- `cargo test --locked --workspace --no-fail-fast` (debug test profile): 98 test targets, 2076 passed, 0 failed, 99
  ignored. An earlier full run, before the last commit, failed only `extreme_maps_and_rates_neither_stall_nor_panic`
  (the debug overflow above).
- `cargo fmt --all -- --check`: clean.
- `npm run typecheck`: exit 0.
- `npm test -- --testTimeout=60000`: 430 files and 7434 tests passed, 5 files and 8 tests skipped. Nothing outside
  `src-tauri` changed but this note; the performance snapshot it rewrites was restored afterwards.
- A read-only adversarial review of the low band: four findings, fixed in cda6076 and approved; the spread cold start
  and the saturating read were reviewed again and approved.

## Limits

- **Nobody has listened.** The clips (sine 41.2 Hz, the two pairs, the bass line, kicks over a 55 Hz bed, the mix and
  the stereo signal, before and after, 50% and 75%, level-matched) need the owner's ears. They were rendered before the
  last two fix commits: the guards and the ramp leave fixed-speed renders the same to within 0.01 dB on the scorecard,
  and the spread cold start brings V in about 11 ms later at the start of each clip.
- **CPU 1.6 to 1.8 times develop's at practice speeds** (7.9 to 13.1-14.1 ms per second of audio at 48 kHz), twice at
  300% an octave up, 2.6 to 3.8 times with the key an octave down (4.5 to 11.7-17.0), and 1.6 to 1.9 times for 192 and
  384 kHz files an octave up (11.2-11.4 to 17.6-21.9). That is 1.3 to 2.2% of one core per backing. The slowest
  128-frame callback after a cold seek carries 0.17 to 0.30 ms of the backing (develop 0.02 to 0.06 ms).
- **After a seek into audio the low band has not computed** (or a loop that long, or the speed leaving 100% there), V
  comes in later than it would with the work done at once: 21 to 43 ms after the seek at 48 kHz instead of 16 ms (1 to
  5 grains later), 133 to 149 ms for 192 and 384 kHz files an octave up. Until then the bass is develop's. The scan
  always takes at least twice what the clock moves on per grain, so it cannot fall behind for good; at 300% that floor
  stays under about 0.7 million multiplies per grain for any file, and only clocks far faster than the practice speeds
  (8 times the neutral speed with a 384 kHz file an octave up) could reach 6.8 million. A clock that leaps without a
  seek while V is heard still makes its frames at the new place in one grain (V leaves over that grain's ramp); the
  renderer moves the clock that way only by seeking, which takes V out first, and that case was not timed.
- **Near attacks the low band is the grains'**: within about 8 ms after a low attack, where a frame they would hear
  reads across one, and where its window has faded (about 17 to 20 ms of source from an attack at 40% and up). Below
  40% of the speed the grains hear only whole windows, so for about 96 ms of source after each low attack (0.27 to
  0.96 s of playing at 10 to 35%) the bass is develop's.
- **The 41.2 + 61.7 Hz pair** keeps a swing of up to 1.24 dB and -26 to -32 dB off its tones: 20.5 Hz apart is close to
  what a 170 ms frame separates. Develop swings 15 to 39 dB.
- **After the speed returns to 100%** while V is heard, V keeps the low band until the next low attack or seek: the same
  pitch and level, but not develop's samples. From a seek or the start at 100% the output is develop's, bit for bit.
- **V carries each low partial at its own phase**, not the source's: the shape of a waveform below 117 Hz (the phase of
  a fundamental against its harmonics across the crossover) is not kept. The scorecard measures power, pitch, level,
  steadiness, timing and stereo, not waveform shape.
- **Outside what V was made for** (a clock slower than 1/32 or faster than 8 times the neutral speed, a grain reading
  more than 16 source frames per output frame) the backing behaves as on develop.
- Not run: the desktop app, real recordings, macOS and Linux, any listening.
