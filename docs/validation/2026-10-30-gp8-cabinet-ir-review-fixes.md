# Cabinet impulse responses: review fixes (2026-10-30)

The hot-path review rejected the first cabinet impulse response commit (13bebbb). This records what was measured before
and after the fixes. The machine was shared with compiles and other sessions, so a figure is the best of several runs
where that is said, and rows from a busy moment are labelled. `src-tauri/examples/ir_load.rs` makes every figure here
(`cells`, `tail`, `spikes`); it is a harness and is not built into the app.

## A clean note's tail (subnormal numbers)

The plain amp's DC follower falls through the subnormal numbers about 3.4 s after a clean or bass note and was fed into
the frequency-domain tiers as it was. Input below 1e-20 is now zero, so the engine rests as soon as its response has
drained. Percent of one core in each of nine seconds after a half second note, callbacks of 480 frames unless stated,
with a response in the cabinet.

| Case | Before (13bebbb) | After |
|---|---|---|
| Clean, 1 track | 7 5 6 **53** 26 3 1 1 1, 17 overruns, worst 35.7 ms | 2 1 1 1 1 0 0 0 1, no overruns, worst 0.31 ms |
| Clean, 8 tracks | 19 22 31 **1060** 837 39 6 6 6, 125 overruns, worst 693 ms | 15 14 17 6 4 3 3 3 3, no overruns, worst 3.4 ms |
| Bass, 8 tracks | 32 45 55 **734** 583 57 73 26 35, 140 overruns | 13 12 13 13 47 37 29 25 24, no overruns, worst 7.4 ms |
| Clean, 8 tracks, callbacks of 64 | 36 44 70 **1679** 681 22 5 5 6, 1,102 overruns, worst 905 ms | 17 16 15 9 5 4 5 5 5, no overruns, worst 0.64 ms |

The built-in cabinet with the same bass note also climbs (5 to 22 percent of a core over the nine seconds, and 9 to 149
percent in the first run, which was on a busier machine) because the amp's follower is slow in the amp itself; that is
the amp and not the cabinet, it is unchanged, and it was left alone.

## Where the transforms fall

The convolution alone, 48 kHz, a response of a full second, stereo input; median / 99th percentile / worst callback in
ms and the worst as a share of the callback's time. Best of five runs for each figure, in a quiet moment. "Together" is
every track's tiers beginning in step (which is all that 13bebbb could do); "apart" gives each track its own place.
Before is 13bebbb built with the same harness, where the two columns are the same code.

| Tracks, callback | Before | After, together | After, apart (as shipped) |
|---|---|---|---|
| 6, 64 frames (1.33 ms) | 0.020 / 0.69 / 0.80 (60%) | 0.030 / 0.25 / 0.38 (29%) | 0.055 / 0.081 / 0.11 (**8%**) |
| 8, 64 frames | 0.024 / 0.92 / 1.42 (**106%**) | 0.041 / 0.35 / 0.59 (44%) | 0.074 / 0.13 / 0.21 (**16%**) |
| 6, 128 frames (2.67 ms) | 0.044 / 1.23 / 1.52 (57%) | 0.079 / 0.50 / 0.62 (23%) | 0.099 / 0.24 / 0.30 (11%) |
| 8, 128 frames | 0.056 / 1.71 / 2.28 (85%) | 0.089 / 0.59 / 0.64 (24%) | 0.152 / 0.35 / 0.41 (15%) |
| 8, 256 frames (5.33 ms) | 0.224 / 1.80 / 1.95 (36%) | 0.270 / 0.87 / 0.95 (18%) | 0.279 / 0.57 / 0.67 (13%) |
| 12, 480 frames (10 ms) | 0.551 / 3.64 / 3.85 (38%) | 0.891 / 1.88 / 2.85 (29%) | 0.822 / 1.73 / 1.86 (19%) |

