# Validation Report: Audio Test Tone and Device Diagnostics (L09)

## Behavior

- **Audio Test Tone:**
  - Added a "Test tone" button to the Settings audio output section in `SoundPanel.tsx`.
  - Clicking the button plays a 440 Hz test tone at a quiet fixed level (-22 dBFS, amplitude 0.08) for 500 ms with smooth 20 ms linear fade-in and fade-out to prevent clicks and pops.
  - The tone sounds through the exact output device the application uses via the existing audition queue (`submit_audition`), a bounded single-producer ring buffer the callback drains without locking, stopping completely by itself.
  - Playback wins: `test_tone` refuses while playback runs, and if playback or count-in starts while the tone sounds (or in the gap between the check and the submit), the mixer fades the tone out over 5 ms in the callback and drops tone clips queued during playback. Note auditions are unaffected. The cut is a flag write and a move between preallocated slots: no allocation, lock or logging, and playback timing and counters are untouched.
  - Refusals are stable codes (`audio_output_failed`, `audio_output_unavailable`, `audio_test_tone_playback`) worded by `audio.error.*` in `src/i18n` (en, et, de). A device fault is reported before the playback refusal.
- **Audio Device Diagnostics:**
  - Diagnostics readout displays current device name, sample rate, and buffer size directly in the audio output section (`SoundPanel.tsx`).
  - Values reflect strictly what the audio backend reports:
    - Current device: the name of the device the open stream was built on, cached when the stream opened, or `Unknown`.
    - Sample rate: the open stream's rate, cached when it opened (e.g. `48000 Hz`), or `Unknown`.
    - Buffer size: frames per callback as reported by the live callback (shown with its unit, `512 frames`), or `Unknown`.
  - Diagnostics read cached values only and make no call into the audio backend, so reading them cannot disturb a running stream (on ALSA, probing would open the PCM). With no stream open every value is `None`, never a default.
  - **No defaulted values:** An unreported or unknown value always displays as "Unknown" (`audio.unknown`), never guessed defaults (such as 44100 or 512).
- **Missing or Failed Device Handling:**
  - When the audio output device is missing or faulted, a plain error message is displayed (`role="alert"`) in the panel, and playback facilities remain operating safely without crashing.
- **Hot-Path Non-Interference Constraint:**
  - The audio callback (`OutputCallback::render`) executes a single relaxed atomic store for the buffer size, after the epoch check so a retired callback never overwrites its replacement's value; the field is reset when a new stream opens.
  - The callback also sets one boolean on the audition mixer per block. No allocation, lock or logging is added to it.
- **UI & Accessibility:**
  - Focus controls are guarded with `busyGuard`, ensuring they are never `disabled` while busy (retaining focus).
  - The readout is a `role="group"` with a label; the refusal message clears when playback stops; the readout follows a device change once the switch has completed and ignores out-of-order responses. The Sound rig, which has no readout, does not request diagnostics.
  - All new UI text is localized in `en`, `et`, and `de` (`audio.audio_output`, `audio.system_default`, `audio.test_tone`, `audio.diagnostics_label`, `audio.current_device`, `audio.sample_rate`, `audio.buffer_size`, `audio.unknown`).

## Evidence

- **Rust Backend Tests (`src-tauri/src/audio/device.rs`, `audition.rs`):**
  - Refusals return stable codes: during playback, when faulted (and fault wins over playback), and with no stream.
  - The tone clip is audible but quiet (peak between 0.075 and 0.08), fades at both ends, and measures 440 Hz by counting rising zero crossings; it is flagged so playback can cut it.
  - Diagnostics read unknown with no stream, independent of the machine's audio hardware, and report the cached name, rate and buffer size.
  - A retired callback does not write the buffer size; the live one does.
  - Playback cuts a sounding tone (not a note audition) and drops a tone queued during playback.
  - `cargo test --locked -j 2 --lib audio` ran 115 tests (114 passed, 1 ignored, 0 failed) on Windows only.
- **Frontend Unit Tests (`src/audio/SoundPanel.test.tsx`):**
  - `displays diagnostics readout of device name, sample rate, and buffer size from backend`: Verifies readout of actual backend values.
  - `reads unknown when diagnostic values are unreported and never uses defaults`: Verifies `Unknown` is displayed for all missing values without falling back to arbitrary numbers.
  - `triggers test tone on button click and keeps control focusable while busy`: Verifies test tone dispatch and `busyGuard` focus preservation.
  - `shows plain message when test tone is refused during playback`: Verifies refusal alert display.
  - `shows plain message when device diagnostics fail and leaves output selectable`: Verifies error banner and uninterrupted output selector.
  - Added tests: the readout follows a device change that completes after the call returns, an older slow response is ignored, the refusal clears when playback stops, an unknown code gets generic wording, and diagnostics are only read where the readout is shown. `src/audio/bridge.test.ts` checks the two invoke names `audio_diagnostics` and `audio_test_tone`.
  - All 20 tests in `src/audio/SoundPanel.test.tsx` passed.
- **TypeScript Type Check:**
  - `npx tsc --noEmit` runs completely clean with 0 errors.

## Review

- **Audition Queue Re-use:** Rather than building an ad-hoc synthesis path, the test tone leverages `AudioService::submit_audition`, which hands clips to the callback through a bounded ring buffer without locking, adds no allocation in the callback, and retires clips after sounding.
- **Independent review:** a separate hot-path review of the first version found real defects, now fixed: rustfmt failures in CI, a stale readout after a device change, diagnostics that re-probed the backend (an ALSA PCM open could fail while playback worked, and `Display` could panic), the playback refusal shadowing a device fault, the tone sounding over count-in and music, English-only refusal messages, a dropped `#[cfg(test)]`, a buffer-size store before the epoch check, and tests that asserted nothing without hardware.
- **Safe Diagnostics Acquisition:** `diagnostics()` reads cached values and atomics only and returns a stable code when the device has faulted.
- **Non-Invasive Architecture:** No changes to `src-tauri/src/audio/tone.rs`, no extra dependencies added, and existing mock bridges in other test suites remain fully compatible due to optional methods on `NativeAudioBridge`.

## Limits

- **Fixed Level:** The test tone is emitted at a fixed -22 dBFS (0.08 peak amplitude) to protect user ears and hardware.
- **Callback Frames Dependency:** The reported buffer size reflects the buffer frame length supplied by the host audio driver on callback invocation. Before any buffer has rendered, the buffer size is reported as Unknown.
- **Desktop verification not performed:** this change has not been driven in the real app through the `tests/desktop/` drivers, and no tone was heard on a real device. It is covered by unit tests only; the 500 ms tone, the cut when playback starts, and the readout against real devices still need a desktop check.
- **Platform:** Rust tests ran on Windows only; the worktree has no `.analysis/compatibility` fixtures, so `plan.test.ts` failures there are unrelated to this change.
- **Cut granularity:** the tone is cut at the next callback block after the playing flag is seen, over 5 ms; the device's own buffer latency is not removed. The name is cached when a stream opens, so a device renamed afterwards reads as before until the next open.
- **Out of Scope:** Input meters and dynamic audio buffer resizing remain intentionally out of scope as specified.
