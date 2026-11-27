# THE-57 Fermata Holds and P12 Control Fixes

Date: 2026-11-27
Issue: THE-57 (Finish the remaining practice controls: P08, P12, P20)

## Scope

This note records the implementation and headless/desktop verification of:

1. **Fermata hold timing** across native playback, offline audio export, backing alignment (Relative and Fixed mode), backing waveform/timeline, GP backing projection, beat timers, and visual cursor sync, while keeping MIDI export un-held.
2. **Two remaining P12 (global relative tonality) UI/controller fixes**:
   - Resetting `practice` alongside `documentSerial` during `loadDocument` in `NativePlaybackController` so a document switch cannot briefly announce `Key 0`.
   - Exposing `keyPending` so stepping back to the currently acknowledged key while a key shift is still pending does not flash `.transport-messages` or shift a folded popover.

## Empirical Fermata Timing Model & GP8 WAV Probes

From Guitar Pro 8.0.0 build 18 WAV exports documented in [`src/interchange/fixtures/fermata-probe.gp8.README.md`](../../src/interchange/fixtures/fermata-probe.gp8.README.md), a fermata stretches a marked interval's tempo using:

```text
effectiveBpm = max(min(1, tempoBpm), tempoBpm * (0.66 - 0.41 * storedLength))
```

