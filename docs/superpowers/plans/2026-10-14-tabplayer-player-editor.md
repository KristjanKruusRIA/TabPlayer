# TabPlayer Player and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working Rust/Tauri TabPlayer desktop app with Guitar Pro import, basic tab editing, offline playback, undo/redo, native saving, and `.gp` export.

**Architecture:** Rust owns the native project, command history, dirty state, and files. A TypeScript adapter derives alphaTab scores from the immutable base plus applied commands; React supplies selection and editing/transport controls. All document actions run sequentially, and candidate music is validated before native state changes.

**Tech Stack:** Rust, Tauri 2, serde, serde_json, base64, sha2, an established atomic-file-write crate; TypeScript, React, Vite, alphaTab 1.8.4, Vitest; Tauri dialog integration and native desktop smoke tooling.

**Spec:** [Approved Rust/Tauri design](../specs/2026-10-14-tabplayer-design.md)

## Global Constraints

- Desktop targets: Windows, macOS, and Linux.
- Pin alphaTab 1.8.4 initially.
- Native format: `.tabplayer`, schema version 1, exact engine version, immutable base document, ordered applied edit commands.
- Rust owns project/history/files; alphaTab supplies parsers, notation, MIDI, and SoundFont synthesis.
- Editing while playing stops playback before MIDI regeneration.
- Rejected edits, failed saves, and failed imports preserve the current document.
- Originals remain unchanged; raw alphaTab JSON is not the durable format.
- Offline operation bundles fonts, worker assets, and an explicitly licensed SoundFont.
- Extracted Guitar Pro assets and binaries remain outside the product and versioned source.
- Verify packaged behavior on each target OS before claiming release support there.

## Review Focus

- A saved native project with an unknown command or incompatible engine must be rejected before replacing the current score. Test in Tasks 1 and 2.
- Undo followed by a new edit must discard redo history, including when the undone state was saved. Test in Task 1.
- A structural edit across multiple tracks must keep measures aligned and selection valid. Test in Tasks 2 and 4.
- An unavailable output directory or interrupted replacement must preserve the prior saved file and dirty state. Test in Tasks 1 and 3.
- A packaged app with networking disabled must still load notation fonts and synthesize audible notes. Test in Tasks 5 and 6.

## File and interface map

`src-tauri/src/project.rs` defines the durable data contract and history; `files.rs` implements reads and replacement writes; `lib.rs` wires narrow Tauri commands; `main.rs` starts the app. `src/project.ts` mirrors the durable contract; `engine.ts` builds/validates the alphaTab model; `bridge.ts` wraps native calls; `controller.ts` sequences document operations; `App.tsx` joins the score, inspector, tracks, and transport. Keep code in these files until a distinct responsibility justifies another file.

The durable `Project` fields are `format: "TabPlayer"`, `schemaVersion: 1`, `engineVersion: "1.8.4"`, `base: BaseDocument`, and `edits: EditCommand[]`. `BaseDocument` is tagged by `kind`: `blank` contains title, artist, initial tempo, tuning, and measure count; `file` contains filename, Base64 bytes, and SHA-256. A new score starts with one standard six-string guitar, tuning `[64,59,55,50,45,40]`, four 4/4 measures, four quarter rests per measure, and initial tempo 120.

`BeatTarget` fields are `track`, `staff`, `bar`, `voice`, `beat`, all zero-based. Guitar string numbers are one-based using alphaTab's convention. The finite command tags are `setNote`, `removeNote`, `setRest`, `setDuration`, `insertBeat`, `deleteBeat`, `appendMeasure`, `removeMeasure`, `addTrack`, `removeTrack`, `setTuning`, and `setScoreInfo`. Note commands contain target/string/fret as relevant; duration commands contain duration/dots; measure/track removals contain the selected index; track creation contains name/tuning/MIDI program; score information contains title/artist/initial tempo. Define explicit enums/unions, not arbitrary JSON patches.

`ProjectSnapshot` contains `project`, `canUndo`, `canRedo`, `dirty`, and nullable `path`. Rust session history may retain the redo tail, but snapshot projects and disk saves contain only applied commands. Selection is a separate UI value. All native reads return staged candidates; only `replaceProject(candidate, path)` replaces the active native session after engine validation.

