# GP8 parity: OGG audio export (F20)

Date: 2026-11-06. Branch `feature/f20-ogg-export` from `develop` at `cb26c8c`. Linear THE-64 (shared with MP3, F19).

## What changed

- The Export dialog's File type offers **OGG Vorbis (compressed)** next to WAV, AIFF and FLAC, both for mixed audio and for stems.
  - OGG hides bit depth, which does not apply to it.
  - A note says the file is lossy, at about 192 kbit/s, and that normalized peaks can go slightly past −1 dBFS after compression.
  - The file is saved as `.ogg`. Stems are written as `.ogg` files and recorded in the manifest with container `ogg`.
- `PcmWriter` (`src-tauri/src/export/wav.rs`) gains `AudioContainer::Ogg`.
  - It encodes with `vorbis_rs` 0.5.6 in quality VBR 0.6, with a fixed stream serial and an `ENCODER=TabPlayer` comment.
  - The encoder writes Ogg pages into a shared buffer, which is moved to the file after every block and at `finish`.
  - Samples must be finite and are clamped to ±1.
  - Cancelling still leaves any earlier file in place, and normalization feeds Ogg through the same path as WAV.
- Requests without a container, and existing `aiff`/`flac` requests, are unchanged. `"OGG"` in upper case is rejected, like the other names.
- **New dependencies:** `vorbis_rs` 0.5.6, `aotuv_lancer_vorbis_sys` 0.1.6 and `ogg_next_sys` 0.1.5, pinned in `Cargo.lock`.
  - All three are BSD-3-Clause and build the bundled aoTuV libvorbis and libogg (BSD-3-Clause) with `cc`.
  - Default features are off, so `getrandom` is not pulled in.
- **Licences:**
  - `scripts/copy-notices.mjs` now also copies the crates' vendored `*_vendor/COPYING` files.
  - The vorbis-rs crates publish no licence file, so their upstream BSD-3-Clause text (commit `6934784`) is kept as `legal/vorbis-rs-BSD-3-Clause.txt` and packaged.
  - `THIRD_PARTY_NOTICES.md` names all three crates and both C libraries with their copyright lines.

## Evidence

- **Native unit tests** (`export::` in `--lib`, 47 passed):
  - **Round trip:** 10 s of two-channel tones, fed in alternating 300 and 512 frame blocks. The file begins `OggS` and is under a tenth of 16-bit PCM size. Symphonia decodes it independently to exactly 441 000 frames, with over 30 dB SNR on each channel against the input.
  - **Determinism:** a second encode, fed in the same block sizes, is byte-identical.
  - **Empty and invalid input:** an empty export is a valid Ogg stream, and a NaN sample is an error.
  - **Stems:** each OGG stem decodes to 48 000 frames, a 440 Hz stem carries the tone, and a silent stem stays silent.
  - **Requests and cancellation:** serde accepts `ogg`, and a cancelled OGG export leaves the earlier file in place.
- **Frontend:** `src/export/ogg-export.test.tsx` checks that:
  - the dialog names the file `.ogg`, hides bit depth and shows the note;
  - it sends `container:'ogg'`, with and without normalization;
  - switching back to WAV brings bit depth back and sends the old request shape;
  - stems export as OGG.
- **Desktop** (`tests/desktop/parity-ogg-export.mjs`, Windows desktop-test build): exports a sustained E2, B2 and E3 on a steel-string guitar through the Export dialog, as OGG and as 24-bit WAV, at both rates. Symphonia decoded the OGG files through the `decode_audio` example:

  | Export | Frames (OGG = WAV) | SNR against WAV | OGG bytes | WAV bytes |
  |---|---|---|---|---|
  | 44.1 kHz | 264 600 | 28.6 dB | 45 028 | 1 587 644 |
  | 48 kHz | 288 000 | 28.1 dB | 44 104 | 1 728 044 |

  Stem export at 48 kHz wrote `001-Guitar.ogg` and `002-Mix.ogg`. Both decode as 48 kHz stereo and are listed in the manifest with container `ogg`.
- **Full suites:**
  - `cargo test --locked`: 1 118 passed, 0 failed, 13 ignored.
  - `cargo fmt --check` is clean.
  - The ignored `selected_real_100bar_fourtrack_resource_budget` passes.
  - `npm run typecheck` passes.
  - `npm test`: 5 306 passed, 19 failed, 7 skipped. All 19 failures are in the 5 files that also fail on `develop` on this machine (App, WorkspaceApp, TrackSettingsPanel, library content, midi-import); 13 of them report a timeout.
  - Run alone, those 5 files pass: 277 tests.

## Review

A fresh read-only adversarial review (Opus, extra-high effort) covered the new dependency and the writer.

**Checked and sound:**
- frame counting, `finish` and cancellation;
- separate encoders per stem;
- encoder safety for blocks of 1–512 frames and for zero blocks;
- thread use: `PcmWriter` is now `!Send`, but it is created and used inside one blocking task;
- page-buffer draining;
- lockfile checksums;
- build scripts: no network access, and they need only Rust 1.87.

**Findings and outcome:**
- **Fixed:** the vorbis-rs BSD-3-Clause text was missing from the package. It is now packaged, as above.
- **Fixed:** a misplaced sentence in `THIRD_PARTY_NOTICES.md`.
- **Fixed:** the −1 dBFS normalization promise does not strictly hold after lossy coding. The OGG note now says so.
- **Fixed:** the stem error mentioned "integer PCM headroom". It now says "A stem would clip."
- **Kept:**
  - The stem manifest still records `bitDepth` for OGG stems; it has no meaning there. Keeping it avoids a manifest schema change.
  - The bundled C psychoacoustic code fills shared tables without a lock on GCC/Clang x86-64. The app runs one export at a time and builds stem encoders on one thread, so the race cannot occur there. Parallel encoding would need a lock first.
  - `aotuv_lancer_vorbis_sys` 0.1.6 was published with stray CMake output. Its build script neither compiles nor runs those files.

## Limits

- Quality is fixed at VBR 0.6, with no quality or bitrate choice (F23 still covers options).
- Output is byte-identical only when the renderer feeds the same block sizes.
- Vorbis is lossy. The desktop SNR of about 28 dB is a waveform measure against the WAV, not a listening test, and nobody has listened to these exports yet.
- No tags beyond the encoder comment: no title or artist.
- Built and run on Windows only. CI covers macOS and Linux builds; I have not built there.
- Unrelated to OGG: 61 other packaged crates ship no licence file. This is a pre-existing gap in the package inventory.
- MP3 (F19) is still missing.