A marked interval starting at `offset` extends until **the earliest subsequent beat boundary (start or end of any non-empty, non-grace beat) across all tracks and voices** in that bar (capped at the bar's end or next fermata offset). Authored tempo changes inside an active fermata keep the `(0.66 - 0.41 * storedLength)` multiplier (subject to the `min(1, tempoBpm)` floor) across each sub-interval. MIDI export (`src/export/midi.ts`) remains un-held, matching GP8's own MIDI exports (`fermata-visible-60.gp8.mid` and `fermata-visible-120.gp8.mid`).

### Multi-length probe oracle (`fermata-visible-120.gp8.gp`)

In [`src/audio/fermata.test.ts`](../../src/audio/fermata.test.ts), integrating the 27-bar probe score matches GP8 8.0.0 build 18 WAV render durations to within `< 1 ms`:

- 120 BPM control: `54.000000 s`
- 120 BPM with fermatas: `237.387166 s`
- 60 BPM control: `108.000000 s`
- 60 BPM with fermatas: `294.774354 s`
- 90 BPM validation render: `239.647574 s`

### Unequal-beat, interleaved, mid-hold tempo-change, and sustaining-track GP8 probes

Measured on 2026-11-27 against the six GP8 8.0.0 build 18 `.gp`/`.wav` probe pairs in `.analysis/gp8-comparison-20261126/` and pinned programmatically in [`src/audio/fermata.test.ts`](../../src/audio/fermata.test.ts):

| Probe (`44,100` Hz GP8 WAV) | GP8 WAV Frames / Duration | TabPlayer `buildPlaybackPlan` | Key Finding |
| --- | ---: | ---: | --- |
| `fermata-unequal-control` | `264,600` (`6.000000 s`) | `6.000 s` (`diff = 0 ms`) | Control baseline (3 bars 4/4 at 120 BPM). |
| `fermata-unequal-short-first` | `330,750` (`7.500000 s`) | `7.500 s` (`diff = 0 ms`) | T0 quarters + T1 whole note, fermata `0/1` len `1` -> holds `[3840, 4800)` (`+1.5 s`); T1 whole sustains `2.0..5.5 s` (E2 `82.41 Hz` decays across `2.0..5.40 s` in GP8 WAV before bar 2 attack at `5.512 s`). |
| `fermata-unequal-long-first` | `330,750` (`7.500000 s`) | `7.500 s` (`diff = 0 ms`) | Swapped track order (T0 whole + T1 quarters) yields identical `3840..4800` hold and `7.500 s` duration. |
| `fermata-unequal-interleaved` | `297,675` (`6.750000 s`) | `6.750 s` (`diff = 0 ms`) | T0 `[DottedQuarter, Eighth, Half]` + T1 `[Quarter, Half, Quarter]`, fermata `1/1` at offset `960` len `1`: GP8 onsets (`2.015`, `2.511`, `3.513`, `4.270`, `4.761 s`) prove GP8 holds only until T0's dotted-quarter end at offset `1440` (`[4800, 5280)`, `+0.75 s`). Fixed `planFermatas` in [`src/audio/fermata.ts`](../../src/audio/fermata.ts) to use earliest subsequent beat boundary across all tracks (`nextBoundary - offset`), replacing the prior `matching`-before-`covering` split (`9.000 s`). |
| `fermata-unequal-tempo-control` | `330,750` (`7.500000 s`) | `7.500 s` (`diff = 0 ms`) | Bar 1 `[Half, Half]`, tempo `120 -> 60` BPM at Bar 1 Pos `0.25`, `120` BPM at Bar 2. |
| `fermata-unequal-tempo-hold` | `529,200` (`12.000000 s`) | `12.000 s` (`diff = 1.8e-12 ms`) | Same tempo change + fermata `0/1` len `1` -> `[3840, 5760)`: `30` BPM on `3840..4800` (`+2.0 s`), `15` BPM on `4800..5760` (`+4.0 s`), beat 2 at `8.000 s` (`8.013 s` WAV onset), bar 2 at `10.000 s` (`10.013 s` WAV onset). |

## Implementation Summary

### TypeScript timing, cursor sync, waveform, projection, and UI

- [`src/audio/fermata.ts`](../../src/audio/fermata.ts), [`src/audio/types.ts`](../../src/audio/types.ts), [`src/audio/plan.ts`](../../src/audio/plan.ts): Added `PlanFermata`, `FERMATA_BASE_FACTOR = 0.66`, `FERMATA_LENGTH_SLOPE = 0.41`, `FERMATA_MIN_BPM = 1`, `planFermatas` (earliest-beat-boundary span), `effectiveTempos`, and `millisecondsAtTick`. `plan.tempos` keeps authored (un-held) tempos; `plan.fermatas` is omitted when empty so scores without fermatas remain byte-identical. `checkPlaybackPlan` validates sorted non-overlapping fermata intervals and checks `durationMs` and `occurrences` against `effectiveTempos`.
- [`src/audio/reference-sync.ts`](../../src/audio/reference-sync.ts): `applyReferenceSyncPlan` removes `fermatas` so reference-synchronized tracks follow their explicit audio pin clock.
- [`src/audio/backing-waveform-types.ts`](../../src/audio/backing-waveform-types.ts), [`src/audio/backing-timeline.ts`](../../src/audio/backing-timeline.ts), [`src/audio/BackingWaveform.tsx`](../../src/audio/BackingWaveform.tsx): Propagated `fermatas` into `BackingTimeline`, applied `effectiveTempos` in `tempoTimeline`, and included `props.timeline?.fermatas` in `BackingWaveform` memo dependencies.
- [`src/interchange/backing-projection.ts`](../../src/interchange/backing-projection.ts): Included fermata breakpoints from `effectiveTempos` in GP backing export projection (`sourceTicks` and `ticks`).
- [`src/editor/timers.ts`](../../src/editor/timers.ts): Updated `prepareScoreTimers` to apply `planFermatas`, `effectiveTempos`, and `millisecondsAtTick` to beat start/end times.
- [`src/audio/NativePlaybackController.ts`](../../src/audio/NativePlaybackController.ts) & [`src/Transport.tsx`](../../src/Transport.tsx):
  - `NativePlaybackController` feeds un-held notation milliseconds (`authoredPlan`) to the alphaTab visual cursor when `fermatas` is present, exposes un-held `backingTrackDuration` to alphaTab, and uses `effectiveTempos` for `playbackEndTick` `endTime`.
  - `loadDocument` resets `practice` alongside `documentSerial` in a single state update so switching documents does not announce `Key 0`.
  - Added `isKeyOnlyPending()` / `keyPending` so stepping back to the acknowledged key while a key shift is pending hides `.transport-messages` (`keyPendingOnly` in `Transport.tsx`).

### Rust native engine

- [`src-tauri/src/audio/plan.rs`](../../src-tauri/src/audio/plan.rs) & [`src-tauri/src/audio/audition.rs`](../../src-tauri/src/audio/audition.rs): Added `PlanFermata`, `PlaybackPlan::fermatas` (`Option<Vec<PlanFermata>>`), `fermata_effective_bpm`, `effective_tempos`, validation in `PlaybackPlan::validate`, `Timeline::from_plan`, `Timeline::with_capacity`, `Timeline::is_empty`, and `Timeline::rebuild_fixed`. Non-fermata plans keep `fermatas: None`.
- [`src-tauri/src/audio/renderer.rs`](../../src-tauri/src/audio/renderer.rs): Pre-allocated `fixed_timeline` in `Renderer::new_with_mix` (`fermatas.len() * 2 + 1` capacity) and tracked `clock_origin_fixed_seconds` so fixed-tempo practice switches remain heap-allocation-free on the audio thread. Updated `frame`, `seek_tick_internal`, `apply_practice_tempo`, `reset_clock_origin`, and `output_frames_until` to integrate Fixed-mode fermatas uniformly.
- [`src-tauri/src/audio/reference_sync.rs`](../../src-tauri/src/audio/reference_sync.rs): `ReferenceSyncMap::new` rejects plans carrying non-empty `fermatas`.

## Measured Alignment, Desktop Drivers & Test Verification

Headless 48 kHz transport and export checks in [`src-tauri/tests/audio_backing_alignment.rs`](../../src-tauri/tests/audio_backing_alignment.rs):

- **Isolated backing impulses across fermatas**:
  - Relative mode (`0.5x`, `1.0x`, `1.7x`) at exact-frame `length = 1.0` (`30.0` BPM): **0 frames** offset across all events, partial-beat loops spanning fermatas, and loops starting inside fermatas.
  - `length = 0.5` (`54.6` BPM): within **`<= 1` frame** (`<= 0.021 ms`) due to integer source-frame quantization of the test impulse WAV at `100747.25` frames.
  - Fixed mode (`60`, `90`, `150` BPM) through holds, loops spanning holds, and seeks into holds: **`<= 1` frame** (`0` or `+1` frame from `f64` wall-time tick boundary rounding against score `+1e-7` tick dispatch epsilon).
- **Sustained backing tone bursts** through the time-stretcher across a fermata (`Relative` and `Fixed`): within **3 ms** of the expected score frame.
- **Count-in before a bar starting with a fermata**: clicks at authored 120 BPM (`24,000`-frame spacing, 4 clicks in `0..96,000`), then resumes aligned on `[192,000, 216,000]` after beat 0's `96,000`-frame fermata hold.
- **Offline `AudioExportRender` (`0.5x`, `1.7x`)** with backing + fermata: sustained burst centroids match playback within **`< 1` frame**.
- **Audio-thread allocation check (`switching_fixed_tempo_on_a_fermata_plan_touches_no_heap` in [`src-tauri/tests/audio_render.rs`](../../src-tauri/tests/audio_render.rs))**: **0 heap allocations** while switching among `Fixed` and `Relative` tempos on a fermata plan.

Automated verification run on 2026-11-27:

- **Direct GP8 `.gp`/`.wav` probe check** via Vite SSR `loadInterchangeScore` + `buildPlaybackPlan`: all 6 `.analysis/gp8-comparison-20261126/fermata-unequal-*.gp` files matched GP8 WAV durations with `0 ms` (`<= 1.82e-12 ms`) error.
- **`npm run typecheck`** (after final TS edit): **0 errors**.
- **Vitest** (after final TS edit):
  - 12 targeted files (`fermata.test.ts` (4), `plan.test.ts` (89), `backing-timeline.test.ts` (40), `NativePlaybackController.test.ts` (87 + 1 skipped benchmark), `reference-sync.test.ts` (47), `timers.test.ts` (6), `gestures.test.ts` (29), `gp-fermata-hold.test.ts` (1), `gp8-fermata-midi.test.ts` (6), `backing-projection.test.ts` (51), `midi.test.ts` (26), `Transport.key.test.tsx` (16)): **401 passed, 1 skipped benchmark**.
  - 4 UI/component files (`App.test.tsx`, `ScoreView.test.tsx` (36), `ScoreView.layouts.test.tsx` (139), `fermata.test.ts` (4)): **573 passed, 0 failed**.
- **Rust & Formatting** (verified prior to the TS-only `fermata.ts`/`fermata.test.ts` update; unaffected by TS-only edits):
  - `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`: **1127 passed, 0 failed, 7 ignored**.
  - `cargo test --manifest-path src-tauri/Cargo.toml --locked --test audio_plan --test audio_backing --test audio_backing_alignment --test audio_backing_stretch --test audio_practice --test audio_practice_transport --test audio_render --test audio_tonality --test audio_transport --test reference_sync`: **141 passed, 0 failed, 5 ignored** (`audio_backing` 6, `audio_backing_alignment` 15, `audio_backing_stretch` 9 + 2 ignored, `audio_plan` 8 + 1 ignored, `audio_practice` 19, `audio_practice_transport` 16, `audio_render` 41 + 1 ignored, `audio_tonality` 6, `audio_transport` 7 + 1 ignored, `reference_sync` 14).
  - `rustfmt --edition 2024 --check` on all 8 modified Rust files and `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`: **exit 0**.
- **Desktop drivers** (rebuilt `.analysis/desktop-smoke/tabplayer.exe` via `scripts/build-desktop-test.ps1` after all code edits):
  - [`tests/desktop/parity-practice.mjs`](../../tests/desktop/parity-practice.mjs): **passed** (`healthyDeviceCountRecovery: true`, `countPauseResume: true`, `fixedExportGuard: true`, `seekThenCount: true`, `progressiveNextCount: true`, `practiceDoesNotEdit: true`, `newResetsPractice: true`, `noSecondSynth: true`). The 5 WASAPI loopback audio assertions (`10%` pitch, `300%` pitch, count-in clicks, Fixed 90 attacks, 300% backing count-in delay) were reported `NOT RUN under silent output` because the Windows host output device is silent.
  - [`tests/desktop/parity-key-shift.mjs`](../../tests/desktop/parity-key-shift.mjs): **passed** (`ok: true`), verifying folded badge (`Key +3`, `♮ +3`), mid-playback tonality shift (`19.2 -> 115.2 -> 921.6` ticks), and `en`/`et`/`de` width sweeps (`960..2560`).
  - [`tests/desktop/parity-backing-tempo.mjs`](../../tests/desktop/parity-backing-tempo.mjs): **not executed (`Inert`)** because it requires its source-pinned build-admission fixture from P16.

## Remaining Limits

- **Human listening checks (`THE-207`)**: No human ear listening check of fermata holds, backing-with-fermata transitions, or P08/P12/P20 musical passages was performed; WASAPI loopback in `parity-practice.mjs` also skipped 5 live-output audio checks under silent host output (physical playback/loopback at the owner's machine remains covered via `THE-207`).
- **Notation styling (`N18`)**: Fermata target engraving styling remains tracked under N18 outside audio/timing parity.
