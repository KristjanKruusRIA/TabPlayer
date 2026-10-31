# Validation Report: Audio Test Tone and Device Diagnostics (L09)

## Behavior

- **Audio Test Tone:**
  - Added a "Test tone" button to the Settings audio output section in `SoundPanel.tsx`.
  - Clicking the button plays a 440 Hz test tone at a quiet fixed level (-22 dBFS, amplitude 0.08) for 500 ms with smooth 20 ms linear fade-in and fade-out to prevent clicks and pops.
  - The tone sounds through the exact output device the application uses via the existing lock-free audition queue (`submit_audition`), stopping completely by itself.
  - Clean refusal during playback: if playback is running (`playing` atomic flag), `test_tone` immediately refuses cleanly with a plain message (`Test tone is unavailable during playback.`), leaving playback uninterrupted.
- **Audio Device Diagnostics:**
  - Diagnostics readout displays current device name, sample rate, and buffer size directly in the audio output section (`SoundPanel.tsx`).
  - Values reflect strictly what the audio backend reports:
    - Current device: reported device name or `Unknown`.
    - Sample rate: active stream sample rate or device default sample rate (e.g. `48000 Hz`) or `Unknown`.
    - Buffer size: exact frames reported by the live audio callback or `Unknown`.
  - **No defaulted values:** An unreported or unknown value always displays as "Unknown" (`audio.unknown`), never guessed defaults (such as 44100 or 512).
- **Missing or Failed Device Handling:**
  - When the audio output device is missing or faulted, a plain error message is displayed (`role="alert"`) in the panel, and playback facilities remain operating safely without crashing.
- **Hot-Path Non-Interference Constraint:**
  - The audio callback (`OutputCallback::render`) only executes a single relaxed atomic store for the buffer size (`buffer_size.store((output.len() / channels) as u32, Ordering::Relaxed)`).
  - Absolutely **zero memory allocations, zero locks, and zero logging** are added to the audio callback.
- **UI & Accessibility:**
  - Focus controls are guarded with `busyGuard`, ensuring they are never `disabled` while busy (retaining focus).
  - All new UI text is localized in `en`, `et`, and `de` (`audio.audio_output`, `audio.system_default`, `audio.test_tone`, `audio.diagnostics_label`, `audio.current_device`, `audio.sample_rate`, `audio.buffer_size`, `audio.unknown`).

## Evidence

- **Rust Backend Tests (`src-tauri/src/audio/device.rs`):**
  - `test_tone_refused_during_playback`: Verifies `test_tone` returns `Err("Test tone is unavailable during playback.")` when playback is active.
  - `test_tone_refused_when_faulted`: Verifies refusal when device is marked faulted.
  - `test_tone_refused_when_no_stream`: Verifies refusal when no output stream is active.
  - `test_tone_submits_500ms_sine_clip_when_idle`: Verifies 500 ms 440 Hz stereo sine wave (24,000 frames at 48 kHz) with max amplitude $\le 0.08$ is submitted to the audition consumer.
  - `diagnostics_reports_unknown_for_unreported_buffer_size`: Verifies initial buffer size reports `None` (unreported) and updates when callback records frames.
  - `diagnostics_reports_error_when_device_faulted`: Verifies plain error returned when faulted.
  - All 110 audio tests passed: `cargo test --manifest-path src-tauri/Cargo.toml --lib audio`.
- **Frontend Unit Tests (`src/audio/SoundPanel.test.tsx`):**
  - `displays diagnostics readout of device name, sample rate, and buffer size from backend`: Verifies readout of actual backend values.
  - `reads unknown when diagnostic values are unreported and never uses defaults`: Verifies `Unknown` is displayed for all missing values without falling back to arbitrary numbers.
  - `triggers test tone on button click and keeps control focusable while busy`: Verifies test tone dispatch and `busyGuard` focus preservation.
  - `shows plain message when test tone is refused during playback`: Verifies refusal alert display.
  - `shows plain message when device diagnostics fail and leaves output selectable`: Verifies error banner and uninterrupted output selector.
  - All 15 tests in `src/audio/SoundPanel.test.tsx` passed.
- **TypeScript Type Check:**
  - `npx tsc --noEmit` runs completely clean with 0 errors.

## Review

- **Audition Queue Re-use:** Rather than building an ad-hoc synthesis path, the test tone leverages `AudioService::submit_audition`, which is already lock-free, zero-alloc in callback, and cleanly retires clips after sounding.
- **Safe Diagnostics Acquisition:** `diagnostics()` reads lock-free atomics and backend device configs. In case of missing/faulted hardware, it cleanly returns descriptive error strings without throwing unhandled exceptions.
- **Non-Invasive Architecture:** No changes to `src-tauri/src/audio/tone.rs`, no extra dependencies added, and existing mock bridges in other test suites remain fully compatible due to optional methods on `NativeAudioBridge`.

## Limits

- **Fixed Level:** The test tone is emitted at a fixed -22 dBFS (0.08 peak amplitude) to protect user ears and hardware.
- **Callback Frames Dependency:** The reported buffer size reflects the buffer frame length supplied by the host audio driver on callback invocation. Before any buffer has rendered, the buffer size is reported as Unknown.
- **Out of Scope:** Input meters and dynamic audio buffer resizing remain intentionally out of scope as specified.
