# GM-only bundled audio & optional Guitar Pro 8 runtime soundbanks — validation, 2026-11-21

Windows desktop validation on branch `develop` after removing bundled recorded instruments/drums (`Karoryfer`, `BMC Slap Bass`, `Virtuosity Drums`) and adding optional native runtime playback from a user's locally installed Guitar Pro 8 standard soundbank (`com.arobas-music.soundbank.standard`).

## Summary of changes

- **Bundled audio stripped to General MIDI only**
  - Cleared `sources` in `assets/audio/sources.json`, retaining only the pinned General MIDI SoundFont (`@coderline/alphatab` `1.8.4` `sonivox.sf2`, SHA-256 `4978cf37e7164206f2d22dc4fdf4020ffe040787210bf781e31bdc79961f59ef`, 1,351,896 bytes).
  - Removed obsolete bundled inventory/manifest/license files (`assets/audio/{guitar,bass,slap,drums}-inventory.json`, `assets/audio/licenses/`, `assets/audio/slap/`, `assets/audio/drums/`, `src-tauri/src/audio/kit_processing.rs`, `src-tauri/tests/kit_common/`).
  - Updated `scripts/prepare-audio.mjs`, `scripts/verify-packaged-resources.mjs`, `scripts/copy-notices.mjs`, `THIRD_PARTY_NOTICES.md`, `assets/audio/README.md`, and `.github/workflows/desktop.yml` to prepare/verify the GM-only audio directory and prune stale recorded assets without following links.
  - Packaged resource footprint in `src-tauri/resources/audio/` reduced from ~1,744.1 MB (recorded samples + SF2 + licenses) to **4 files totaling 1,364,345 bytes (~1.30 MiB)**:
    - `soundfont/sonivox.sf2`: 1,351,896 bytes
    - `licenses/Apache-2.0.txt`: 11,560 bytes
    - `soundfont/LICENSE`: 561 bytes
    - `manifest.json`: 328 bytes
- **Optional GP8 runtime soundbank reader (`src-tauri/src/audio/gp8_soundbanks.rs`)**
  - Detects standard Arobas Music soundbank locations (`%ProgramData%\Arobas Music\Soundbanks\com.arobas-music.soundbank.standard` on Windows, `/Library/Application Support/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard` on macOS, or user-configured custom/parent folders) with path confinement, regular-file checks, size caps, and atomic epoch tracking (`EPOCH` plus per-thread `THREAD_EPOCH` for parallel test isolation).
  - Implements a bounded seek-on-demand `AMARCHIVE` v1 archive reader and zero-dependency `Samples.xml` parser (`SoundBank`, `SamplesTree`, `Node`, `Samples`, `Sample`, `Wave`), eager pickup discovery for electric guitars/basses/fretless basses (`bridge`, `middle`, `neck`), lazy bank XML parsing, and a bounded 256 MiB Ogg Vorbis decoded PCM cache (`PcmCache`).
  - Supports all 99 `instrumentSet` categories across the standard GP8 soundbank, GM program 0–127 automatic resolution, drum kit mapping (`Drumkit-Custom`, `Drumkit-Oak`, `Drumkit-Vintage`, `@brush` beater filtering), hi-hat exclusive choke groups, dedicated cymbal `choke` samples, auxiliary percussion banks (`1, 2, 35..=87`), recorded `repitch` (`tuning_cents`), `gain` in dB, recorded harmonic bypass of the synthetic 700 Hz HPF (`voices.rs`), and graceful notice-reporting fallback to GM `sonivox.sf2` on missing or malformed assets. `src-tauri/src/audio/tone.rs` was left untouched.
- **Settings schema, playback wiring, UI, Mixer & i18n**
  - Added persisted `AppSettings.soundbanks` (`enabled`, `path`) in `src-tauri/src/app_settings.rs` and Tauri commands `soundbanks_status`, `soundbanks_configure` (which persists settings and triggers `AudioService::reload_soundbanks`), and `soundbanks_pick_folder` in `src-tauri/src/lib.rs`.
  - Added `TrackSound.pickup` (`bridge` | `middle` | `neck`) and GP8 set ID / legacy `.tabplayer` voice validation across `src-tauri/src/settings.rs`, `src/edit-types.ts`, and `src/document-settings.ts`, mapping legacy `green-guitar`, `black-guitar`, `darkblack-bass`, and `babyblue-bass` IDs to GP8 equivalents when active or GM when unavailable.
  - Added `src/audio/soundbank-store.ts`, `src/audio/SoundbankSettingsPanel.tsx` (View menu configuration panel), and `src/audio/SoundSourceOptions.tsx`, updating `SoundSummary.tsx`, `SoundPanel.tsx`, `SourcePicker.tsx`, `SourceArt.tsx`, `MixerView.tsx`, `App.tsx`, and localization dictionaries (`src/i18n/{en,et,de}.ts`).

## Verification (final state)

- `npm run prepare:audio` -> exit 0 (`Verified GM SoundFont audio (1351896 bytes)`).
- `node scripts/prepare-audio.mjs --offline` -> exit 0 (`Verified offline GM SoundFont audio (1351896 bytes)`).
- `npm run typecheck` -> exit 0 (`tsc --noEmit`).
- `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` -> exit 0 (0 formatting diffs).
- `npm test` -> exit 0:
  - Node script tests (`node --test ...`): 70 tests — **68 passed, 0 failed, 2 skipped** (symlink tests skipped on Windows due to `EPERM`).
  - Vitest (`vitest run`): **468 passed | 4 skipped (472 files)**; **7,800 passed | 5 skipped (7,805 tests)** — 0 failed (the 4 skipped files are pre-existing environment/corpus-gated specs: `src/engine.in-place.owner.test.ts`, `src/private-corpus.test.ts`, `src/editor/corpus.test.ts`, `src/interchange/gp8-acceptance-kit-write.test.ts`).
- `cargo test --locked --workspace --manifest-path src-tauri/Cargo.toml` -> exit 0:
  - **2,359 passed, 0 failed, 126 ignored** across all workspace crates (`tabplayer`, `tabplayer-plugin-host`, `tabplayer-plugin-protocol`, `tabplayer-test-plugin`), including `audio_gp8_soundbanks` (5 passed, 1 ignored), `audio_palm_mute_identity` (1 passed), `audio_render` (40 passed, 1 ignored), `audio_recorded_kit` (7 passed), `audio_resources` (7 passed, 1 ignored), and all `audio::device` tests (78 passed, 1 ignored).
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_gp8_soundbanks -- --ignored --nocapture` -> exit 0:
  - `real_installed_gp8_soundbank_smoke` **1 passed, 0 failed** against locally installed `C:\ProgramData\Arobas Music\Soundbanks\com.arobas-music.soundbank.standard` (validated catalog scan of >=350 sets, electric guitar/bass pickups, harmonics, palm mutes, slap/pop bass, keys, strings, winds, drums, choked crash, auxiliary percussion, zero notices, finite mixed stereo output).

## Limits

- Tested and executed on Windows; macOS default path resolution (`/Library/Application Support/Arobas Music/Soundbanks/com.arobas-music.soundbank.standard`) was verified by path logic review rather than executed on macOS hardware.
- On Windows without elevated Developer Mode symlink privileges, `prepare-audio.test.mjs` and `verify-packaged-resources.test.mjs` skip their file-symlink test cases (`EPERM`).
- Proprietary Guitar Pro 8 soundbank archives are read strictly from the user's local installation at runtime and are never bundled or redistributed in this repository.
