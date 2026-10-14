# TabPlayer

A local Rust/Tauri desktop player and editor for guitar and bass tablature. Rust owns document history, file saving, audio rendering and exports. React and alphaTab 1.8.4 provide notation and public score/MIDI generation.

The 0.2.0 expansion implements the advanced editor, native recorded guitar/bass engine, backing audio and PDF/MIDI/WAV exports, plus 25 tuning presets and realistic instrument views. All eight expansion review findings are fixed in `ac0ece7`; all 17 authorized private scores pass native plans and chronological per-attack program agreement. Fresh Windows preset/custom/history/restart and native guitar/bass/drums/keys checks pass. Ordinary frontend checks pass 383 tests plus 10 resource/package tests and typecheck; the independent targeted review found no Critical or Important issues. Fresh Windows installers pass installation, offline playback and removal; feature-head macOS/Linux tests, packaging and extracted-resource checks pass. Windows CI packaging is the remaining release check. See the [expansion audit](docs/validation/2026-10-14-tabplayer-expansion.md) and [tuning/view validation](docs/validation/2026-10-15-tunings-and-instrument-views.md) for evidence and platform/interchange limits.

## Using the app

Open `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5`, or `.tabplayer`. Select a track and click a note or beat; the inspector also targets empty strings and rests. Enter a fret and select **Set note**. Add notes on other strings to form a chord. Arrow keys navigate when the score workspace has focus; digits followed by Enter enter a fret.

The inspector edits note and beat techniques, bends/whammy curves, harmonics, slides, ties, hammer/pull links, slurs, trill, vibrato, brush and tremolo. Editing either end of a tie changes its sustained pitch; breaking a link permits independent editing. Deletion repairs both relationship ends. Empty measures, including imported ones, use **Insert beat** before note entry.

Rhythm controls support double/quadruple whole notes through 256ths, zero–three dots, tuplets and grace notes. Measure controls include meter, pickup/free time, repeats/endings, sections and tempo points. Bar/beat controls include key, clef, text and chord diagrams. Staff settings cover tuning, capo, transposition and notation visibility; staves support one–four aligned voices with range copying. Track controls include existing names, all 128 General MIDI programs and system layout.

String numbers follow alphaTab: lowest string is 1; the highest string of a six-string guitar is 6. Tuning fields use scientific note names with octaves, high to low: standard guitar is `E4 B3 G3 D3 A2 E2`, bass `G2 D2 A1 E1`. Enter space- or comma-separated notes; naturals, sharps/flats and ASCII/Unicode accidentals are accepted (`C#4`, `Db4`, `C♯4`, `D♭4`). Readback uses canonical sharps. Supported pitches span C-1–G9; projects retain numeric MIDI pitches internally. Existing staves can be retuned while retaining their string count. The String selector includes each open-string note. Measure/beat selectors accept whole numbers; blank, fractional and non-finite drafts leave selection intact. Inspector values refresh after undo, redo and document replacement.

Choose from **25 tuning presets** grouped by guitar (6–9 strings) and bass (4–6 strings), or choose **Custom** and enter your own notes. Selecting a preset fills the draft; Apply tuning, Add track or Apply staff settings commits it with ordinary undo/redo. For an existing staff, choose a preset with its current string count; use Add instrument to create a different string count. The catalog is a selection of common standard, drop and open tunings, rather than a statistical popularity ranking.

Select **Show instrument** above the score to display the selected track's played notes on a guitar, bass, acoustic drum kit or keyboard. Auto follows the instrument family; the mode selector also allows manual choice. Guitar and bass show the actual staff tuning, capo, strings and fret positions. Keyboard and drum modes include all selected-track staves. Highlights follow native playback, including speed, seek and loop changes; pausing keeps the current positions for study and Stop clears them. This view does not edit the score.

Save creates a schema-v2 `.tabplayer` project with immutable original score bytes/SHA-256, applied edits and content-addressed audio assets. Version 1 projects migrate in memory and save as version 2. Imported or edited backing audio is embedded in the project; reopening does not require its original file. Runtime snapshots contain asset metadata, keeping large audio bytes native. Validation precedes native edit/open/history commit; rejected edits, open, Undo and Redo leave the working document and history intact. Undo retains assets needed by redo; a saved applied-history copy can omit unused assets.

