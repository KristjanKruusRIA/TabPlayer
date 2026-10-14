# TabPlayer player and editor design

Date: 2026-10-14. Status: written design awaiting user review.

TabPlayer will be a desktop alternative to Guitar Pro for Windows, macOS, and Linux. The user approved a Rust and Tauri application retaining alphaTab for notation and playback, with a usable player and tab editor as the first milestone and broader Guitar Pro features added in later milestones. The first milestone must open real scores, support basic composition and editing, play the edited result, and save work reliably.

## First milestone

The application will import GP3, GP4, GP5, GP6 `.gpx`, and GP7/GP8 `.gp` files through alphaTab. It will display tablature with standard notation, allow track selection and zoom, and play the score with a moving cursor. Files remain local and playback works offline with bundled fonts, workers, and a SoundFont whose distribution license is recorded.

Users will be able to create a score; enter and change frets on guitar or bass strings; build chords by entering notes on multiple strings; insert or delete beats; enter rests; change note durations and dotted rhythms; append or remove measures; add or remove stringed instrument tracks; and change titles, tempo, and tuning. Undo and redo cover score edits. Imported percussion and advanced techniques can be displayed and played to the extent the engine supports them; the first milestone's edit controls focus on stringed instruments and the operations listed here.

The player will provide play, pause, stop, seeking by measure, tempo percentage, looping between selected measures, a metronome, and per-track volume, mute, and solo. Transport controls operate on the current edited score. Editing while playing stops playback before regenerating its MIDI state, preventing playback of an obsolete version.

Native project saving and reopening are required. Guitar Pro `.gp` export is an explicit interchange action, with an explanation that unsupported source properties may change or be omitted. Later milestones cover detailed techniques, additional notation and rhythm controls, printing/PDF and MIDI/audio export, backing audio, and richer sound. Those later features do not expand this milestone's acceptance criteria.

## Architecture

Use Rust with Tauri 2 for the native application and TypeScript with a small React interface for the webview. Keep application responsibilities in four ordinary modules: the Rust project/file/history core, the TypeScript score engine adapter, the editing interface, and Tauri's command boundary. This division supports testing without building a general plugin or service framework.

Rust owns the project envelope, applied command history, undo/redo cursor, dirty state, file dialogs, and disk writes. A narrow typed Tauri command interface exposes opening, committing edits, saving, and exporting documents. The webview loads bundled application assets and the music engine. It has no arbitrary shell/file access. Limit Tauri capabilities to the app's actual dialogs and commands. No account, cloud backend, or network access is needed for the score workflow.

Pin alphaTab 1.8.4 initially. It supplies parsers, the live score model, notation rendering, MIDI generation, and SoundFont synthesis. The adapter is responsible for loading scores, applying the finite editing operations to the music model, validating musical constraints, and refreshing render and MIDI state. Rust owns command history and persistence; the interface owns selection. alphaTab is not treated as a ready-made editor.

The runtime score uses alphaTab's `Score → Track → Staff → Bar → Voice → Beat → Note` structure. Commands target an explicit track, staff, measure, voice, beat, and string as appropriate. Validate a proposed edit against a candidate score before committing it to Rust history. A rejected edit or failed native commit keeps the displayed score and history unchanged. After a successful change, repair derived relationships and timing using the supported engine APIs, redraw the score, and regenerate playback state. Serialize document-changing actions so an edit cannot race an open/undo operation. Tests must check the resulting music rather than only checking that a method was called.

Tauri uses WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux. Bundled score workers, fonts, SoundFont loading, and audio initialization must be verified in those webviews. Browser-only success does not establish packaged desktop success. Development uses Cargo and Node/npm tooling; shipping the app does not require Node.js.

## Native project format and data preservation

The `.tabplayer` format is an app-owned JSON envelope with a format identifier, schema version 1, the exact engine version, an immutable base document, and the ordered list of applied edit commands. Imported base documents retain the original file bytes and original filename. A new score has a small, explicit blank-score base description. Reopening constructs the base score and replays the commands using the pinned engine.

This avoids adopting alphaTab's unstable model JSON as a permanent file format and retains source properties that its importer cannot represent. It does not make those properties editable or guarantee that Guitar Pro export preserves them. Replaying a project with an incompatible engine version must produce an actionable error instead of silently changing the score. A future engine upgrade requires an explicit compatibility check or migration.

Undo and redo move through command history. A new edit after undo discards the redo branch. Saving stores only applied commands; reopening reproduces the saved musical result. Keep the original imported file untouched; native save and Guitar Pro export use separate destinations. Use a temporary file in the destination directory and a replacement operation so failed writes do not corrupt an existing project. Mark the document clean only after the write succeeds.

## Editing behavior