## Task 1: Rust project history and durable saving

**Files:** Create `src-tauri/Cargo.toml`, `src-tauri/src/project.rs`, `src-tauri/src/files.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/tests/project_history.rs`, `src-tauri/tests/project_files.rs`, `tests/protocol.json`; update `.gitignore` for Cargo/build outputs.

**Interfaces:** Produce `Project`, `BaseDocument`, `EditCommand`, `ProjectSnapshot`, `ProjectSession`, and `ProjectError` with explicit display messages. Methods: `ProjectSession::new(project, path)`, `snapshot()`, `apply_edit(command)`, `undo()`, `redo()`, `mark_saved(path)`. File functions: `read_project(path: &Path) -> Result<Project, ProjectError>` and `write_project(path: &Path, project: &Project) -> Result<(), ProjectError>`.

- [ ] Check for an existing Rust installation beyond PATH; if absent, install the official stable Rust toolchain with the minimal profile. Existing Visual Studio 2022 C++ Build Tools and WebView2 were detected. Verify `rustc --version` and `cargo --version`; use the installed tool paths in this shell.
- [ ] Scaffold the Cargo package and write failing tests for blank-project JSON, schema/engine rejection, unknown command rejection, source-byte integrity, history, dirty state, and persistence. Example assertions:

```rust
assert_eq!(snapshot.project.schema_version, 1);
assert_eq!(snapshot.project.engine_version, "1.8.4");
assert_eq!(restored.project, saved.project);
assert!(!session.snapshot().can_redo); // undo, then a new edit
assert_eq!(std::fs::read(path).unwrap(), old_bytes); // failed replacement
```

- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --tests` and confirm failure on missing behavior, then implement the contract and history. Preserve saved-state identity across undo/redo; save marks clean only after successful replacement. Verify Base64 and its digest rather than trusting stored metadata.
- [ ] Implement `write_project` using a maintained atomic-file-write library after inspecting its Windows replacement contract; verify a failure before commit leaves the old file intact. Use temporary directories in tests rather than user documents.
- [ ] Rerun native tests, check formatting with `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, and commit the independently testable Rust core.

## Task 2: Score import, replay, and editing validation

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `src/project.ts`, `src/engine.ts`, `src/engine.test.ts`, `src/compatibility.test.ts`; add documented validation fixtures or a retrieval manifest with hashes under `tests/fixtures/`. Do not commit proprietary extracted files.

**Interfaces:** Consume Task 1's durable contract. Produce `buildScore(project: Project): Score`, `previewEdit(project: Project, edit: EditCommand): {project: Project; score: Score}`, `exportGp(score: Score): Uint8Array`, `describeSelection(score: Score, target: BeatTarget)`, and `validateProject(project: unknown): Project`. Import `Score` from alphaTab; constrain application state to the explicit project contract.

- [ ] Install pinned alphaTab 1.8.4 and the frontend development dependencies, keeping lockfiles. Use the engine's official Vite integration and public APIs; inspect current package declarations and upstream examples before choosing initialization calls.
- [ ] Write failing tests using the defined four-measure blank base. Verify an entered fret 7 on the high E string produces MIDI pitch 71; a second string creates a chord; rest entry removes sounding notes; supported duration/dot changes have the expected tick length. Reject fret -1 and a pitch beyond MIDI 127 without changing the original project.
- [ ] Add failing tests for overflowing durations, empty voices after deletion, invalid targets, preserving imported technique fields during fret edits, measure alignment after additions/removals on two tracks, tuning changes, and rejecting removal of the last measure/track. Test replay of an invalid native command before changing the active document.
- [ ] Run `npm test -- src/engine.test.ts` to confirm failures, implement the finite command operations, and call supported score finalization APIs to rebuild timing/links. Duration overflow uses actual meter and tuplet timing rather than an assumed four quarters. Preserve supported imported data outside the edited field.
- [ ] Obtain minimal GP3/4/5, GPX, and GP7/8 compatibility fixtures from a primary public upstream test corpus, recording source revision, hashes, and permissions. Author new fixtures when redistribution terms are unclear; keep reference-only inputs in `.analysis`. Pin known track/tuning/measure/note/duration expectations from their upstream tests or explicit fixture construction. Never substitute exporter-generated `.gp` for a GP3/GPX test.
- [ ] Verify those fixture expectations, a corrupt-file error, and supported-field export/reimport. Record advanced-feature limits, including bends, separately. Run `npm test -- src/engine.test.ts src/compatibility.test.ts` and `npm run typecheck`, then commit the working music adapter.

