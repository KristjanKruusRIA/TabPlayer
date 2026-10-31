# GP8 parity A23: drum-element mix (2026-10-31)

GP8 row A23 adds drum-element volume, pan, mute and solo for percussion tracks. Today only a track-wide mix existed. For a percussion track, the player can now mix kit elements (kick, snare, hats, toms, cymbals, other), grouped from GM percussion note numbers.

## Behavior
- **GM Note Grouping:** GM percussion notes route to 6 kit elements:
  - `kick`: MIDI 35, 36
  - `snare`: MIDI 37, 38, 40
  - `hats`: MIDI 42, 44, 46
  - `toms`: MIDI 41, 43, 45, 47, 48, 50
  - `cymbals`: MIDI 49, 51, 52, 53, 55, 57, 59
  - `other`: all other MIDI drum notes.
- **Mix Parameters:** Each element has volume (0.0 to 1.0, default 1.0), stereo pan (-1.0 to 1.0, default 0.0), mute (boolean, default false), and solo (boolean, default false).
- **Settings Path & Zero Allocations:** Kit mixes persist on `ChannelMix.drumKit` via `setTrackMix`. Audio callbacks allocate zero bytes on the heap. Settings apply through the existing `setMix` path.
- **Bit-Identical Baseline Rendering:** Tracks without a kit mix (`mix.drumKit` is `None`) render with a single synthesizer, producing bit-identical output to the previous release.
- **UI:** Rendered in `DrumKitPanel` under the Sound tab when a percussion track is selected. Controls stay focusable while busy (`aria-disabled`), re-selecting current values records nothing, and one gesture produces one undoable edit. Non-percussion tracks hide the panel.

## Evidence
- **Rust audio rendering:** `cargo test --release --manifest-path src-tauri/Cargo.toml --test audio_drum_mix` passes all 2 tests (`document_without_kit_mix_renders_bit_identically` and `drum_kit_element_mix_applies_volume_pan_mute_solo`).
- **Rust no-heap allocations:** `cargo test --release --manifest-path src-tauri/Cargo.toml --test audio_render` passes 28 tests including `render_seek_and_prepared_mix_install_do_not_touch_heap`.
- **Rust protocol:** `cargo test --release --manifest-path src-tauri/Cargo.toml --test protocol` passes all 9 tests.
- **TypeScript & Vitest:**
  - `npx tsc --noEmit -p .` passes with 0 errors.
  - `src/App.test.tsx` passes 143 of 143 tests with 60s timeout.
  - `src/audio/drum-kit.test.ts` passes 5 of 5 tests (including old `.tabplayer` replay).
  - `src/audio/NativePlaybackController.test.ts` passes 61 tests (with 1 skipped).
  - `src/audio/DrumKitPanel.test.tsx` passes 6 of 6 tests.
  - `src/document-settings.test.ts`, `src/engine.test.ts`, `src/audio/interpretation.test.ts` pass all 76 tests.

## Review
Pending.

## Limits
- **SoundFont dependency:** Synthesis uses the SoundFont GM bank instrument assignments for standard GM drum kits (bank 128 / channel 9); non-standard custom percussion maps are grouped as `other`.
- **Export interchange:** Kit mixes are stored in TabPlayer documents (`.tabplayer`) and replayed in audio playback and export; GP files do not store element-level kit sub-mixes.
