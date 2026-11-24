# Guitar Pro 8–faithful palm mute duration & DSP — validation, 2026-11-24

Windows validation on branch `develop` after diagnosing and fixing why palm-muted notes cut out abruptly (~83 ms / 200 ms) and lacked low-end damped body compared to Guitar Pro 8.

## Root Cause

1. **alphaTab MIDI duration truncation (`src/audio/plan.ts`)**: `alphaTab.midi.MidiFileGenerator._getNoteDuration` truncated every `isPalmMute` note to `_defaultDurationPalmMute = 80` (~83.1 ms at 155 BPM) regardless of written rhythmic value (eighth, quarter, dotted-quarter, half) or ties. Static inspection via Ghidra 12.1.4 of Guitar Pro 8 `GPRSE.dll` (`sha256: 266a84514780fae2d422e975bd2c6b6d68554028b35c69bd0d2124e00d111668`, `gp::rse::NoteAutomation::sampleLoad` / `requestedTickCount`) confirmed that GP8 RSE passes full written note duration (including ties/slides, suppressing only `letRing` extension) and synthesizes palm mutes via DSP on ordinary sustain samples (`.gp7bank` archives contain no separate palm-mute recordings).
2. **Hard 200 ms cap + fast GP8 release (`src-tauri/src/audio/voices.rs`)**: `SampleVoice::release` previously deferred note-off only until `MUTED_RING_SECONDS = 0.2`, after which GP8's `pitched_release_seconds = 0.08` dropped 60 dB in 80 ms, leaving long silent gaps on quarter, dotted-quarter, and half notes.
3. **Static 1-pole filter instead of GP8 `PalmMuteDeadNoteFilter`**: `SampleVoice` previously filtered palm mutes from frame 0 with a single static 1-pole LPF (`140–1000 Hz`) and fixed `-t / 0.30` decay, muffling pick attack while lacking low-string chug resonance.

## Changes Implemented

- **Written palm-mute duration in playback plan (`src/audio/plan.ts`)**
  - Added `preservePalmMuteDuration(generator)` (hooked in `generate(score)`, leaving Standard MIDI export `src/export/midi.ts` untouched) so palm-muted notes keep their full written duration (including ties and legato slides) while suppressing `letRing` extension.
  - Updated `src/audio/interpretation.test.ts`, added a duration/tie/`letRing` test in `src/audio/plan.test.ts`, and updated only the single palm-muted note (`4120 -> 4920`) in `src/audio/__snapshots__/plan.performance.test.ts.snap`.
- **GP8 `PalmMuteFilter` (`src-tauri/src/audio/voices.rs`)**
  - Implemented zero-allocation inline `PalmMuteFilter` (`BilinearOnePole`, `BilinearPeakingEq`) driven at GP8's `32 / 44100 s` control cadence and adapted cleanly to any renderer sample rate:
    - Passes the first 5 control blocks (~3.63 ms after pick onset) unfiltered for crisp pick transient, then primes 3 cascaded bilinear 1-pole LPFs for clickless engagement.
    - Sweeps the 3 LPFs from `(1000, 10000, 20000) Hz` toward `(82.0, 73.8, 73.8) Hz`.
    - Engages a bilinear peaking EQ biquad at `82.0 Hz` (`Q: 8.0 -> 1.3`, `0 -> +18 dB` on lowest string index `0`, `0 -> +8 dB` on 2nd string index `1`) after control block 40 (~29 ms).
    - Applies exponential damping (`env_gain *= 0.999 - strength * 0.007` per block after block 30, smoothed at `159.16 Hz`), with `DEFAULT_PALM_MUTE_STRENGTH = 0.3` and `HEAVY_PALM_MUTE_STRENGTH = 0.65`.
  - Replaced `MUTED_RING_SECONDS = 0.2` with `MUTED_MIN_HOLD_SECONDS = 0.03` so notes release cleanly at written `endTick` / rests while still sounding leaded samples on very short subdivisions and cutting in `4 ms` on string restrike (`cut_ring()`).
  - Left `Articulation::Dead` and all non-muted/non-dead paths bit-identical (`VoiceParameters` struct layout unchanged).
- **Renderer wiring (`src-tauri/src/audio/renderer.rs`)**
  - Passed 0-based lowest-string index (`note.source.string.checked_sub(1)`) and track `PalmMuteIntensity` (`Heavy => 0.65`, default `0.3`) via `SampleVoice::with_palm_mute`.