GP imports need a new native save destination. Original score/backing paths, including assets retained for redo, and byte-identical copies are protected from replacement. Writes use atomic replacement. Native projects preserve source data independently of interchange export.

Play uses the Rust sample clock and CPAL output with recorded guitar/bass libraries and a bundled General MIDI fallback for other instruments/percussion. Automatic voices follow each attack's program and channel; imported volume, pan, expression and sustain controls affect recorded playback. Explicit voices stay fixed. Sound controls select automatic/explicit voices, clean/crunch/lead/bass/bypass presets and gate, compressor, amp, cabinet, EQ, chorus, delay and reverb. Backing imports support WAV, FLAC, MP3 and Ogg Vorbis, with offset and repeat-occurrence synchronization anchors. Original embedded backing and its source anchors are retained.

Practice controls provide speed, seeking, inclusive measure loops, metronome and output-device selection. Track gain/pan/mute/solo, sound/effects, backing selection/alignment and print layout are undoable document settings. They follow stable track identities through deletion and undo. Settings-only edits/undo reuse the current score and playback generation. Music edits/undo/redo stop at tick zero and clear the loop, retaining current speed/metronome; successful New/Open resets practice to 100%/metronome off and adopts that document's settings. Selection, zoom, transport position, practice speed and loops remain session controls.

Each track's delay storage is bounded to 16 seconds; longer requested tempo-delay taps are clamped to 16 seconds. Low-tempo, exact-cap and joined native regressions pass. Normal preset coefficients remain unchanged.

**Export** provides GP, vector PDF/native PDF-viewer print handoff, standard MIDI, mixed WAV and aligned WAV stems. Select tracks/staves and an inclusive measure range; PDF supports A4/Letter, orientation, margins, scale and score/tab profiles. WAV supports 44.1/48 kHz, 16/24-bit PCM, practice-speed selection, backing, metronome and effect tails. Live and offline audio share the Rust renderer/effects. Export cancellation/failure preserves prior outputs; exporting does not mark the project saved.

GP ranges initialize inherited tempo/sound/controller state and retain repeat groups only when their complete context is selected. The public GP writer can still omit per-note dynamics, bend/whammy styles/interior points, BuzzRoll style, explicit phrase slurs and in-range volume/pan automation. Native replay and selected models preserve those supported edits; keep the native project. Standard MIDI carries generated notes/programs/tempo/controllers, with distinct melodic track channels and corrected dead/brush note endings. Export up to 15 melodic tracks together; percussion uses channel 9. Ordinary MIDI players share pitch bends within a channel, so simultaneous independent bends can differ. Original Guitar Pro runtime acceptance remains unverified.

## Development

Rust **1.88 or newer** is required; CI uses exact Rust **1.88.0** and Node **24.20.0** for Windows x64, macOS arm64 and Linux x64. Local native tests and desktop builds pass with actual Rust 1.88.0. Fresh feature-head macOS/Linux native/package checks pass; Windows CI packaging is finishing. The Linux workflow reclaims only completed test output and unused hosted SDKs before requiring 20 GiB free; its verified run had 26 GiB available and built/extracted both packages successfully. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) and keep Cargo on PATH. Windows development needs MSVC Build Tools/WebView2; shipping MSI/NSIS embed the offline WebView2 runtime installer. Linux audio builds also need ALSA development headers.

The prepared recorded resource pack contains 3,864 recordings/4,204 mappings and 1,621,552,270 sample bytes (about 1.62 GB), plus the GM SoundFont, fonts and notices. This is resource size, not installer size or decoded memory use. Preparation downloads pinned public CC0 sources at setup/build, verifies SHA-256 inventories and bundles exact licenses. Playback uses local resources. Score preparation selectively decodes required recordings. See [third-party notices](THIRD_PARTY_NOTICES.md).

