# TabPlayer milestone validation — 2026-10-14

The first Rust/Tauri player/editor is implemented on Windows. This report separates observed behavior from pending release verification.

## Verified

- The final verification suite has 53 frontend tests and 12 Rust tests. TypeScript checking, Rust formatting and Git whitespace checks pass.
- Rust history, redo branching, schema/engine rejection, original-byte hashes and atomic file replacement are tested. A real Windows sharing lock preserves the prior saved file on commit failure. Source paths and identical source copies are protected.
- Public, pinned GP3/4/5/GPX/GP7 fixtures match expected frets, tuning, rests and durations. GP8 intra-measure tempo changes are checked; an imported bend survives a fret edit.
- Seventeen authorized private GP scores pass independent ZIP/GPIF track-count, meter and tuning comparisons, edit/replay, native-format serialization, GP export/reimport and unchanged original SHA-256 checks. This is selected-field compatibility evidence, not proof of complete format fidelity.
- The supplied six-track, 103-measure score completes open, edit, failed save, native save, actual process restart, reopen and GP export through a packaged test build using gated native I/O hooks. Reopened commands and embedded source bytes match exactly. The failed save leaves native dirty=true. Windows Open/Save dialog cancellation was checked separately; automated file-picker write selection was not reliable.
- Actual Windows rendering and note hit testing were checked with a two-track composition. Interaction tests cover empty-string entry, chords, rests/rhythm, overflow errors, keyboard navigation, structural selection repair and undo/redo.
- A standalone release app loads bundled assets and sends nonzero PCM to a running Web Audio worklet with external requests blocked. Measured sample peak was 0.1693759. Pause, last-measure seeking, 50% speed, multiple loop cycles, stop on edit and regenerated-note playback passed. The user separately confirmed audible playback.
- The final 100-measure/four-track engine check loaded in 115 ms, with median edits of 52 ms and maximum edits of 80 ms. Native synchronous rendering opened it in 343 ms and redrew an edit in 95 ms. These are observed Windows-host timings, not cross-machine guarantees.
- A Windows x64 NSIS installer is built. Extracted Guitar Pro resources and private scores are outside `dist`; package assets come from alphaTab, generated original icons and licence files.

## Limits

macOS/Linux builds, packaged audio and installer lifecycle tests have not run on corresponding hosts. The Windows installer is unsigned and was built without installing it into the operating system. Native file-picker write routing needs a manual smoke check; the automated write/restart test uses explicit test hooks sharing production file functions.

Guitar Pro runtime acceptance of exports is not checked. No installed Guitar Pro entry was found in the Windows uninstall registry; the supplied installer was examined statically and was not installed. AlphaTab model reimport is a separate check.

GP export can lose unsupported data. Native projects preserve original bytes and commands, including data the editor cannot expose. The milestone does not create advanced techniques, detailed voice layouts, backing audio or RSE-equivalent sound. Track rename/instrument changes after creation need a later command.

## Review and reproducibility

The source includes exact development/test/build instructions in `README.md`, pinned fixture manifests, private-corpus staging and desktop smoke harnesses. Test hooks require an explicit Cargo feature, explicit frontend build flag and runtime environment flag; normal builds exclude the native handler.

The independent whole-change review of `f076708..eec3c6a` found no Critical and six Important issues. A single fix pass addresses all six: note-entry overflow, empty following voices, dangling note relationships and tied pitch edits, persistent mixer channels, track identity across undo/redo, and triple-dot timing. Each has a regression watched fail before passing. Actual alphaTab synthesizer state is checked, including the browser API's current-index resolution of track arguments.

Triple-dotted quarters now produce 1,800 ticks, including the next MIDI note's onset. Native replay, tuplets, integer tick quantization, overflow rejection and GP export/reimport are checked. Vendor files remain unchanged; the adapter supplies the public duration override.

The packaged regression harness checks rapid beat deletion, empty-measure insertion, rendered triple-dot timing, GP export/reimport, mixer control state through undo/redo, and nonzero PCM after deleting a soloed track and starting a new document. External requests are blocked. It exposed an additional worker-rendering bounds race, also reproduced before its fix; synchronous notation rendering removes that race while synthesis retains its worker.

One Minor is deferred: fractional Measure/Beat input can raise an uncaught selection-handler error while preserving the document. Use whole-number selections.

See [execution rulings](2026-10-14-tabplayer-rulings.md) for decisions, their costs and the reviewer's set-aside cases. No second review was dispatched; the fix pass is verified by regression tests, the full suite and native checks.