## Task 3: Tauri window and native document workflow

**Files:** Create `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src/bridge.ts`, `src/controller.ts`, `src/controller.test.ts`, `src/main.tsx`, `index.html`; update Cargo/package configuration and `src-tauri/src/lib.rs`.

**Interfaces:** Consume Tasks 1 and 2. Define `DocumentCandidate = {project: Project; path: string | null}` in the Rust/TypeScript contracts. Native command names are `read_document`, `replace_project`, `project_snapshot`, `apply_edit`, `undo_edit`, `redo_edit`, `save_project`, and `export_gp`. TypeScript `NativeBridge` maps these to camelCase methods with typed results. `readDocument(): Promise<DocumentCandidate | null>` stages a candidate or cancellation; imports use path=null so native Save cannot overwrite the Guitar Pro source. `saveProject(saveAs: boolean): Promise<ProjectSnapshot | null>` returns the resulting snapshot or cancellation; `exportGp(bytes: Uint8Array): Promise<boolean>` uses a separate `.gp` destination. `DocumentController` methods are `open()`, `new()`, `edit(command)`, `undo()`, `redo()`, `save(saveAs)`, `export()`, and `requestClose()`.

- [ ] Write failing controller tests: cancelled open/save keeps the existing snapshot; malformed project replay keeps the active score; failed native edit commit discards the candidate; failed save leaves dirty=true; overlapping document actions are serialized. Use a mock bridge here and native file tests in Task 1.
- [ ] Run `npm test -- src/controller.test.ts` to confirm failure. Implement the narrow bridge and sequential controller. Validate/project music first, commit native state second, publish the displayed score last. Open/new/close use save/discard/cancel when dirty.
- [ ] Wire Tauri's dialog support, app state, file commands, and close-request behavior. File reads stage documents rather than replacing active state; writes use Task 1's safe writer. Check Rust/TypeScript protocol serialization against `tests/protocol.json` for every command variant.
- [ ] Start the Tauri development application, render a score through the real bridge, and test native open/save cancellation and an unwritable destination. Run native/frontend tests plus `cargo check --manifest-path src-tauri/Cargo.toml`; commit the functioning desktop document workflow.

## Task 4: Score, tracks, and editing interface

**Files:** Create `src/App.tsx`, `src/App.test.tsx`, `src/ScoreView.tsx`, `src/EditorPanel.tsx`, `src/TrackPanel.tsx`, `src/styles.css`; update `src/main.tsx` and selection helpers in `src/controller.ts`.

**Interfaces:** Consume `DocumentController`, `ProjectSnapshot`, and the engine selection description. `ScoreView` renders a `Score` and publishes `BeatTarget`/string selection. `EditorPanel` publishes the finite `EditCommand` values. `TrackPanel` selects tracks and edits name/tuning/instrument through the existing commands. Components receive callbacks rather than importing native commands.

- [ ] Write failing interaction tests covering selection of a rendered note and an empty string/rest, fret entry, chords, duration/rest edits, keyboard beat/string navigation, structural edits, and undo/redo buttons. Following deletion of the selected last beat/bar/track, assert selection points to a surviving location.
- [ ] Run `npm test -- src/App.test.tsx` to confirm failure. Implement a clear original desktop layout with file/undo toolbar, track list, central notation, and beat inspector. Enable engine note bounds and use supported note events; the inspector supplies targets for empty strings and rests.
- [ ] Add controls for every milestone edit, title/artist/initial tempo, and tuning. Show overflow errors and remaining measure duration. Buttons reflect valid selections, history state, and native-action progress. Use labels, keyboard focus, and accessible controls.
- [ ] Verify a two-track composition visually in the app and test the same edits through the interface. Run frontend tests/typecheck, review React components with the applicable skill, and commit the complete basic editor.

