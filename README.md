# TabPlayer

A first Rust/Tauri desktop player and editor for guitar and bass tablature. Rust owns document history and file saving; React and alphaTab 1.8.4 render notation and synthesize audio.

The Windows x64 build is verified. macOS and Linux use the same source and Tauri configuration; their builds and audio remain unverified. This milestone is an independent alternative with basic editing, rather than full Guitar Pro feature parity.

## Using the app

Open `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5`, or `.tabplayer`. Select a track and click a note or beat; the inspector also targets empty strings and rests. Enter a fret and select **Set note**. Add notes on other strings to form a chord. Arrow keys navigate when the score workspace has focus; digits followed by Enter enter a fret.

Rhythms support up to three dots, including correct tuplet timing. Editing either end of a tied note changes its whole sustained pitch. Deleting a note detaches its ties, slides, slurs and hammer/pull relationships. Empty measures, including imported ones, use **Insert beat** before note entry.

String numbers follow alphaTab: lowest string is 1; the highest string of a six-string guitar is 6. Tuning fields accept comma-separated MIDI pitches, high to low; standard guitar is `64,59,55,50,45,40`. Track names and MIDI instruments are chosen when adding a track. Existing tracks can be retuned while retaining their string count.

Save creates a `.tabplayer` project containing original score bytes, their SHA-256, and applied edits. Undo/redo is native history. GP imports need a new native destination. Source paths and byte-identical source copies are protected from replacement. Export GP rebuilds the score and warns about possible changes to imported techniques, layout and sound settings; keep the native project for preservation.

Play uses a bundled General MIDI SoundFont. Practice controls provide speed, first-occurrence measure seeking, inclusive measure loops, metronome, mute, solo and relative track volume. Edits stop playback and clear the loop. Practice settings are session controls. This version does not recreate Guitar Pro's RSE sound, add advanced techniques, mix backing audio, or export PDF/MIDI/audio.

Mixer settings follow an instrument through track deletion and undo/redo. New/Open resets the session mix. Use whole numbers in measure and beat selectors; fractional entries have a known selection-handler error and leave the document intact.

## Development

Verified toolchain: Node 24.20, Rust 1.99, Windows MSVC Build Tools and WebView2. Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS and keep Cargo on PATH.

```powershell
npm ci
npm run tauri -- dev
```

```powershell
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --tests
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Public compatibility fixtures are downloaded from pinned URLs and checked by SHA-256 into ignored `.analysis/compatibility`. Optional private tests can be staged locally:

```powershell
./scripts/prepare-private-corpus.ps1 -SourceDirectory '<authorized GP folder>'
npm test
```

Private scores, extracted binaries and generated test outputs are excluded from Git and distribution.

## Build

```powershell
npm run tauri -- build --bundles nsis
```

The standalone executable is in `src-tauri/target/release/tabplayer.exe`; the Windows installer is under `src-tauri/target/release/bundle/nsis`. Other platforms use `npm run tauri -- build` on that platform. Builds copy official alphaTab assets and licence notices into the embedded frontend. See [third-party notices](THIRD_PARTY_NOTICES.md).

For Windows desktop integration tests, build an isolated test executable:

```powershell
./scripts/build-desktop-test.ps1
$env:TABPLAYER_TEST_GP='<authorized private GP file>'
node tests/desktop/roundtrip.mjs
node tests/desktop/review-regressions.mjs
```

This explicit build enables both Cargo feature `desktop-test` and Vite flag `VITE_DESKTOP_TEST=1`. The native hook also requires runtime `TABPLAYER_DESKTOP_TEST=1`, which the harness sets. It uses the same native staging, atomic saving, protection and export functions as production, with predetermined paths. Export confirmation is bypassed only in this test build. Normal builds exclude the native hook and use file dialogs.

See [validation evidence](docs/validation/2026-10-14-tabplayer-milestone.md) and the [approved design](docs/superpowers/specs/2026-10-14-tabplayer-design.md).
