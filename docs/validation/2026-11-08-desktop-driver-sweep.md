# Desktop driver sweep on develop (THE-50)

Date: 2026-11-08. Linear THE-50. The last recorded full sweep passed 58 of 80 drivers at `229ec0f`. Since then develop gained D08, D11, NAM captures and D12. This run is at develop `5df3e06`.

## Summary

- **99 of 105 app drivers pass** (a driver file counts once, however many groups it has). 3 fail and 3 were not run. The 4 driver self-test files also pass (42 of 42 tests).
- The 3 failures are `parity-resume-playback` (stale driver that could not be repaired here, with a possible product bug behind its next step), `parity-file-drop` (needs an interactive foreground window) and `parity-workstation` (a strict check that finds a UI bug, below).
- The 3 drivers not run (`parity-backing-processing`, `parity-backing-tempo`, `parity-score-layouts`) are gated on a reviewed build admission that only the controller can attest.
- Three drivers ran with reduced scope: `parity-file-library` without its manual folders group, `parity-recovery` without its explicit `performance` group, and `parity-workstation` with default flags only.
- 32 drivers failed at first. Driver edits fixed 29 of them. `parity-practice` needed only a prerequisite (the `capture_loopback` example). Two are still failing for their own reasons (`parity-resume-playback`, `parity-file-drop`). `parity-reload-recovery` did not fail; it got a precautionary edit. One driver that the edits had fixed, `parity-workstation`, fails again after review tightened its playback-error check, because the product overlaps the error line with a control (see UI bug). No product code changed.
- One UI bug is confirmed (the playback error line overlaps a control at 960 px). One more is suspected and unconfirmed: closing the window with unsaved changes showed no Unsaved score dialog in a probe (see Product bugs).

## Build and environment

- Source: develop `5df3e066904200fd3392c16f37bcc83320dcada8`, worktree `.worktrees/the-50-driver-sweep` on branch `chore/the-50-driver-sweep`. Driver edits are the only changes in the working tree.
- Build: `powershell -File scripts/build-desktop-test.ps1` with `RUSTUP_TOOLCHAIN=1.90.0` and `~/.cargo/bin` on PATH, default `src-tauri/target`. The release build took 3 min 35 s and finished 2026-11-08 03:24 (local). `.analysis/desktop-smoke/tabplayer.exe` and `src-tauri/target/release/tabplayer.exe` were byte-identical (SHA-256 `5a891a1d3f97eabcf5bc825ffdb799137c8f3fc9da5358dc0f3426f2a85bc488`). The standalone drivers ran against this binary; it was restored after each use of a packet binary.
- The build-packet drivers (`--run --build=<packet>`) freeze every file under `tests/desktop`, so each driver edit needed a new packet from `tests/desktop/string-count-build.mjs` (same commit, same toolchain, `STRING_COUNT_TARGET` set to the worktree default target). The final packet was built after the last driver edit, and the final packet results below come from it. Its executable differs from the standalone binary (different Tauri config, no pinned data directory). Earlier packet runs in the history were on earlier packets that differed only in other drivers.
- Node v24.22.1 (CI pins 24.20.0), Windows 11 (10.0.26300), default Python 3.15.2 (Python 3.12 also installed).
- Port 9223 was checked free before every driver. Drivers ran one at a time through a runner that waited for the port to clear and stopped only the app it had started.
- Setup that is not in the repository, and not committed: junctions for `node_modules`, `.analysis/compatibility` and `src-tauri/resources/audio` to the main checkout; `copy-assets`, `prepare-fonts`, offline `prepare-audio` and `prepare-library`; the fixtures made by `engraving-fixture`, `instrument-fixture`, `document-tabs-fixture`, `practice-fixture`, `recovery-fixture` and `selection-playback-fixture`; `cargo build --example capture_loopback` (debug, default target); `.analysis/performance-project.tabplayer` copied from the main checkout; `TABPLAYER_TEST_GP` set to `.analysis/compatibility/guitarpro7-bends.gp` for `advanced-editor` and `roundtrip`. The first fixture tried, `guitarpro7-notes.gp`, has an over-full bar 1 that makes the rhythm step report overflow, and `guitarpro8-beat-tempo-change.gp` carries tempo changes that the measure form rejects once the driver has edited the beat.

## Results

Runs counts the sweep-level runs that reached a verdict: first sweep, rerun of each failure, final sweep. Interim runs while fixing a driver are not counted. In the history F is fail and P is pass. "Final line" is the last line the driver printed; JSON receipts end in a bracket, so for those the closing status is shown instead.