- **Test coverage (`src-tauri/tests/audio_palm_mute.rs`)**
  - Updated legacy 83 ms / 200 ms assumptions to test half/quarter/eighth written durations and added tests for 82 Hz low-string chug resonance, unfiltered initial pick transient preservation, sample-rate independence (`44.1 / 48 / 96 kHz`), and 6-string palm-muted chord limiter headroom.

## Offline Verification on Reported `.gp` Reproducer (Temporary Probe, Deleted)

- Generated playback plan in artifact scratch space: confirmed bar 0 notes now hold full written durations (`193.5 ms` eighth, `387.1 ms` quarter, `774.2 ms` half; bar 2 `580.6 ms` dotted-quarter).
- Rendered bars 0–2 through `Renderer` + installed `Metal-Guitar.gp7bank` and `Classic-Guitar.gp7bank` + `metal-rhythm` and `lead` presets (`44.1 kHz`):
  - **Dry `Metal-Guitar`**: peak `0.0640`, no NaN/Inf; Bar 0 Beat 2 half-note RMS (dB): `-45.0` (0–50 ms) -> `-42.0` (100–200 ms bloom) -> `-50.0` (250–350 ms) -> `-54.8` (400–500 ms) -> `-61.1` (550–650 ms) -> `-63.7` (650–750 ms).
  - **`Metal-Rhythm` + `Metal-Guitar`**: peak `0.2186`, no NaN/Inf; Bar 0 Beat 2 half-note RMS (dB): `-27.1` (0–50 ms) -> `-20.8` (100–200 ms) -> `-21.8` (250–350 ms) -> `-25.1` (400–500 ms) -> `-30.8` (550–650 ms) -> `-44.8` (650–750 ms), sustaining cleanly past the `-50 dB` noise gate for the full written half note.
  - **`Lead` preset + `Metal-Guitar`**: peak `0.1488`, no NaN/Inf; Bar 0 Beat 2 half-note RMS (dB): `-27.1` -> `-25.3` -> `-27.7` -> `-30.4` -> `-33.3` -> `-34.8`.

## Verification (final state)

- `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` -> exit 0.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` -> exit 0 (**1,122 passed, 0 failed, 7 ignored**; includes `voices::legacy_equivalence`).
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_palm_mute --test audio_palm_mute_identity --test audio_metal_rhythm --test audio_gp8_soundbanks --test audio_render` -> exit 0:
  - `audio_palm_mute`: **23 passed, 0 failed** (including 0 heap allocs on audio thread and all 5 dead-note tests).
  - `audio_palm_mute_identity`: **1 passed, 0 failed** (Windows FNV-1a hashes `0xf7591afeab7eb66b`, `0x6dedeeca1d4b2167` unchanged).
  - `audio_metal_rhythm`: **5 passed, 0 failed** (all factory FNV-1a hashes unchanged).
  - `audio_gp8_soundbanks`: **5 passed, 0 failed, 1 ignored**.
  - `audio_render`: **40 passed, 0 failed, 1 ignored**.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_gp8_soundbanks -- --ignored --nocapture` -> exit 0 (**1 passed, 0 failed** `real_installed_gp8_soundbank_smoke`).
- `npm run typecheck` -> exit 0 (`tsc --noEmit`).
- `npx vitest run src/audio/plan.test.ts src/audio/plan.performance.test.ts src/audio/interpretation.test.ts src/export/midi.test.ts` -> exit 0 (**4 files, 141 tests passed**).
- `npm test`:
  - Node script tests: **70 tests — 68 passed, 0 failed, 2 skipped** (Windows symlink tests `EPERM`).
  - Vitest: **471 passed | 1 failed | 4 skipped (476 files)**; **7,845 passed | 1 failed | 5 skipped (7,851 tests)**. The single failure (`src/tremolo-guard.test.ts:206`, reporting missing `tremolo-guard` import in `src/workspace/MidiImportDialog.tsx`) is pre-existing on `develop` (`1ddec2f`) and unrelated to palm mute changes.

## Limits

- Tested and measured on Windows; audio bit-identity checks and real `.gp7bank` smoke tests ran against locally installed GP8 Standard Soundbank on Windows.
- User's `palmmute.gp` score and extracted reference files remain outside the repository.