Three changes make the difference. The stagger alone (tracks apart, large tiers still doing all their work at a block's
end) took 8 tracks at 64 frames from a worst of 106 percent of the callback to 34 percent. Working the two larger tiers
ahead, a third and two thirds of the way through the block before, with only the transform of the block just heard left
for its end, took it from 34 to 16 percent and 6 tracks at 64 from 18 to 8. The medians rise a little (more, smaller
pieces of work, and the second channel's work no longer shared with the first), which is the price.

A second run, in a busy moment, gave the same order: 99th percentile 3.0 to 6.1 ms for 8 tracks and over before against
0.3 to 2.3 ms after. Absolute figures from a busy moment are not worth more than that.

## The whole chain

`cells`: six to twelve tracks of the heaviest sound (gate, drive, metal amp, closed cabinet or a response), median /
99th / worst callback and overruns, best of three. Taken on a machine that was not quiet: the built-in rows show
overruns too and move between runs, so compare a response against the built-in row of its own run.

| Setup (48 kHz unless stated) | Before: built-in / response overruns | After: built-in / response overruns |
|---|---|---|
| 6 tracks, 64 frames (2,250 callbacks) | 37 / 185 | 0 / 0 |
| 6 tracks, 128 frames (1,125) | 33 / 111 | 0 / 0 |
| 8 tracks, 128 frames | 26 / 188 | 0 / 58 |
| 8 tracks, 256 frames (563) | 2 / 347 | 0 / 11 |
| 96 kHz, 6 tracks, 480 frames (600) | 230 / 103 | 0 / 67 |
| 96 kHz, 8 tracks, 480 frames | 554 / 594 | 351 / 351 |
| 10 tracks, 480 frames (300) | 295 / 282 | 63 / 98 |
| 12 tracks, 480 frames | 300 / 300 | 114 / 256 |

The first row of the review (6 tracks at 64 frames, about none to 60 overruns) is gone. The rows that remain are the
heavy chain: eight tracks of the metal amp at 96 kHz miss their callbacks with the built-in cabinet too, and the
response adds a little to the median (0.9 against 0.5 ms for 6 tracks at 64 frames).

## Tests

- `ir_convolver`: a tail longer than five seconds that falls from 0.05 through 1e-20 and the subnormal numbers to
  zero. The engine must be at rest before the first subnormal number (about 3.6 s in) and the frames that are subnormal
  must cost no more than the same number of frames of ordinary input. With the flush removed the first of those fails.
  Removing the lookahead from a joining kernel's first block fails the join test and no other.
- `cargo test --locked --lib`: 346 passed, 4 ignored.
- `cargo test --locked --test audio_cabinet_ir` 18; `audio_tone` 22; `audio_clean_sounds` 1; and every other `audio_*`,
  `backing_*`, `document_*`, `project_*` and `new_score_defaults` test target passes. The no-response cabinet is
  compared bit for bit with the model's own render (`a_response_the_library_cannot_supply_plays_the_cabinet_model_exactly`).
  `cargo test` as a whole does not build in this tree: `tests/file_library_intake.rs` includes `src/intake.rs`, which
  calls a method that is `pub(crate)` in `workspace.rs`. That was so at 13bebbb and is not touched here.
- `npm run typecheck` clean; vitest `cabinet-ir.test.tsx` 19, with `NativePlaybackController.test.ts`,
  `ExportDialog.test.tsx`, `SoundPanel.test.tsx` and `App.test.tsx` 257 passed, 1 skipped, in all.
- Not run: the desktop drivers in `tests/desktop/`, which the merge runs.

## Limits

- The stagger and the work ahead spread the transforms; they do not remove them. At 64 frames the convolution alone
  can still take 16 percent of a callback in its worst callback for 8 tracks.
- A file's staleness in the library is judged by its size and modification time. A change that keeps both goes
  unnoticed until the library is restarted.
- A rate no track has asked for is not checked when a response is imported (48 kHz and the last rate asked for are).
- An engine that rested drops the ringing of anything older than the response it rested with, if a longer response
  then takes over. That input was silent for the whole of the shorter response's length.

## Final acceptance (2026-10-30)
- **Review:** a fresh hot-path review approved 4354d10 across real-time safety, convolution correctness, determinism, untrusted input, project compatibility and licensing. Fuzzing covered 5.59M frames with a worst error of 4.7e-6 against direct convolution.
- **Merged branch:** 886 Rust tests passed, `tsc` was clean, `src/App.test.tsx` passed 143 of 143, and the rest of the suite passed 4,021 with 1 skipped; `src/editor/corpus.test.ts` is excluded from that run.
- **Desktop:** `tests/desktop/parity-cabinet-ir.mjs` passed on a Windows desktop-test build, including import refusal, exported audio through the response, level trim, a removed response falling back with a notice, and restoring a response by identity.
- **More limits from the review:** a kernel join does its FFT work in one frame (up to 20% of a 64-frame callback per stereo track, so 8 tracks joining together can glitch once at small buffers); a wake with unequal channels copies whole rings in one frame; after a rest, a longer response can play the left channel's old tail on the right; with 13 or more distinct responses the kernel cache thrashes; another open panel can show an old list. No IR ships with the app, and macOS and Linux were not run.
