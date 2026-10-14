# TabPlayer

A local Rust/Tauri desktop player and editor for guitar and bass tablature. Rust owns document history, file saving, audio rendering and exports. React and alphaTab 1.8.4 provide notation and public score/MIDI generation.

The 0.2.0 expansion implements the advanced editor, native recorded guitar/bass engine, backing audio and PDF/MIDI/WAV exports. All four sound presets have listening acceptance, all 17 authorized private scores pass native plan checks, and the Windows offline audio smoke/independent WASAPI loopback passed. Joined tests/typecheck/format pass; expanded editor/export/restart smoke, shipping packages, remote platform CI, the independent final review and post-review checks remain pending. See the [expansion validation audit](docs/validation/2026-10-14-tabplayer-expansion.md) for evidence and open checks.

## Using the app

Open `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5`, or `.tabplayer`. Select a track and click a note or beat; the inspector also targets empty strings and rests. Enter a fret and select **Set note**. Add notes on other strings to form a chord. Arrow keys navigate when the score workspace has focus; digits followed by Enter enter a fret.

The inspector edits note and beat techniques, bends/whammy curves, harmonics, slides, ties, hammer/pull links, slurs, trill, vibrato, brush and tremolo. Editing either end of a tie changes its sustained pitch; breaking a link permits independent editing. Deletion repairs both relationship ends. Empty measures, including imported ones, use **Insert beat** before note entry.

Rhythm controls support double/quadruple whole notes through 256ths, zero–three dots, tuplets and grace notes. Measure controls include meter, pickup/free time, repeats/endings, sections and tempo points. Bar/beat controls include key, clef, text and chord diagrams. Staff settings cover tuning, capo, transposition and notation visibility; staves support one–four aligned voices with range copying. Track controls include existing names, all 128 General MIDI programs and system layout.

String numbers follow alphaTab: lowest string is 1; the highest string of a six-string guitar is 6. Tuning fields accept comma-separated MIDI pitches, high to low; standard guitar is `64,59,55,50,45,40`. Existing staves can be retuned while retaining their string count. Measure/beat selectors accept whole numbers; blank, fractional and non-finite drafts leave the current selection intact. Inspector values refresh after undo, redo and document replacement.

Save creates a schema-v2 `.tabplayer` project with immutable original score bytes/SHA-256, applied edits and content-addressed audio assets. Version 1 projects migrate in memory and save as version 2. Imported or edited backing audio is embedded in the project; reopening does not require its original file. Runtime snapshots contain asset metadata, keeping large audio bytes native. Candidate validation precedes native commit; rejected edits/open operations leave the working document and history intact. Undo retains assets needed by redo; a saved applied-history copy can omit unused assets.

GP imports need a new native save destination. Original score/backing paths, including assets retained for redo, and byte-identical copies are protected from replacement. Writes use atomic replacement. Native projects preserve source data independently of interchange export.

Play uses the Rust sample clock and CPAL output with recorded guitar/bass libraries and a bundled General MIDI fallback for other instruments/percussion. Sound controls select automatic/explicit voices, clean/crunch/lead/bass/bypass presets and gate, compressor, amp, cabinet, EQ, chorus, delay and reverb. Backing imports support WAV, FLAC, MP3 and Ogg Vorbis, with offset and repeat-occurrence synchronization anchors. Original embedded backing and its source anchors are retained.

Practice controls provide speed, seeking, inclusive measure loops, metronome and output-device selection. Track gain/pan/mute/solo, sound/effects, backing selection/alignment and print layout are undoable document settings. They follow stable track identities through deletion and undo. Settings-only edits/undo reuse the current score and playback generation; music edits prepare a new score. New/Open adopts that document's settings. Selection, zoom, transport position, practice speed and loops remain session controls.

**Export** provides GP, vector PDF/native PDF-viewer print handoff, standard MIDI, mixed WAV and aligned WAV stems. Select tracks/staves and an inclusive measure range; PDF supports A4/Letter, orientation, margins, scale and score/tab profiles. WAV supports 44.1/48 kHz, 16/24-bit PCM, practice-speed selection, backing, metronome and effect tails. Live and offline audio share the Rust renderer/effects. Export cancellation/failure preserves prior outputs; exporting does not mark the project saved.

GP export/reimport has measured omissions: per-note dynamics can change, bend/whammy styles and interior curve points can be lost, BuzzRoll tremolo style becomes Default, and an explicit cross-string phrase slur is omitted by the public GP writer. Native replay and selected PDF models preserve that phrase. Keep the native project for exact supported edit replay. Standard MIDI carries generated notes/programs/tempo/controllers, with distinct melodic track channels and corrected dead/brush note endings. Export up to 15 melodic tracks together; percussion uses channel 9. Ordinary MIDI players share pitch bends within a channel, so simultaneous independent bends can differ. Original Guitar Pro runtime acceptance remains unverified.

## Development

Local verification uses Node 24.20 and Rust 1.99 on Windows with MSVC Build Tools and WebView2. CI is configured for Node 24.20.0/Rust 1.85.1 and Windows x64, macOS arm64 and Linux x64; remote compilation/MSRV evidence is pending. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) and keep Cargo on PATH. Linux audio builds also need ALSA development headers.

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

[Desktop CI](.github/workflows/desktop.yml) runs tests and unsigned shipping builds, extracts each package and verifies actual sample hashes, mappings, licenses and absence of private media. Small resource/hash reports are retained; large installers require the workflow's explicit `upload_packages` input. Configuration/lint are verified; completed remote jobs and fresh expansion shipping packages are pending. Native installer lifecycle, device playback, print handoff and signing/notarization need separate host evidence.

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