Clicking a rendered note selects its beat and string; an accompanying beat inspector also allows selecting empty strings and rests. Keyboard navigation moves through beats and strings, and fret entry updates the selected string. Controls expose durations, dots, rest entry, track selection, and measure operations without relying on undocumented engine internals.

Reject invalid frets, nonexistent targets, and edits that would overfill a measure with a clear explanation. Underfilled measures remain visible with their remaining duration; the user can complete them with notes or rests. Measure insertion/removal must keep all tracks aligned with the master measures. Selection is updated after structural edits so it always points to a valid location. First milestone editing uses the active voice; additional voice management belongs to a later milestone.

Opening another document or closing a window with unsaved edits offers save, discard, or cancel. Import errors keep the current document and explain the failing format or file. A failed edit creates no history entry. A malformed native project must not be partially replayed into the user's current document.

## Guitar Pro compatibility

The supplied Guitar Pro 8.1.5.31 installer contains a native Qt application and separate file I/O, score, drawing, and audio libraries. Static analysis of its I/O library identifies distinct legacy, GP6, GP7, and GPIF readers. That supports testing each format generation independently; it does not establish complete behavior equivalence. See the [investigation report](../../research/2026-10-14-guitar-pro-investigation.md).

alphaTab documents those import generations and a `.gp` exporter. Its exporter rebuilds the container and GPIF content. Its own round-trip tests compare alphaTab models, and the GP8 test excludes bend comparisons. TabPlayer therefore promises the explicitly tested note, rhythm, tuning, and track behavior, with advanced-feature coverage recorded per fixture. Full Guitar Pro acceptance requires opening exported files in Guitar Pro itself.

Use the current backing-audio guide when planning that later milestone: the engine can read embedded audio, but its built-in player selects backing audio or synthesis rather than mixing both. Original RSE sound and effects fidelity remains a separate future investigation.

## Acceptance and verification

1. A new guitar score can be populated with notes, a chord, a rest, dotted rhythms, and a second instrument track; the notation and audible MIDI pitches reflect those edits.
2. Representative GP3/4/5, GPX, and GP7/8 fixtures load. Tests compare track counts, tuning, measure structure, note pitches, and durations against known expectations. Corrupt inputs produce an error while preserving the current document.
3. Edit sequences involving beat and measure deletion, duration changes, tuning, and track operations maintain score links, valid selection, and aligned measures. Invalid/overflowing edits leave both score and history unchanged.
4. Undo/redo restores exact musical state. Saving, restarting, and reopening a native project reproduces that state and retains the imported source bytes. Reopening invalid commands or an incompatible engine is rejected safely.
5. Tempo, looping, seeking, mute, solo, and volume work against the edited score. A loop repeats its selected inclusive measure range without an extra measure. Bundled audio/font/worker assets work with networking disabled.
6. `.gp` export followed by reimport preserves the supported milestone fields. Imported originals remain byte-identical. Real Guitar Pro export acceptance and advanced-feature fidelity are reported separately when verified.
7. A packaged desktop smoke test covers open → edit → play → save → restart → reopen. Test it on each target operating system before claiming release support there. This Windows host can perform Windows checks; macOS and Linux execution need corresponding hosts or CI runners.
8. A 100-measure, four-track fixture remains usable during selection, scrolling, and edits. Record observed loading/edit/render times and address any stalls that obstruct the workflow.

## Dependency and source boundaries

Use public engine APIs and retain dependency notices, including alphaTab's MPL-2.0 license and the bundled SoundFont's separate license. Fonts and audio assets must have explicit redistribution terms. The application contains independently written Rust core, UI, and editor code; extracted Guitar Pro executables, resources, and proprietary soundbanks are investigation inputs and stay outside the product and its versioned source.

No application code has been written for this design yet. The next step after written-spec approval is a concrete implementation plan with its own review and execution selection.

## References

- [alphaTab formats](https://alphatab.net/docs/category/formats)
- [Score model and model consistency](https://alphatab.net/docs/reference/score)
- [Score serialization warning](https://alphatab.net/docs/guides/lowlevel-apis#serialize-data-model-fromto-json)
- [Export API](https://alphatab.net/docs/guides/exporter)
- [Playback MIDI refresh](https://alphatab.net/docs/reference/api/loadmidiforscore)
- [GP8 feature matrix](https://alphatab.net/docs/formats/guitar-pro-8/)
- [Current backing-audio behavior](https://alphatab.net/docs/guides/audio-video-sync)
- [Pinned alphaTab exporter and tests](https://github.com/CoderLine/alphaTab/tree/022a45c8e42370f9e12e68949d11eada370da83d/packages/alphatab)
- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [Tauri process model and platform webviews](https://v2.tauri.app/concept/process-model/)
- [Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/)
