# GP8 parity P20: the backing stretcher is re-centred; fixed tempo with a backing (2026-11-14)

THE-57, two owner decisions of 2026-11-14, with the review fixes of the same day. **Nobody has listened to any of this.** Every number is a headless render at 48 kHz (`BackingVoice` directly, or `CallbackTransport` and the export for the real loop, seek, count-in and tempo path), not a judgement of sound. The Windows driver `tests/desktop/parity-practice.mjs` was edited for the new behaviour and checked with `node --check`; it was **not run**. The P20 row of the parity tracker is not updated.

## Decision 1: sustained backing audio is aligned wherever the stretcher stretches

Before: sustained audio sat early below 1.0x and late above it, by a bounded amount that did not drift (see `2026-11-13-gp8-backing-alignment.md`). Cause: each 256-frame grain is crossfaded from the previous grain's continuation, and the search (plus or minus 256 source frames around the score position) always preferred that continuation, whose position drifts by 256 x (step - speed) per grain, so it settled on the window edge.

### What "centred" means, and where it applies

A grain reads `step` source frames per output frame (1 for an unshifted file at the output's rate; raised by a saved pitch or the key shift, scaled by the file's rate against the output's). The clock moves the source `rate` frames per output frame (practice speed, times a sync map's slope, times the file's rate). Wherever `rate` differs from `step` the stretcher is stretching in time, and the read position drifts from the clock by `(step - rate)` per output frame. The first half of every grain's output is the previous grain's continuation crossfaded in, so what is heard averages that drift over about one grain, `HOP = 256` frames. A grain aimed `(HOP - 0.5) * (rate - step)` source frames from the clock therefore has its heard average on the clock: that is "centred", and it holds for a practice speed other than 100%, for a pure key shift at 100%, for a map slope other than 1, and for any mix of them, in playback and in export (the export drives the same renderer: `AudioExportRender` calls `set_speed` and then renders through the same voice).

### Which outputs are bit-identical to before, and which change

- **Bit-identical to the commit before this work**: a voice whose `rate` equals its `step`, that is an unshifted backing at 100% speed on a map of slope 1 (no sync anchors, or anchors whose slope is exactly 1). The aim is then 0 and the search takes the same peak as the old one (the continuation, which matches perfectly). Proved by `an_unshifted_voice_with_a_slope_of_one_at_full_speed_is_bit_identical_to_before`: an 80,000-frame fingerprint (FNV-1a over the output's f32 bits) of an integer-only signal (sawtooth, noise, silence, an isolated impulse) through the voice, with and without two slope-1 anchors, compared with the value captured by running the same test against the previous commit's `backing.rs` (a scratch copy swapped in and out, nothing stashed). The signal avoids `sin`, so the bits do not depend on a platform's libm. This includes an unshifted 44.1 kHz file at 100% on a 48 kHz output (rate and step are both 0.91875): the third fingerprint. The fourth is an exactly periodic input (period 4, so the whole window is one flat run of scores) and the fifth a long silent stretch between two sounding ones; both equal HEAD's.
- **Changed** (on purpose, and the same in playback and export): any practice speed other than 100%; any saved pitch or key shift, even at 100%; a sync map whose slope is not 1, even at 100%. Their sustained audio moves toward the clock (tables below). Exports at those settings are therefore not byte-identical to an export made before; exports at 100% of an unshifted backing without a sloped map are.
- Transients (isolated impulses) bypass the stretcher and are unchanged everywhere: every `== 0 frames` assertion still holds.

### What changed in `backing.rs`

- `grain_bias`: the aim above. Zero for the first grain after a seek (it starts exactly on the clock, so loop starts and seeks are unchanged) and within 1e-6 of the stretcher's own rate. Not clamped to the search window: the window is centred on the aim, so any aim is reachable; only an absurd rate is cut at 8192 source frames (`MAX_AIM`). The earlier clamp of two search radii left a downward key shift late: at -25 semitones and 3.0x the ideal aim is about 706 frames and the clamp was 122.
- A run of exactly equal scores is **one peak**, and the point of it nearest the aim stands for it. The first version tested `>=` on the left and `>` on the right, so a flat run resolved to its right end: when the tail still sounded and every candidate read digital silence (or the input's period divided the coarse step of 4 frames), the grain landed at aim + radius, about 5 ms early for one grain, where the old search chose the centre. The scan is allocation-free and inside the work bound. Tests: `a_grain_whose_candidates_are_all_silent_lands_on_the_aim_not_the_edge` and `a_signal_whose_period_divides_the_coarse_step_lands_on_the_peak_nearest_the_aim` (unit tests in `backing.rs`; both failed first, landing 256 frames too far at 5056 for an aim of 4800).
- The search chooses a **correlation peak**, not a position. It scores the window, finds the local maxima of the normalised correlation, picks the one with the best height less `0.35 * (distance in grains)^2`, never one that scores more than 0.1 below the best peak, then refines on the correlation alone within one coarse step. The previous version subtracted the penalty from every position, which moves the optimum off the phase peak by about `0.7 * delta / 256^2 / omega^2` frames: negligible at 330 to 1170 Hz, several frames at 110 Hz, and the cause of the 10 dB loss of a steady sine at 3.0x. Now the pull decides which peak, never where inside one.
- Work per grain is bounded and allocation-free (the scores sit in a fixed array of 144). The search radius is `HOP * step` source frames, capped at 2048 (43 ms at 48 kHz). Correlations of 64 samples per grain are at most `COARSE_POINTS + 2 * (stride - 1)` with `COARSE_POINTS = 144` and `stride = max(4, ceil(2 * radius / 143))`: **135 at step 1** (as before the re-centring), 200 at the cap (+25 semitones on a file at twice the output rate and above). Before the cap existed the count grew without limit with the step (about 550 at +25 semitones, more for a 96 kHz file). One test walks the step from 1/24 to 108 and asserts the bound. In reads that is at most 200 x 64 = 12,800 interpolated source samples per 256 output frames, 50 per output frame, against 34 at step 1. The existing `selected_real_100bar_fourtrack_resource_budget` test is a load budget (it asserts fewer than 1000 samples are loaded and prints sizes); it has no per-callback time, and the only CPU figure on record is the tone note's (eight panned high-gain tracks cost about half a core). The grain search was **not timed in a release build here**: the precedent is the pitch-effects fix (`2026-10-23-gp8-pitch-effects.md`), a coarse-to-fine search at constant cost, which this keeps.
- Realtime: nothing new allocates, locks or blocks. Per grain also two `BackingMap::source_seconds` lookups (O(log anchors)).

### Residual offsets (source frames; 48 = 1 ms; negative = early)

Held notes (200 ms tone bursts, `audio_backing_stretch`): within 2 frames at 0.1x, 0.5x, 1.0x, 1.7x and 3.0x. Requirement tested: 2 ms (96 frames).

Short bursts (40 ms, 1 kHz, Hann, through the real transport with a partial-beat loop, three passes; first grains still converging): worst -22 (0.1x), -12 (0.5x), 1e-7 (1.0x), +31 (1.7x), +67 (3.0x), and 100 at the 2.5x of a fixed 150 BPM in bar 1. Tested at 3 ms (144 frames). Every pass reproduces the last to 0.01 frames.

Key shift and slope (200 ms bursts unless noted; requirement 2 ms):

| Case | 0.5x | 1.0x | 1.5x | 3.0x |
| --- | --- | --- | --- | --- |
| -25 semitones | -2 | -1 | -5 | -4 |
| -12 semitones | 0 | 0 | 0 | +1 |
| +7 semitones | | +1 | | |
| +12 semitones | -1 | -2 | 0 | +1 |
| +25 semitones | -14 | -14 | -11 | -6 |
| map slope 0.5 (40 ms bursts) | | -12 | | |
| map slope 0.8 (40 ms) | | -22 | | |
| map slope 1.25 (40 ms) | | +10 | | |
| map slope 2.0 (40 ms) | | +57 | | |

Aperiodic audio (40 ms noise bursts, nothing to splice by): mean -33 (0.1x), -74 (0.5x), +62 (1.7x), +37 (3.0x), single bursts up to 204 frames (4.2 ms), inside the 256-frame window and no longer on its edge (before: -254, -194, +210, +539; up to 748). Real music is between the tone and the noise; it was not measured.

### Quality, before and after

Off-tone = energy outside the fitted tones over total (Hann-weighted least squares at the fitted frequencies; lower is purer). Level = worst tone amplitude error. Pitch = worst tone against nominal. 0.5 s measured; before = the previous commit's stretcher (scratch copy of its `backing.rs`), after = this one. `audio_backing_stretch` holds the before values as constants and fails if any point is more than 3 dB less pure, or (for tones that came through cleanly) 0.15 dB worse in level.

| Tones (Hz) | Speed | Off-tone dB before / after | Level dB before / after | Pitch cents before / after |
| --- | --- | --- | --- | --- |
| 440 | 0.1 | -44.7 / -55.7 | 0.003 / 0.003 | 1.4 / 1.4 |
| 440 | 0.5 | -46.2 / -54.1 | 0.000 / 0.003 | 0.7 / 0.7 |
| 440 | 0.75 | -45.5 / -57.2 | 0.000 / 0.002 | 0.3 / 0.3 |
| 440 | 1.5 | -46.2 / -54.3 | 0.000 / 0.003 | 0.7 / 0.7 |
| 440 | 1.7 | -46.3 / -55.3 | 0.002 / 0.002 | 0.3 / 0.3 |
| 440 | 3.0 | -40.1 / -50.7 | 0.001 / 0.000 | 1.3 / 2.9 |
| 330 + 1170 | 0.1 | -20.7 / -21.1 | 0.090 / 0.082 | 17.0 / 17.0 |
| 330 + 1170 | 0.5 | -21.9 / -21.5 | 0.044 / 0.073 | 10.3 / 10.9 |
| 330 + 1170 | 0.75 | -24.0 / -27.2 | 0.023 / 0.020 | 5.0 / 5.7 |
| 330 + 1170 | 1.5 | -15.2 / -19.6 | 0.240 / 0.105 | 10.7 / 11.5 |
| 330 + 1170 | 1.7 | -26.9 / -31.8 | 0.030 / 0.018 | 15.2 / 15.2 |
| 330 + 1170 | 3.0 | -3.2 / -3.0 | 12.9 / 17.0 | 17.1 / 6.6 |
| 110 | 0.1 | -58.6 / -59.1 | 0.000 / 0.000 | 1.4 / 1.4 |
| 110 | 0.5 | -53.4 / -53.1 | 0.000 / 0.000 | 0.8 / 0.8 |
| 110 | 0.75 | -49.4 / -49.4 | 0.000 / 0.000 | 0.5 / 0.5 |
| 110 | 1.5 | -53.4 / -53.1 | 0.000 / 0.000 | 0.8 / 0.8 |
| 110 | 1.7 | -48.1 / -48.4 | 0.000 / 0.000 | 0.5 / 0.5 |
| 110 | 3.0 | -52.0 / -53.0 | 0.000 / 0.000 | 1.7 / 1.7 |
| 82 | 0.1 | -26.0 / -26.0 | 0.018 / 0.018 | 25.1 / 25.1 |
| 82 | 0.5 | -26.2 / -25.9 | 0.012 / 0.015 | 13.9 / 13.9 |
| 82 | 0.75 | -31.8 / -31.6 | 0.003 / 0.004 | 7.2 / 7.2 |
| 82 | 1.5 | -26.0 / -26.0 | 0.014 / 0.014 | 14.0 / 14.0 |
| 82 | 1.7 | -19.2 / -19.2 | 0.062 / 0.062 | 6.3 / 6.3 |
| 82 | 3.0 | -44.7 / -46.3 | 0.000 / 0.000 | 1.5 / 1.5 |
| 41 | all six | 0.0 / 0.0 | 14 to 111 / same | 74 to 143 / same |
| 55 + 82 | 0.1 to 3.0 | -0.1 to -5.0 / -0.1 to -4.9 | 4.8 to 40 / 6 to 21 | 23 to 105 / 9 to 99 |

Reading it:

- Never worse than 0.4 dB at any point, and better at 440 Hz (8 to 11 dB), at 330 + 1170 Hz (up to 5 dB) and at 110 Hz at 3.0x. The steady sine at 3.0x gained 10.6 dB; it no longer loses anything. (The first version of this work lost 10 dB there, and two-tone purity at 0.75x fell 9 dB; both came from the position-shifting penalty and are gone.)
- The 41 Hz and 55 + 82 Hz rows are **report-only** in the test (printed, not asserted): the tone is not preserved there at any speed, the values are chaotic, and one grain flipped by a libm difference on Apple Silicon would change them. Every other row is asserted.
- **Bass is limited by the grain, not by this work.** At 82 Hz (period 585 frames) the stretcher already managed only -26 dB at the old settings, and at 41 Hz (period 1170) and 55 + 82 Hz it does not preserve the tone at any speed, before or after: the fit lands on the edge of the search. A grain of 256 frames and a window of 256 are shorter than one period, so the correlation cannot see the waveform. 110 Hz and up are fine. A bass line below about 90 Hz stretched at a practice speed other than 100% is therefore rough, and always was; fixing it needs longer grains or a pitch-adaptive grain, which changes the sound and was not done. The 330 + 1170 Hz pitch error of 10 to 17 cents is also old and unchanged.
- 100%: all rows at speed 1.0 are -150 dB (the source, to float precision).

### Tests

- `audio_backing_stretch.rs` (new): the bit-identity fingerprints (plain, slope-1 anchors, 44.1 kHz file, periodic input, silent stretch), the purity table above as limits, sustained and short-burst centring, key shift at 100% and at other speeds (±25 semitones included), slope other than 1, noise bursts, the work bound (`backing.rs` unit test). `table` and `quality_table` (ignored) print the numbers.
- `audio_backing_alignment.rs`: the old per-speed windows are replaced by "short bursts within 3 ms, 1.0x below 0.001, no drift"; an export at 50% and 170% with a backing is compared with playback and lands within 2 ms and within one frame of it. Every `== 0` transient assertion is unchanged. The first version failed with 463 frames at 0.1x.
- Margins: the bounds are tied to the requirement (2 ms sustained, 3 ms short bursts, the 256-frame window for noise, 3 dB of purity against the old stretcher), not to today's measurement, so a libm difference that flips one grain choice (macOS on Apple Silicon) does not fail them. The fingerprint signal uses no `sin`.

## Decision 2: fixed tempo with a backing

### The rule

A backing is driven by the score clock (`Renderer.seconds` into `BackingVoice::next_frame`), exactly as in relative speed; fixed mode only changes how that clock advances (`renderer.rs`, `RenderTempo::Fixed`). So at each point the backing is stretched by the clock's rate: **fixed BPM over the authored tempo at that tick** (for a backing without sync anchors). Loops, seeks, count-ins and the backing offset act on the clock and needed nothing new.

The setting is refused when any position of the score would need a ratio outside 10% to 300%. With `min` and `max` the authored tempos of the played range (every tempo that governs a tick before the plan's playback end; the first always does), the allowed fixed tempos are `low = max(10, max / 10)` rounded up to a tenth and `high = min(300, 3 * min)` rounded down to a tenth. **The check compares the tempo with those same two numbers** (it used to divide by the tempos while the message multiplied and rounded, so for a 121 BPM score the message said "choose 12.1 to ..." and 12.1 was refused: 1160 of the 2901 integer maxima from 100 to 3000 had it). The rounding is inwards, so every tempo inside the stated range keeps the stretch inside 10% to 300% (a tempo inside the exact limit but outside the rounded one, by under 0.1 BPM, is refused). Native (`AuthoredTempos::fixed_limits`, `refuse_fixed`) and page (`fixedLimits`, `checkFixedBacking`) compute them identically; a property test in each walks the integer maxima 100 to 3000 (every one in Rust, every third in TypeScript) and several fractional ones with several min/max ratios and asserts that the stated low, middle and high are accepted, the first tenth outside each is refused, and the exact ratios hold. The shared fixture gained the 121 BPM and 33.3 BPM cases. If the tempos are so far apart that no tempo fits (10 and 400 BPM) the message says so. Not clamped, not muted. Session state: the saved document and every export are unchanged.

A score that follows its audio: its plan's tempos are derived from the audio and checked against the pins, and its source map is 1:1 with score time, so the authored tempo is what the audio plays at and the same rule applies with no special case (`reference_sync`: `a_fixed_tempo_follows_a_backing_whose_tempos_come_from_its_audio`).

A muted backing is **checked like an unmuted one**, because un-muting and solo are mix changes that are not validated against the practice tempo and the voice keeps running while muted. The refusal text now says so ("A muted backing counts too.", en, et and de, in the two error messages and in the panel's note).

### Where it lives

- Native, authoritative: `practice.rs` (`AuthoredTempos`, `PracticeSettings::validate` and `check`, `PracticeRefusal`), called from `device.rs` where practice settings are accepted and from `renderer.rs`. **Nothing on the audio thread builds a message**: the callback paths use `check(..).is_err()` (`device.rs`, the install check and the `SetPractice` command, which answers with the fixed short `brief()` sentence) and `Renderer::apply_practice_tempo` (a `PracticeRefusal` that is `Copy`, used by `resolve_renderer` and the install), never `validate`/`set_practice_tempo`, which format. The test `refusing_a_fixed_tempo_on_the_audio_thread_touches_no_heap` counts heap operations with the same counting allocator as the existing render tests across every such refusal (and acceptance) and asserts none. `CallbackTransport::command` keeps its `&'static str` error.
- Page mirror: `src/audio/practice.ts`; the controller checks against the plan it sends native and falls back to 100% with the notice `fixed_tempo_backing_range` when a fixed tempo no longer fits. Before the plan is known only native checks.
- Fixture `tests/practice-protocol.json`, UI and messages as before; `Fixed` is not disabled with a backing.

### Tests

- `audio_backing_alignment.rs`: fixed 60, 90 and 150 BPM across the 120 to 60 tempo change, through loop wraps, a seek, a count-in between loops and a 100 ms offset; transients on the frame; short bursts within 3 ms; a check that the fixed tempo is really in force.
- `audio_practice.rs`, `audio_render.rs`: edges and the property test above, the renderer's refusal and install behaviour, the allocation test.
- TypeScript: `practice.test.ts` (property test), `PracticePanel.test.tsx`, `NativePlaybackController.test.ts`, `Transport` tests.

## Limits

Headless; no device, no ears. Tones and noise are synthetic; real music was not measured. Bass below about 90 Hz is not stretched cleanly at any speed other than 100%, before and after. The 40 ms burst numbers include the onset (about eight grains to converge). The ratio rule counts the score clock only; a backing with sync anchors multiplies its own slope on top, as relative speed already does (open question 3 in the 2026-11-13 note). Pitch-shifted and sloped-map output changed, as listed. The grain search cost was bounded and counted, not timed in a release build. The desktop driver was not run.