## Task 5: Offline playback and practice controls

**Files:** Create `src/playback.ts`, `src/playback.test.ts`, `src/Transport.tsx`; update `src/ScoreView.tsx`, `src/App.tsx`, Vite/Tauri asset settings, and add licensed font/SoundFont assets plus `THIRD_PARTY_NOTICES.md`.

**Interfaces:** `PlaybackController` wraps alphaTab's player with `play()`, `pause()`, `stop()`, `seekToMeasure(index)`, `setSpeed(percent)`, `setLoop(startMeasure, endMeasureInclusive)`, `clearLoop()`, `setTrackVolume(track, value)`, `setMute(track, value)`, `setSolo(track, value)`, and `setMetronome(value)`. `beforeScoreChange()` stops playback; `replaceScore(score)` refreshes render/MIDI state. Transport uses these methods and subscribed player events.

- [ ] Write failing tests using the actual generated MIDI/tick information: inclusive loop endpoints, first/last measure seeking, speed changes, mute/solo combinations, and stop-before-edit ordering. Convert measure ranges through engine tick information; do not multiply by a constant measure duration.
- [ ] Run `npm test -- src/playback.test.ts` to confirm failure, then implement the public player controls and cursor synchronization. Enable audio after a user gesture and keep transport state tied to engine events rather than optimistic labels.
- [ ] Bundle fonts, workers, and a SoundFont with verified redistribution terms and notices. Load assets from the packaged app; test playback using a score with sounding notes, not an all-rest score. Make no claim of RSE sound equivalence.
- [ ] Run all unit/type checks and test actual audible playback, seeking, looping, and edited notes in the native app with networking disabled. Record any platform-specific webview limitations; commit the practice player.

## Task 6: Packaged workflow, compatibility evidence, and delivery

**Files:** Create `tests/desktop/` smoke tests and `docs/validation/2026-10-14-tabplayer-milestone.md`; update distribution configuration and add `README.md` with exact development/test/build commands. Add cross-platform CI configuration if useful for available runners; a checked-in workflow is not proof that it ran.

**Interfaces:** Exercise the full application from Tasks 1–5 through actual file dialogs or native test hooks restricted to development/test builds. The delivery report distinguishes passing tests, observed packaged behavior, and unavailable OS/runtime validations.

- [ ] Build the Windows native distribution. Use the Tauri-supported desktop automation path where available; verify actual native file writes, then restart the packaged application and reopen the saved project. If automation cannot inspect a control, perform and record an equivalent native smoke check rather than substituting a mocked bridge.
- [ ] Cover open → edit → play → native save → restart → reopen → `.gp` export. Compare preserved source bytes and supported musical fields. Open exports in Guitar Pro when that runtime is available; report model reimport and original-runtime acceptance as distinct checks.
- [ ] Create a 100-measure/four-track fixture, measure load/edit/redraw times, and resolve stalls that obstruct normal use. Run packaged checks with networking disabled and verify no extracted Guitar Pro assets entered the distribution.
- [ ] Run the full frontend/native test suites, typecheck, Rust formatting, and `git diff --check`; capture the observed output once. Test Linux/macOS builds and packaged audio on actual corresponding runners when available. Keep those validations explicitly pending if this Windows environment cannot execute them.
- [ ] Review the whole change independently, resolve actionable findings, update notices and documentation, and deliver the executable/source with remaining compatibility and OS verification limits clearly stated.

## Plan review

Every first-milestone requirement maps to Tasks 1–6. The finite command names and snapshot contract are shared across all tasks; persistence stores original bytes and applied commands rather than engine JSON. Task 6 separates internal model fidelity, actual Guitar Pro acceptance, and packaged OS checks. Advanced techniques, detailed voice management, backing audio, PDF/MIDI/audio export, and RSE-like sound are future milestones.

Recommended execution: native implementation in this session followed by one independent whole-change review. The tasks share the same project/command contract, so a single implementer can keep those interfaces consistent without repeated handoffs. Implementation begins only after the user reviews this plan and chooses execution.