```powershell
npm ci
npm run prepare:audio
npm run tauri -- dev
```

```powershell
npm test
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node scripts/prepare-audio.mjs --offline
```

Public compatibility fixtures are downloaded from pinned URLs and checked by SHA-256 into ignored `.analysis/compatibility`. Optional private tests can be staged locally:

```powershell
./scripts/prepare-private-corpus.ps1 -SourceDirectory '<authorized GP folder>'
npm test
```

Private scores, extracted binaries and generated test outputs are excluded from Git and distribution.

The full recorded-bank/resource tests and actual output-device probe are explicit checks:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_resources -- --ignored --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_render -- --ignored --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_transport -- --include-ignored --nocapture
```

## Build

```powershell
npm run tauri -- build --bundles 'msi,nsis' -- --locked
```

Windows installers are under `src-tauri/target/release/bundle/msi` and `bundle/nsis`. Use an installer for normal use; the native executable requires its bundled `audio/` resources alongside it. Cargo flags such as `--locked` follow the final `--`; Tauri's build parser does not accept them directly. Build on the corresponding host for other platforms:

```sh
# macOS
npm run tauri -- build --bundles 'app,dmg' -- --locked
# Linux
npm run tauri -- build --bundles 'deb,appimage' -- --locked
```

[Desktop CI](.github/workflows/desktop.yml) tests and builds unsigned packages, extracts each format and verifies actual sample hashes, mappings, licenses and absence of private media. Small reports are retained; large installers require explicit `upload_packages`. Final Rust 1.88 Windows MSI/NSIS builds measure about 1.52/1.29 GiB; both extracted inventories and installed NSIS resources passed. They embed a 214,090,448-byte offline WebView2 runtime installer with a valid Microsoft signature. Feature-head CI run `38641519103` passes macOS app/DMG and Linux deb/AppImage native/package/resource checks; Windows packaging remains active. The installed production executable passed offline notation/edit/presets/Custom/active instrument highlights/native audio, with `desktop_test_io` absent. NSIS installation/uninstallation both exited successfully and the application/resources/registration were removed. Preferences and user app data were retained; earlier manual test-preference cleanup was policy-rejected and was not retried. Physical macOS/Linux audio/print, original Guitar Pro runtime acceptance and publisher signing/notarization remain unverified limits.

After extracting an installer/application, inspect its resources without launching it or fetching data:

```sh
node scripts/verify-packaged-resources.mjs --package-root '<extracted package>' --report '.analysis/package-resources.json'
```

For Windows desktop integration tests, build an isolated test executable:

```powershell
./scripts/build-desktop-test.ps1
$env:TABPLAYER_TEST_GP='<authorized private GP file>'
cargo build --locked --manifest-path src-tauri/Cargo.toml --example capture_loopback
node tests/desktop/advanced-editor.mjs
node tests/desktop/native-audio.mjs
node tests/desktop/exports.mjs
node tests/desktop/performance.mjs
```

Run desktop harnesses serially; they share one native app/debug port. The audio harness uses the Windows loopback helper above. This explicit build enables Cargo feature `desktop-test` and Vite flag `VITE_DESKTOP_TEST=1`; hooks also require runtime `TABPLAYER_DESKTOP_TEST=1`, set by the harness. It shares production staging, atomic writes, source protection and export functions, with predetermined paths. Normal shipping builds exclude these hooks and use file dialogs. The test build's audio junction verifies integration; extracted shipping-package inspection verifies bundled resources separately.

`tests/desktop/audio.mjs` forwards to `native-audio.mjs`. The native audio smoke also saves, restarts and reopens backing audio with only its authored source WAV temporarily moved within the workspace, then restores it. `tests/desktop/review-regressions.mjs` checks the earlier editing, triple-dot export/reimport and mixer history regressions against native callback status.

See the [expansion audit](docs/validation/2026-10-14-tabplayer-expansion.md), [approved expansion scope](docs/superpowers/specs/2026-10-14-tabplayer-deferred-features-design.md), and historical [first-milestone validation](docs/validation/2026-10-14-tabplayer-milestone.md).
