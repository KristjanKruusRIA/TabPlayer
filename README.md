# TabPlayer

A local Rust/Tauri desktop player and editor for guitar and bass tablature. Rust owns document history, file saving, audio rendering and exports. React and alphaTab 1.8.4 provide notation and public score/MIDI generation.

The 0.2.0 expansion implements the advanced editor, native recorded guitar/bass engine, backing audio and PDF/MIDI/WAV exports. Listening accepted the original clean/bass and revised crunch/lead previews; their history is recorded in the audit. All 17 authorized private scores pass native plan checks. Windows baseline editor/audio/export/restart smoke and both extracted installer resource inventories passed. One final review found eight Important issues; fixes and fresh joined/native checks are in progress. Updated shipping builds, corrected remote CI, installer lifecycle and main integration remain pending. See the [expansion validation audit](docs/validation/2026-10-14-tabplayer-expansion.md).

## Using the app

Open `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5`, or `.tabplayer`. Select a track and click a note or beat; the inspector also targets empty strings and rests. Enter a fret and select **Set note**. Add notes on other strings to form a chord. Arrow keys navigate when the score workspace has focus; digits followed by Enter enter a fret.

The inspector edits note and beat techniques, bends/whammy curves, harmonics, slides, ties, hammer/pull links, slurs, trill, vibrato, brush and tremolo. Editing either end of a tie changes its sustained pitch; breaking a link permits independent editing. Deletion repairs both relationship ends. Empty measures, including imported ones, use **Insert beat** before note entry.

Rhythm controls support double/quadruple whole notes through 256ths, zero–three dots, tuplets and grace notes. Measure controls include meter, pickup/free time, repeats/endings, sections and tempo points. Bar/beat controls include key, clef, text and chord diagrams. Staff settings cover tuning, capo, transposition and notation visibility; staves support one–four aligned voices with range copying. Track controls include existing names, all 128 General MIDI programs and system layout.

String numbers follow alphaTab: lowest string is 1; the highest string of a six-string guitar is 6. Tuning fields use scientific note names with octaves, high to low: standard guitar is `E4 B3 G3 D3 A2 E2`, bass `G2 D2 A1 E1`. Enter space- or comma-separated notes; naturals, sharps/flats and ASCII/Unicode accidentals are accepted (`C#4`, `Db4`, `C♯4`, `D♭4`). Readback uses canonical sharps. Supported pitches span C-1–G9; projects retain numeric MIDI pitches internally. Existing staves can be retuned while retaining their string count. The String selector includes each open-string note. Measure/beat selectors accept whole numbers; blank, fractional and non-finite drafts leave selection intact. Inspector values refresh after undo, redo and document replacement.

Save creates a schema-v2 `.tabplayer` project with immutable original score bytes/SHA-256, applied edits and content-addressed audio assets. Version 1 projects migrate in memory and save as version 2. Imported or edited backing audio is embedded in the project; reopening does not require its original file. Runtime snapshots contain asset metadata, keeping large audio bytes native. Candidate validation precedes native commit; rejected edits/open operations leave the working document and history intact. Undo retains assets needed by redo; a saved applied-history copy can omit unused assets.

GP imports need a new native save destination. Original score/backing paths, including assets retained for redo, and byte-identical copies are protected from replacement. Writes use atomic replacement. Native projects preserve source data independently of interchange export.

Play uses the Rust sample clock and CPAL output with recorded guitar/bass libraries and a bundled General MIDI fallback for other instruments/percussion. Sound controls select automatic/explicit voices, clean/crunch/lead/bass/bypass presets and gate, compressor, amp, cabinet, EQ, chorus, delay and reverb. Backing imports support WAV, FLAC, MP3 and Ogg Vorbis, with offset and repeat-occurrence synchronization anchors. Original embedded backing and its source anchors are retained.

Practice controls provide speed, seeking, inclusive measure loops, metronome and output-device selection. Track gain/pan/mute/solo, sound/effects, backing selection/alignment and print layout are undoable document settings. They follow stable track identities through deletion and undo. Settings-only edits/undo reuse the current score and playback generation. Music edits/undo/redo stop at tick zero and clear the loop, retaining current speed/metronome; successful New/Open resets practice to 100%/metronome off and adopts that document's settings. Selection, zoom, transport position, practice speed and loops remain session controls.

Each track's delay storage is bounded to 16 seconds; longer requested tempo-delay taps are clamped to 16 seconds. Low-tempo and exact-cap native regressions pass. Normal accepted preset coefficients remain unchanged; joined verification and rebuilt UI checks remain pending in the audit.

**Export** provides GP, vector PDF/native PDF-viewer print handoff, standard MIDI, mixed WAV and aligned WAV stems. Select tracks/staves and an inclusive measure range; PDF supports A4/Letter, orientation, margins, scale and score/tab profiles. WAV supports 44.1/48 kHz, 16/24-bit PCM, practice-speed selection, backing, metronome and effect tails. Live and offline audio share the Rust renderer/effects. Export cancellation/failure preserves prior outputs; exporting does not mark the project saved.

GP ranges initialize inherited tempo/sound/controller state and retain repeat groups only when their complete context is selected. The public GP writer can still omit per-note dynamics, bend/whammy styles/interior points, BuzzRoll style, explicit phrase slurs and in-range volume/pan automation. Native replay and selected models preserve those supported edits; keep the native project. Standard MIDI carries generated notes/programs/tempo/controllers, with distinct melodic track channels and corrected dead/brush note endings. Export up to 15 melodic tracks together; percussion uses channel 9. Ordinary MIDI players share pitch bends within a channel, so simultaneous independent bends can differ. Original Guitar Pro runtime acceptance remains unverified.

## Development

Rust **1.88 or newer** is required; CI uses exact Rust **1.88.0** and Node **24.20.0** for Windows x64, macOS arm64 and Linux x64. Local baseline verification used Rust 1.99. The first remote run passed prepared resources and all three frontend jobs but failed every native job because pinned ringbuf 0.5.3 uses let chains unsupported by Rust 1.85.1. An isolated actual-dependency probe verified 1.85.1 failure/1.88.0 success; the corrected full matrix remains pending. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) and keep Cargo on PATH. Windows needs MSVC Build Tools/WebView2; Linux audio builds also need ALSA development headers.

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

The standalone Windows executable is in `src-tauri/target/release/tabplayer.exe`; installers are under `src-tauri/target/release/bundle/msi` and `bundle/nsis`. Cargo flags such as `--locked` follow the final `--`; Tauri's build parser does not accept them directly. Build on the corresponding host for other platforms:

```sh
# macOS
npm run tauri -- build --bundles 'app,dmg' -- --locked
# Linux
npm run tauri -- build --bundles 'deb,appimage' -- --locked
```

[Desktop CI](.github/workflows/desktop.yml) tests and builds unsigned packages, extracts each format and verifies actual sample hashes, mappings, licenses and absence of private media. Small reports are retained; large installers require explicit `upload_packages`. The first remote native matrix failed before packaging; its corrected Rust 1.88.0 rerun is pending. Windows baseline MSI/NSIS extraction verified all 3,864 recordings/4,204 regions and licenses, but those packages predate review fixes and the offline WebView installer configuration and will be rebuilt. Installer lifecycle, other-platform device/print checks and signing/notarization remain separate evidence requirements.

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
