# TabPlayer milestone validation — 2026-10-14

The first Rust/Tauri player/editor is implemented on Windows. This report separates observed behavior from pending release verification.

## Verified

- Rust history, redo branching, schema/engine rejection, original-byte hashes and atomic file replacement are tested. A real Windows sharing lock preserves the prior saved file on commit failure. Source paths and identical source copies are protected.
- Public, pinned GP3/4/5/GPX/GP7 fixtures match expected frets, tuning, rests and durations. GP8 intra-measure tempo changes are checked; an imported bend survives a fret edit.
- Seventeen authorized private GP scores pass independent ZIP/GPIF track-count, meter and tuning comparisons, edit/replay, native-format serialization, GP export/reimport and unchanged original SHA-256 checks. This is selected-field compatibility evidence, not proof of complete format fidelity.
- The supplied six-track, 103-measure score completes open, edit, failed save, native save, actual process restart, reopen and GP export through a packaged test build using gated native I/O hooks. Reopened commands and embedded source bytes match exactly. The failed save leaves native dirty=true. Windows Open/Save dialog cancellation was checked separately; automated file-picker write selection was not reliable.
- Actual Windows rendering and note hit testing were checked with a two-track composition. Interaction tests cover empty-string entry, chords, rests/rhythm, overflow errors, keyboard navigation, structural selection repair and undo/redo.
- A standalone release app loads bundled assets and sends nonzero PCM to a running Web Audio worklet with external requests blocked. Measured sample peak was 0.1693759. Pause, last-measure seeking, 50% speed, multiple loop cycles, stop on edit and regenerated-note playback passed. The user separately confirmed audible playback.
- A 100-measure/four-track fixture loads in approximately 62–86 ms, with typical edits around 42–51 ms and observed maxima around 63 ms on this Windows host. These are engine timings; native rendering is also checked, but no cross-machine performance guarantee is made.
- A Windows x64 NSIS installer is built. Extracted Guitar Pro resources and private scores are outside `dist`; package assets come from alphaTab, generated original icons and licence files.

## Limits

macOS/Linux builds, packaged audio and installer lifecycle tests have not run on corresponding hosts. The Windows installer is unsigned and was built without installing it into the operating system. Native file-picker write routing needs a manual smoke check; the automated write/restart test uses explicit test hooks sharing production file functions.

Guitar Pro runtime acceptance of exports is not checked. No installed Guitar Pro entry was found in the Windows uninstall registry; the supplied installer was examined statically and was not installed. AlphaTab model reimport is a separate check.

GP export can lose unsupported data. Native projects preserve original bytes and commands, including data the editor cannot expose. The milestone does not create advanced techniques, detailed voice layouts, backing audio or RSE-equivalent sound. Track rename/instrument changes after creation need a later command.

## Review and reproducibility

The source includes exact development/test/build instructions in `README.md`, pinned fixture manifests, private-corpus staging and desktop smoke harnesses. Test hooks require an explicit Cargo feature, explicit frontend build flag and runtime environment flag; normal builds exclude the native handler.

Independent whole-change review and final verification are recorded in the implementation ledger during execution. Their final outcome will be added here before delivery.