### Standalone drivers (`node tests/desktop/<name>.mjs`)

| Driver | Result | Runs | Run history | Final line | Classification |
|---|---|---|---|---|---|
| `advanced-editor` | PASS | 3 | F/F/P | Advanced native editor: curves, articulation, imported program, voice copy, staff, measure, key, chord, bass6/ | stale |
| `audio` | PASS | 1 | P | Native CPAL playback and independent bounded WASAPI loopback PCM, cursor, pause/seek/loop/speed, sound history | alias |
| `cancellation` | PASS | 3 | F/F/P | Close score Cancel preserves the dirty score, revision and active owner. | stale |
| `critique-fixes` | PASS | 4 | F/F/P/P | {"passed":true,"states":["new-1280","caret-beat-2","compact-960","compact-1280","compact-1600","expanded-1280" | stale. Rerun on HEAD 048708e after the review edits (6f18f99), build 5a891a1d: PASS. |
| `editor` | PASS | 3 | F/F/P | Native editor: two tracks, fret entry, real rendered note selection, native command history passed. | stale |
| `exports` | PASS | 2 | P/P | stems at 50% practice speed: native destination, valid output and immutable dirty snapshot passed. | none |
| `exports-per-track` | PASS | 2 | P/P | pdf one file per track: 1 Guitar9.pdf, 2 Bass6.pdf, 3 Drums.pdf, 4 Keys.pdf | none |
| `instruments` | PASS | 2 | P/P | Native instrument views passed: Guitar9/Bass6/Drums/Keys, exact plan IDs and pitches, selected track, chords,  | none |
| `native-audio` | PASS | 3 | F/F/P | Native CPAL playback and independent bounded WASAPI loopback PCM, cursor, pause/seek/loop/speed, sound history | stale+environment |
| `parity-aiff-export` | PASS | 3 | F/F/P | AIFF export passed: {"mix-44100-24":{"aiff":[2,24,44100,264600],"wav":[2,24,44100,264600],"same":true,"peak":0 | environment+driver |
| `parity-amp-tone` | PASS | 2 | P/P | Amp tone passed: {"treble":{"deep":-0.0003233641716056906,"low":-0.00013329178462864093,"mid":0.31916760035762 | none |
| `parity-ascii-import` | PASS | 2 | P/P | ASCII import: pasted drop-D tab opened as an untitled, editable score with tuning, rhythm and hammer-on; a rep | none |
| `parity-ascii-tab` | PASS | 2 | P/P | ascii tab: tab.txt 23 lines; Guitar9 and Bass6 frets match the fixture string by string. | none |
| `parity-author-defaults` | PASS | 3 | F/F/P | author defaults: saved defaults fill a new score as baseline metadata, survive GP export, and leave the opened | stale |
| `parity-clipboard` | PASS | 2 | P/P | {"crossDocumentClipboard":true,"settingsHistoryAfterPasteKeepsAudio":true,"literalMidi":[[0,60,95],[0,64,95],[ | none |
| `parity-command-palette` | PASS | 2 | P/P | command palette: fret, duration, measure and tempo commands ran as undoable edits; a bad measure was explained | none |
| `parity-delay-models` | PASS | 2 | P/P | Delay models passed: {"dryTone":-9.5793404531616,"digital":{"division":0.5,"firstRepeat":0.5,"tone":[-9.579352 | none |
| `parity-document-tabs` | PASS | 4 | F/F/P/P | "passed": true | stale+environment. Rerun on HEAD 048708e after the review edits (6f18f99), build 5a891a1d: PASS. |
| `parity-drive-effect` | PASS | 2 | P/P | Drive effect passed: {"dry":{"sustainDb":-18.179935036975124,"crest":5.081035496273725},"overdrive":{"sustainD | none |
| `parity-duplicate-track` | PASS | 3 | F/F/P | duplicate track: Guitar9@0, Bass6@2, Bass6@6, Drums@9, Keys@4; undo removed the copy. | stale |
| `parity-edition-palette` | PASS | 2 | P/P | edition palette: accent, string number, 8va, strum, tuplet list and text each ran as one native edit; undo rem | none |
| `parity-effect-order` | PASS | 2 | P/P | Effect order passed: {"before":[0.500002281870854,0.5000027297237697],"after":[0.9063033676071471,0.8777390264 | none |
| `parity-engraving` | PASS | 4 | F/F/P/P | {"sourceHash":"6961cbb1377842440b23580b34a85cec538b620bf62a7a9c119b92400cb603ed","presentationKeepsNativeGener | stale. Rerun on HEAD 048708e after the review edits (6f18f99), build 5a891a1d: PASS. |
| `parity-entry` | PASS | 3 | F/F/P | {"nativeAudio":{"outputPeak":0.1702335923910141,"renderedFrames":5280},"gpRoundtrip":{"album":"Parity session" | stale |
| `parity-expressions` | PASS | 2 | P/P | expressions: ff, [Verse], D.S. al Coda, bass, G major and Am ran as undoable edits; an overfilling 3/4 was exp | none |
| `parity-factory-sounds` | PASS | 2 | P/P | Factory sounds passed: {"jazz":{"levelDb":-24.83425796287058,"upperShareDb":-25.40783053206399},"metal":{"leve | none |
| `parity-file-association` | PASS | 2 | P/P | File association passed: {"openedAtLaunch":["blank","launch first.gp"],"afterSecondLaunch":["blank","launch fi | none |
| `parity-flac-export` | PASS | 2 | P/P | FLAC export passed: {"mix-44100-24":{"frames":264600,"flac":279259,"wav":1587644,"ratio":0.176},"mix-48000-16" | none |
| `parity-focus` | PASS | 2 | P/P | focus: Bass6 focused 50% then unfocused 100% while playing (peak 0.733, generation 6 kept), moved to Guitar9,  | none |
| `parity-font-roles` | PASS | 2 | P/P | font-roles: 23 passed, 0 failed. | none |
| `parity-gp5-export` | PASS | 2 | P/P | gp5 export: bass.gp5 1895 bytes; Bass6 and Drums match the fixture; the nine-string guitar was refused before  | none |
| `parity-graphic-eq` | PASS | 2 | P/P | Graphic EQ passed: {"flat":{"low":0,"mid":0,"high":0,"level":0},"boost":{"low":0.21905837273796688,"mid":9.459 | none |
| `parity-harmony` | PASS | 2 | P/P | {"generatedChord":true,"atomicNamedTranspose":true,"literalGpPitches":[66,62,57,54,50,42],"nativePlayback":tru | none |
| `parity-header-footer` | PASS | 2 | P/P | header-footer: 5 pages; first page ["Amber Windows — engraving study","Original desktop acceptance fixture","T | none |
| `parity-help` | PASS | 2 | P/P | help: F1 opened Getting started with nothing focused and the editing topic from the score; About disclosed ver | none |
| `parity-instrument-focus` | PASS | 2 | P/P | Instrument focus passed: {"beat":"E2","bar":"E2F2F#2G2","paused":{"tick":7948.799999999999,"next":[11]}} | none |
| `parity-instrument-handedness` | PASS | 2 | P/P | Instrument handedness passed: {"nut":[469.9039306640625,941.0543823242188],"keys":[40,41,42,43]} | none |
| `parity-line-in` | PASS | 2 | P/P | Line-In passed: {"heard":{"running":true,"error":null,"inputLevel":-9.118639,"outputLevel":-10.463707,"latency | none |
| `parity-master-effects` | PASS | 2 | P/P | master effects: level -6 dB scaled the export from -6.57 to -12.57 dB; limiter at -10 dB held it to -10.00 dB; | none |
| `parity-microphone` | PASS | 2 | P/P | Microphone passed: {"dry":{"correlation":0.9999999069359405},"close":{"lowest":5.8031105385655275,"lows":4.120 | none |
| `parity-midi-import` | PASS | 2 | P/P | MIDI import: malformed files refused without changes; a format 1 file opened as an untitled, editable score wi | none |
| `parity-midi-out` | PASS | 2 | P/P | MIDI output passed: {"countIn":{"gapMs":4999.974899999999,"firstChordAfterPressMs":4049.18359375,"late":0,"max | none |
| `parity-modulation-effects` | PASS | 2 | P/P | Modulation effects passed: {"tremolo":{"dry":0.010789585874743686,"wet":0.831863254288936},"vibrato":1.3681135 | none |
| `parity-move-track` | PASS | 3 | F/F/P | move track: Bass6, Guitar9, Drums, Keys; undo restored the order. | stale |
| `parity-mp3-export` | PASS | 2 | P/P | MP3 export passed: {"mix-44100":{"frames":264600,"snrDb":61.8,"mp3":193932,"wav":1587644,"ratio":0.122},"mix-4 | none |
| `parity-nam-capture` | PASS | 2 | P/P | NAM capture passed: {"peakLive":0.44669222831726074,"export":{"builtin":{"rms":0.04613715995521517,"peak":0.20 | none |
| `parity-normalize-export` | PASS | 2 | P/P | Normalized export passed: {"plain":{"rmsDb":-29.450600632162374,"peakDb":-6.574638394562966,"frames":288000}," | none |
| `parity-notation` | PASS | 3 | F/F/P | {"visibleGp":{"error":false,"raw":"[VERSE]\nHel-lo  world+today","visible":"true","inverted":"1","fermata":"1. | stale |
| `parity-ogg-export` | PASS | 2 | P/P | OGG export passed: {"mix-44100":{"frames":264600,"snrDb":28.6,"ogg":45028,"wav":1587644,"ratio":0.028},"mix-48 | none |
| `parity-pitch-effects` | PASS | 3 | F/F/P | Pitch effects passed: {"pitch":493.883301256124,"pitchT":659.25511382574,"dryAbove":0.3207037893405785,"upAbov | stale |
| `parity-practice` | PASS | 3 | F/P/P | {"endpointPitch":[{"percent":10,"backendNotifications":1,"device":"Speakers (Pebble V3)","deviceId":"wasapi:{0 | environment |
| `parity-range-measures` | PASS | 3 | F/F/P | {"mouseGestures":{"inspectorFocusToMusic":true,"shift":true,"reverseDrag":true,"resize":true,"tripleClick":tru | stale |
| `parity-reverb-models` | PASS | 2 | P/P | Reverb models passed: {"dry":{"tailDb":-65.08326734147897},"room":{"tailDb":-41.83397277073975,"brightDb":-14. | none |
| `parity-score-entry` | PASS | 2 | P/P | score entry: preview names lines and spaces; a click wrote G4 as one edit and one undo removed it; five letter | none |
| `parity-score-errors` | PASS | 2 | P/P | score errors: "Measure 2 · Guitar · Voice 1: 1 quarter note missing" listed, marked and selectable; marking of | none |
| `parity-second-pedalboard` | PASS | 2 | P/P | Second pedalboard passed: {"dry":-23.973966522899367,"single":-29.97397373294437,"doubled":-35.9739762948127," | none |
| `parity-selection-playback` | PASS | 3 | F/F/P | (JSON receipt, exit 0) | stale+environment |
| `parity-selection-ties` | PASS | 2 | P/P | selection ties: measure 2 ties T T T T TT TT across both voices in one edit; measure 1 refused; untie, undo/re | none |
| `parity-sound-library` | PASS | 2 | P/P | Sound library passed: {"copied":{"pedal":{"enabled":true,"rateHz":5,"depth":0.9,"shape":"square"},"whole":true | none |
| `parity-sound-preview` | PASS | 2 | P/P | sound preview: Lead previewed on Guitar9 while playing (peak 0.810, generation 6 kept), canceled back to the s | none |
| `parity-staff-groups` | PASS | 2 | P/P | staff-groups: 47 passed, 0 failed. | none |
| `parity-stroke-patterns` | PASS | 2 | P/P | stroke patterns: Guitar9 4 sounding beats alternate D/U and take brush D D U -; drums refused; undo/redo kept. | none |
| `parity-stylesheet` | PASS | 2 | P/P | {"authored":true,"originalGp8RuntimeAcceptance":false,"fixtures":{"true":{"path":"E:\\git\\TabPlayer\\.worktre | none |
| `parity-sustain-pedal` | PASS | 2 | P/P | sustain pedal: MIDI CC64 0/ch2=0, 0/ch5=0, 3840/ch2=127, 3840/ch5=127, 6720/ch2=0, 6720/ch5=0; undo cleared th | none |
| `parity-symbol-editing` | PASS | 2 | P/P | symbol editing: title, tempo, chord name and clef were edited in place and from a context menu as undoable edi | none |
| `parity-system-gaps` | PASS | 2 | P/P | system-gaps: 24 passed, 0 failed. | none |
| `parity-tempo-sync` | PASS | 2 | P/P | Tempo sync passed: {"synced":{"fast":{"hz":2,"troughs":8},"slow":{"hz":1,"troughs":8}},"free":{"fast":{"hz":2. | none |
| `parity-track-color` | PASS | 3 | F/F/P | track color: Bass6 rgb(200, 0, 0) -> rgb(255, 136, 0), GP export Guitar9=200/0/0, Bass6=255/136/0, Drums=200/0 | stale |
| `parity-tuner` | PASS | 2 | P/P | Tuner passed: {"toneHz":110.57333540456236,"nativeCents":9.000092097676637,"nativeStrings":[null,null,null,nul | none |
| `parity-view-defaults` | PASS | 3 | F/F/P | view defaults: current view captured and saved as vertical page; open score kept its view, New started in the  | stale |
| `parity-wah` | PASS | 2 | P/P | wah: exported Guitar9:0:0=2; undo cleared it. | none |
| `parity-wah-effect` | PASS | 2 | P/P | Wah effect passed: {"dry":0.10374320249627003,"heel":0.0694880333467484,"toe":0.21365930155893406,"auto":0.141 | none |
| `parity-wah-models` | PASS | 2 | P/P | Wah models passed: {"classic":{"brightness":0.21365930155893406,"treble":0.06897706145830519},"bass":{"brightn | none |
| `performance` | PASS | 3 | F/F/P | { openRenderMs: 593.4113000000002, editRenderMs: 518.7757999999999 } | stale+environment |
| `review-regressions` | PASS | 3 | F/F/P | Packaged regression checks passed: empty following measure; triple-dot render/timing/export/reimport; mixer un | stale |
| `roundtrip` | PASS | 3 | F/F/P | Packaged native I/O hooks: GP open → edit → failed save → native save → process restart → reopen → GP export,  | stale |
| `selection-playback-gestures` | PASS | 3 | F/F/P | (JSON receipt, exit 0) | stale |

### Build-packet drivers (`--run --build=<packet>`)

| Driver | Result | Runs | Run history | Final line | Classification |
|---|---|---|---|---|---|
| `parity-batch-convert` | PASS | 5 | P/P/P/P/P | "status": "passed", | none |
| `parity-cabinet-ir` | PASS | 5 | P/P/P/P/P | "status": "passed", | none |
| `parity-finalize` | PASS | 5 | P/P/P/P/P | "status": "passed", | none |
| `parity-input-preferences` | PASS | 6 | F/F/F/F/P/P | "status": "passed", | stale |
| `parity-instrument-entry` | PASS | 5 | P/P/P/P/P | "status": "passed", | none |
| `parity-library-browse` | PASS | 5 | P/P/P/P/P | "status": "passed", | none |
| `parity-notation-entry` | PASS | 6 | F/F/F/F/P/P | "status": "passed", | stale |
| `parity-note-audio` | PASS | 4 | P/P/P/P | "status": "passed", | none |
| `parity-note-audition` | PASS | 4 | F/P/P/P | "status": "passed", | stale |
| `parity-partial-capo` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-reload-recovery` | PASS | 3 | P/P/P | "status": "passed", | precautionary change |
| `parity-resume-playback` | FAIL | 3 | F/F/F | page.evaluate: Error: Public Tauri internals container cannot be temporarily replaced | stale (not fixed); possible product bug |
| `parity-saved-tunings` | PASS | 3 | F/P/P | "status": "passed", | stale |
| `parity-scale-diagrams` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-style-typography` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-stylesheets` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-track-interpretation` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-banjo-drone` | PASS | 3 | P/P/P | "status": "passed", | none |
| `parity-string-count` | PASS | 3 | P/P/P | "name": "All exact exports, paused readiness and acknowledged native edits passed", | none |

### State and group drivers

| Driver | Result | Runs | Run history | Final line | Classification |
|---|---|---|---|---|---|
| `parity-backing-waveform` | PASS | 4 | F/F/P/P | "status": "passed" | stale |
| `parity-file-library (--group=core, restart)` | PASS | 2 | P/P | "status": "passed" | none |
| `parity-file-library (--group=folders)` | NOT RUN | 0 | - | - | environment (interactive) |
| `parity-file-drop` | FAIL | 3 | F/F/F | Windows refused owned foreground request | environment |
| `parity-library-reveal` | PASS | 1 | P | "status": "passed" | none |
| `parity-recovery (--self-test; groups crash, clean, paths, corruption, ownership, visual)` | PASS | 9 | P x7, ownership F then P, ownership P | "passed": true | stale (ownership group). Ownership group rerun on HEAD 048708e after the review edits (6f18f99), build 5a891a1d: PASS. |
| `parity-workstation (default flags)` | FAIL | 6 | F/F/F/F/P/F | The error feedback overlaps no control in the expanded playback panel (viewport 960, overlapping: Seek measure) | stale (fixed), then UI bug |

Notes on these rows:

- `parity-backing-waveform`: the dock-versus-inspector geometry asserted the old layout. One run also hit a launch race ("Unexpected waveform executable" at the start of the mono phase) that did not recur in three later runs.
- `parity-file-library`: core and restart chain through the state each returns. The folders group was not run.
- `parity-file-drop`: see Environment issues.
- `parity-recovery`: the ownership group launched a second app on the same session directory and required a non-zero exit with the session-lock message. Since W13 the single-instance plugin hands that launch to the running window, which exits 0 first. The driver now asserts exactly that hand-off: exit code 0 and no lock message in the output. The lock message itself is covered at process level by `src-tauri/tests/recovery_process.rs` (line 18), not by this driver.
- `parity-workstation`: Welcome Library; the Track panel checkbox is gone (the draft-survival check now hides and shows the Inspector); the rail label check now reads the Inspector tab labels; the playback error check is strict (the error rectangle must overlap no control in `.transport-more-content`). It passed after the first fixes and fails on the strict check at 960 px, see UI bug. The `--captures` path was not run, because the driver stops at that check first.

### Not run

| Driver | Reason |
|---|---|
| `parity-backing-processing` | Needs `--prepare --admission=<reviewed build admission.json>` (score layouts also a source-review report). The admission carries `rootReviewed: true`, an attestation that the controller reviewed the frozen source. This sweep did not write one. |
| `parity-backing-tempo` | Needs `--prepare --admission=<reviewed build admission.json>` (score layouts also a source-review report). The admission carries `rootReviewed: true`, an attestation that the controller reviewed the frozen source. This sweep did not write one. |
| `parity-score-layouts` | Needs `--prepare --admission=<reviewed build admission.json>` (score layouts also a source-review report). The admission carries `rootReviewed: true`, an attestation that the controller reviewed the frozen source. This sweep did not write one. |

### Driver self-tests (`node --test`)

| File | Result |
|---|---|
| `score-layout-acceptance.test.mjs` | PASS, 16 of 16 |
| `score-layout-driver.test.mjs` | PASS, 14 of 14 |
| `string-count-driver.test.mjs` | PASS, 4 of 4 |
| `backing-processing-observer-check.mjs` | PASS, 8 of 8 |

Helper modules, not run on their own: `harness`, `document-context`, `workstation-commands`, `workstation-fixture`, `stylesheet-fixture`, `score-layout-observer`, `string-count-build` (builds the packet), `parity-recovery-production`, and the fixture builders `backing-processing-fixture`, `backing-tempo-fixture`, `backing-waveform-fixture`, `document-tabs-fixture`, `engraving-fixture`, `instrument-fixture`, `library-fixture`, `practice-fixture`, `recovery-fixture`, `score-layout-fixture`, `selection-playback-fixture`.

## Stale-driver fixes

All edits are under `tests/desktop`. The redesigned workspace (menu bar, Song/Track/Selection inspector tabs, no left pane, welcome Library on a fresh launch) caused almost every failure. The classification column above carries the per-driver cause.

Shared helpers added to `workstation-commands.mjs`:

- `revealInspectorControl(page, locator)` opens the first inspector tab in which a control is visible. `clickWorkstationButton` now uses it for any button it cannot see, so older drivers find Selection-tab and Track-tab buttons without naming a tab.
- `hidePractice(page)` closes the practice popover, which sits over the inspector tabs until it is closed.

Recurring causes:

1. **Welcome Library.** A fresh launch opens it modally, so nothing behind it takes a click. Fixed in `advanced-editor`, `cancellation`, `critique-fixes`, `editor`, `parity-workstation`, `performance`, `review-regressions`, `roundtrip` and `selection-playback-gestures`.
2. **Controls on inspector tabs.** Fret, Set note, Duration, track settings, Default view and the author fields are visible only on their own tab. Fixed with `revealInspectorTab` or `revealInspectorControl`.
3. **Duplicate accessible names.** The palette repeats many commands as icon buttons (Show timer, Move to lower string, Key signature, Metronome). Locators were narrowed in `parity-notation`, `parity-range-measures`, `parity-notation-entry` and `native-audio`.
4. **Removed or renamed DOM.** `.workstation-left` (`parity-engraving`, `parity-document-tabs`), the "Score information" disclosure (`parity-author-defaults`), the Track panel checkbox (`parity-workstation`), `.track-channel` indexing now that the Master and Focus strips come first (`native-audio`), tab panel counting now that the inspector panels are tabpanels (`parity-document-tabs`), Play and Pause as icon buttons (`critique-fixes`).
5. **Behaviour that changed on purpose.** A note plus its spelling, or plus a remembered duration, is now one `sequence` edit (`parity-notation-entry`, `parity-input-preferences`). The input preferences gained `advance` (default on) and `swapPlusMinus` (`parity-input-preferences`). `setStringCount` carries `crossVoice: true` (`parity-saved-tunings`). A second launch of the same identifier is handed to the running window (`parity-recovery`). Play from the cursor stays disabled until a performed occurrence is chosen on a repeated score (`critique-fixes`).
6. **Geometry assertions.** `parity-backing-waveform` now checks that the dock does not overlap the visible inspector pane (`.workstation-inspector`) instead of ending before it. `parity-workstation` checks that the playback error feedback overlaps no control in the expanded panel, and that it is the topmost element at its own centre. `parity-engraving` and `parity-document-tabs` check the Inspector pane and its Track tab at 960, 1280 and 1600 px.
7. **Interpreter.** `parity-aiff-export` picks the first Python that still has `aifc`.

### Weakened or dropped assertions

Every assertion that the edits weakened or dropped, and what covers it now:

| Driver | Before | Now | Covered by |
|---|---|---|---|
| `parity-engraving` | `.workstation-left` exists once; `.inspector` exists once | `.workstation-inspector` is visible, the Inspector tab strip shows its Track tab, and the page has no horizontal overflow at 960, 1280 and 1600 px | Left pane no longer exists; nothing else |
| `parity-document-tabs` | left pane (or rail below 1180 px) exists, has width, and lies left of the score; inspector measured on `.inspector` | `.workstation-inspector` measured; score lies left of it; the Inspector Track tab is visible at each width | Left pane no longer exists; nothing else |
| `parity-backing-waveform` | waveform ends before the inspector's left edge | waveform ends before the inspector or lies below it; measured on the visible `.workstation-inspector` pane | Weaker: a dock under the inspector now passes. Nothing else |
| `parity-workstation` | rail label checks on `.workstation-rail` | the same one-line and fit checks on the Inspector tab labels | Rail no longer exists |
| `parity-workstation` | tuning draft survives hiding the Track panel | tuning draft survives hiding and showing the Inspector | The Track panel checkbox no longer exists |
| `parity-recovery` (ownership) | second launch exits non-zero with the session-lock message | second launch exits 0 and prints no lock message | Lock message: `src-tauri/tests/recovery_process.rs:18`. The driver no longer reaches the lock through a same-identifier launch |
| `parity-input-preferences` | advance is not a preference; keypad and auto-duration walks assume the cursor stays on the beat it wrote | the driver turns Advance off before those walks and expects `advance:false` | The Advance-on path is not driven by any desktop driver; `src/editor/input-preferences.test.tsx` covers the preference defaults |
| `advanced-editor` | selects a stringed track in the removed left list before editing | assumes the open score's first track is stringed and still throws if Apply tuning is disabled | The throw on a non-stringed first track |
| `native-audio` | one Metronome checkbox | clicks the first of two (transport and Practice tools) | Only the transport one is exercised |
| `critique-fixes` | Play and Pause found by accessible name (role button, name Pause or Play); transport fieldset not disabled | native `playing` state plus the `.transport` button named Pause, then Play; Play enabled before the Space test | Nothing weaker; the old fieldset wait has no equivalent |

`parity-reload-recovery` got a precautionary Selection-tab reveal. It was not seen failing, so the change is not a weakening.

The product still lists the dead `.workstation-left` selector in `src/help/help-topics.ts:158`; it was not touched.

## Environment issues and limits

- **`parity-file-drop`:** three consistent failures, "Windows refused owned foreground request". The OS-level drop needs the test window in the foreground, and Windows refused it while this session held the foreground. It needs an interactive desktop with nothing else holding focus.
- **`parity-file-library --group=folders`:** needs a person to answer the real folder picker. Not run.
- **Admission-gated drivers** (`parity-backing-processing`, `parity-backing-tempo`, `parity-score-layouts`): not run, see above. Their self-tests pass.
- **`parity-recovery --group=performance`** and **`parity-workstation --captures`, `--long`, `--backing`:** need explicit flags and were not run. The screenshots these drivers take still need a person to look at them.
- **`capture_loopback`:** several drivers (`parity-practice`, `parity-selection-playback`, `parity-document-tabs`, `native-audio`) need the debug example built first, or they fail at once. `build-desktop-test.ps1` does not build it.
- Audio runs used this machine's default WASAPI output. Loopback captures show real signal but say nothing about other devices or operating systems. Only Windows was exercised.
- `advanced-editor` and `roundtrip` pass only with a suitable `TABPLAYER_TEST_GP`, so they cannot run unattended from a bare checkout.
- The packet and state drivers were not part of the first full pass. They were run as they were unblocked, with the histories shown.

## Product bugs

One UI bug is confirmed, below. One more is suspected and unconfirmed. Every other failure that was investigated traced to a driver, a missing prerequisite or the environment.

### UI bug: the playback error line overlaps a control at 960 px

Found by the strict check in `parity-workstation` (`tests/desktop/parity-workstation.mjs`, More playback step).

- **Steps.** Open the Harbour fixture at 960 px wide, set a loop whose end precedes its start so that Loop end must follow its start, and expand More playback.
- **Expected.** The error line (`.transport-feedback[role=alert]`) overlaps no control in the expanded panel (`.transport-more-content`).
- **Actual.** The error line spans y 82 to 98 and the panel starts at y 79, so the error overlaps the "Seek measure" label and its row. Driver output: `{"viewport":960,"feedbackTop":82,"feedbackBottom":98.2,"panelTop":79,"panelBottom":417.7,"overlapping":["Seek measure"],"feedbackOnTop":true}`. The text is on top and readable, but it collides with the label.
- **Status.** The driver check stays strict and the driver fails until the layout is fixed. The older version of the check assumed the panel opened upward, so it compared the wrong edge.

### Unconfirmed: closing the window with unsaved changes shows no dialog

**Update (THE-183, THE-184):** resolved as a test artefact, with no product bug. The dialog is an IPC request, so request interception that holds it produces exactly this symptom, and every real or synthetic close without a held request shows it. `parity-resume-playback` is repaired and passes. See `2026-11-08-the-184-resume-playback.md`.

Found while trying to repair `parity-resume-playback`.

- **Driver state.** The unchanged driver fails at its first fault-injection step, "Public Tauri internals container cannot be temporarily replaced" (3 runs). Tauri 2.12 (b4c7cdf, 2026-11-07) made `window.__TAURI_INTERNALS__` and its `invoke` non-writable and non-configurable, so the driver's seam no longer works. That part is a stale driver. A rewrite was tried with request interception and is not kept, because it did not reach a pass.
- **Probe.** With the injection replaced by request interception, the driver went on to `WM_CLOSE` and waited for the Unsaved score dialog. None appeared within 10 s. A separate probe launched the standalone binary, entered one note, posted `WM_CLOSE` to the `Tauri Window` and waited up to 10 s. The process stayed alive, `.app-shell` had `aria-busy="true"`, no window named Unsaved score existed for any process (UI Automation over all top-level windows), and no alert or in-page dialog was shown. With a clean document the same `WM_CLOSE` closed the window and exited the process. The window was hidden in one variant and visible in another, with the same outcome.
- **Also changed.** `Process.CloseMainWindow()`, which the driver uses, now reaches the single-instance helper window (W13) instead of the Tauri window, so it does nothing on its own. The probe posted `WM_CLOSE` to the Tauri window directly.
- **Not established.** Whether a person clicking the close button sees the dialog. The probe used a synthetic message, and this session cannot tell whether the native message box exists but is invisible to UI Automation. Someone should try it by hand before an issue is filed.
- **Expected:** closing with unsaved changes shows "Save changes to ... before closing?" with Save, Discard and Cancel. **Actual in the probe:** the app goes busy and nothing is shown.

### Minor observations, not filed

- The practice popover stays open over the inspector tabs until its own button is clicked again, so the tabs cannot be clicked while it is open. Probably intended.

## Reproducing

```powershell
# from the worktree root, after the setup above
$env:TABPLAYER_TEST_GP = "<abs path>/.analysis/compatibility/guitarpro7-bends.gp"
node tests/desktop/<name>.mjs                      # standalone drivers
$env:STRING_COUNT_TARGET = "<abs path>/src-tauri/target"; node tests/desktop/string-count-build.mjs   # prints the packet path
node tests/desktop/<name>.mjs --run --build=<packet path>   # packet drivers; rebuild the packet after any edit under tests/desktop
```
