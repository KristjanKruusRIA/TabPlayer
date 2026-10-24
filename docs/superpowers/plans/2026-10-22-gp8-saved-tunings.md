# GP8 Saved Personal Tunings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method is already authorized: two disjoint implementation owners, one joined source review, then root checks and one owned fresh desktop run; do not ask another approval question.

**Goal:** Durable personal tuning management with draft-only recall and atomic, replayable document name snapshots.

**Architecture:** Add a tuning-specific native atomic store and strict TS bridge. Extend existing tuning-bearing commands with an optional name and reuse the shared tuning field and ordinary edit routes. The library never edits the active score.

**Tech Stack:** Existing Rust/Tauri 2, TypeScript/React, Vitest, and alphaTab 1.8.4; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-22-gp8-saved-tunings-design.md` (read with this plan).

## Global constraints

- Wait for root's S14 source/runtime release, or use a root-approved isolated checkout. Both owners are not alone in the codebase: preserve others' edits, accommodate released S14 changes, and do not revert them.
- Existing 25 built-ins remain immutable: guitar 6–9 and bass 4–6. Personal entries accept 1–12 MIDI pitches in high-to-low order; inputs display note plus octave.
- `tuning-library.json` uses exact `{format:'tabplayer-tuning-library',version:1,entries}` and `{id,name,tuning}` records. Names are trimmed, 1–80 Unicode scalars, valid XML characters; IDs are UUIDs.
- Use the root-inspected image `953C3FB9…` and its disposition; no additional generation. One primary Use tuning, secondary Save changes, no abbreviated pitch strings.
- Omitted `tuningName` preserves the prior route semantics; explicit `''` clears; a string snapshots the name. Document names are not subject to the library's 80-scalar cap.
- No generic preferences/storage architecture, localStorage substitute, audio playback, or broad harness rewrite. S15 remains partial until all gates pass.

## Review focus

1. Corrupt storage or invalid replacement must preserve existing bytes and leave document state alone (Task 1).
2. Two identical pitch arrays with different IDs/names must remain independently selectable, renameable, and deletable (Tasks 1 and 3).
3. An older read, rejected queued mutation, or document switch must not overwrite a newer library snapshot or another draft (Task 3).
4. Omitted legacy fields and explicit custom-name clearing must behave differently without changing S14 rollback/remapping behavior (Task 2).
5. Unicode/XML text including `]]>` must survive clone/native replay/GP roundtrip; library rename/delete must not alter snapshots (Tasks 2 and 4).

## Ownership and file map

**Owner A — native storage/registration only:** create `src-tauri/src/tuning_library.rs`; modify `src-tauri/src/lib.rs` for module, wrappers, and both command registrations. Native inline tests remain in the new module. Mirror `harmony_library.rs`/`files.rs`; do not change them.

**Owner B — frontend, wire/model, UI, and strict types:** create `src/tuning/library.ts`, `src/tuning/library.test.ts`, `src/tuning/SavedTuningsDialog.tsx`, `src/tuning/SavedTuningsDialog.test.tsx`, and `src/tuning/saved-tunings-dialog.css`; modify `src/TuningInput.tsx`, `src/workstation/TrackSettingsPanel.tsx`, `src/editor/StructurePanel.tsx`, `src/edit-types.ts`, `src-tauri/src/edit_types.rs`, `src/parity-commands.ts`, `src/engine.ts`, `src/editor/structure.ts`, and `src/interchange/gp.ts`. Extend the named existing test anchors below; add `src/editor/saved-tunings.test.ts` for cross-route replay/roundtrip cases. This owner alone edits Rust command types, avoiding collision with Owner A's registration work.

**Root — integration/review/verification:** assigns the single joined reviewer and owns post-join checks, final source identity, isolated desktop profile, and narrow acceptance driver/evidence. Owners do not build/run the desktop app concurrently. No source file is jointly owned; negotiate changes in file ownership before editing outside these lists.

## Task 1 — Owner A: native durable store

**Interfaces:** `SavedTuning { id: String, name: String, tuning: Vec<i32> }`, `TuningLibrary { format: String, version: u32, entries: Vec<SavedTuning> }`; module functions `read_library(root: &Path) -> Result<TuningLibrary,String>`, `put_entry(root: &Path, entry: SavedTuning) -> Result<TuningLibrary,String>`, `remove_entry(root: &Path, id: &str) -> Result<TuningLibrary,String>`. Tauri commands `tuning_library_read`, `tuning_library_put(entry)`, `tuning_library_remove(id)` return the same envelope. Copy the harmony store's locking/atomic pattern, with a separate lock/file.

- [ ] Write failing inline tests: `missing_is_empty_without_write`; `save_reopen_rename_delete`; `same_pitches_distinct_ids`; `case_insensitive_uuid_replaces_without_reordering`; `invalid_and_corrupt_preserve_bytes`; `library_does_not_touch_document_or_session_files`. Assert rename retains ID/pitches, reopening observes durable changes, removal of absent ID succeeds, and corrupt bytes are exactly unchanged after attempted put/remove. Include MIDI -1/128/fractional JSON, 0/13 strings, blank/81-scalar/invalid-XML names, invalid/duplicate UUID, unknown keys/version/format, and malformed JSON.
- [ ] After root releases native checks, run `cargo test --manifest-path src-tauri/Cargo.toml tuning_library` and confirm failures are missing behavior, not setup failures. Every test gets its own temporary root; no production app-data path or process-global test environment mutation.
- [ ] Implement strict types, validation, read-modify-write serialization, atomic persistence, and app-data/spawn-blocking wrappers. Validate existing bytes before replacement; never recreate corrupt storage. Register all three commands in both lists.
- [ ] Rerun the focused native command; require all tests pass. Hand Owner B the final command envelope and errors, and report exact files changed. Root controls commits after joined review; do not commit another owner's files.

## Task 2 — Owner B: compatible atomic name snapshots

**Interfaces:** add `tuningName?: string` / optional Rust string to `setTuning`, `setStringCount`, `addTrack`, and `StaffSettings` for set/add staff. Exact validators accept old shapes and one optional string; reject null/extra keys. Explicit names are applied after successful existing retune/remapping; omitted names keep old per-route semantics. The model endpoint is `staff.stringTuning.name`.

- [ ] Write failing tests in `src/editor/saved-tunings.test.ts` and extend `src/editor/string-count.test.ts` / `src/editor/structure.test.ts`: same-count retune, count change, add track, set staff, add staff carry notes/name in one undo step; failed remap carries neither; omitted command fixtures retain previous behavior; explicit empty clears; native serde and frontend exact keys accept/reject the same values. Include capo/clef-only settings preserving an imported name and legacy baseline replay.
- [ ] Run `npx vitest run src/editor/saved-tunings.test.ts src/editor/string-count.test.ts src/editor/structure.test.ts` and verify the new assertions fail for absent name propagation. Add corresponding Rust serialization tests alongside `edit_types.rs` and run `cargo test --manifest-path src-tauri/Cargo.toml edit_types` after root release.
- [ ] Implement optional command fields, strict shapes, replay/configure/name assignment, and UI-independent rollback semantics. Do not introduce a separate name edit or mutable library ID in a command. Keep S14 omitted-name paths unchanged.
- [ ] Add clone/undo/redo/project replay and actual `exportGpInterchange`/`loadInterchangeScore` tests for name `Öine & <hääl> ]]>`, empty name, long imported name, and unchanged high-to-low pitches. Implement the export-only tuning-label CDATA split only as needed to pass; live score and unrelated labels/content must be unchanged. Extend `src/editor/gp-coverage.test.ts` if its existing fixture path provides the application roundtrip anchor.
- [ ] Rerun these focused tests and native command-type tests; require passing evidence before UI integration. Report any incompatibility with released S14 source to root rather than overwriting it.

## Task 3 — Owner B: strict bridge and shared dialog

**Interfaces:** `readTuningLibrary`, `putTuningLibraryEntry`, `removeTuningLibraryEntry`, `subscribeTuningLibrary` and wire types exactly as in the spec. `TuningInput` adds required `tuningName` and `onTuningNameChange` alongside existing notes/revision props; update both callers and their fixtures in the same change. Dialog owns details and transient selection; callers own outer draft names/notes.

- [ ] Write `library.test.ts` failures for exact invoke payloads/envelopes, input/output cloning, Unicode scalar bounds/XML validity, queue ordering, queue recovery after rejected mutation, successful-only notifications, unsubscribe, and malformed native responses. Use deferred mocked promises to prove an old read cannot publish after a newer queued write. Do not exercise real app-data storage in frontend unit tests.
- [ ] Run `npx vitest run src/tuning/library.test.ts`; confirm intended failures, then implement the minimal validated queue/notification bridge. Fresh reads on dialog open refresh the list; notifications never update details or document drafts.
- [ ] Write dialog/shared caller failures in `SavedTuningsDialog.test.tsx`, `src/tuning-ui.test.tsx`, and `src/workstation/TrackSettingsPanel.test.tsx`: immutable built-ins; same pitches/different IDs; save/rename/delete with no `onEdit`; Use only fills notes/name; Cancel preserves draft; pitch-text edits in caller or dialog clear name/identity and disable Save changes until reselection; empty name permits Use but not Save; errors retain details/list; a second mounted caller sees library refresh; closing/switching documents ignores late responses. Assert name preservation through `StructurePanel` capo/clef edits using its existing structural test setup.
- [ ] Run `npx vitest run src/tuning/SavedTuningsDialog.test.tsx src/tuning-ui.test.tsx src/workstation/TrackSettingsPanel.test.tsx src/tuning-presets.test.ts`; confirm intended failures. Implement the compact two-column dialog and both callers, with visible full note/octave strings, personal/built-in sections, stable IDs, library Save versus draft Use versus document Apply, keyboard labels/focus, busy/percussion constraints, and internally scrolling short-height layout.
- [ ] Rerun the targeted tests and `npm run typecheck`; require all pass. Built-in catalog content/count must stay unchanged. Use a focused component stylesheet change, not a workstation redesign.

## Task 4 — root: joined review, checks, and one actual desktop run

**Inputs:** both owners' final files and test receipts. **Outputs:** one source review disposition, root verification receipts, and source-bound desktop evidence; only then an S15 status decision.

- [ ] Obtain one joined source review covering both owners against the spec and all five Review Focus conditions. Verify both native registrations, exact optional-key compatibility, custom clearing, all shared callers, queue failure recovery, corruption preservation, and export label handling. Resolve findings before checks; do not spawn independent duplicate reviews per file.
- [ ] After release and integration, run `npm run typecheck`, the combined focused Vitest commands above plus `src/editor/gp-coverage.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml tuning_library`, and the native edit-type test filter. Record exact commands/results and source identity. Root performs repository-required build/check steps once using the existing workflow; do not claim full-suite success from focused tests or introduce universal performance gates.
- [ ] Prepare a dedicated desktop acceptance profile and verify its effective app-data path before mutation. Keep its storage across the planned restart, then clean only that owned profile after evidence capture. If the existing launcher cannot isolate app data, stop runtime work and resolve isolation with root; never fall back to real user storage or a new preferences framework.
- [ ] Build/launch one fresh owned instance from the verified source. Use a narrow scenario driver based on the S14 owned driver pattern; keep the scenario focused, do not append a large general harness, and do not invoke audio playback. Capture actual desktop screenshots and native/library/document receipts.
- [ ] Execute: create two named same-pitch personal entries; Save leaves document clean/history unchanged; close/reopen app and find both; rename one without changing its ID; Use fills the draft without editing; Apply updates pitches/name in one step; undo/redo restores both; verify the score's actual name display; export/reopen GP and verify name/pitches; delete the library record and reopen the document to prove its label survives. Exercise a count-changing tuning through S14's normal route and reject one invalid pitch entry without damage. Check a short viewport keeps Cancel/Use available and all pitches include octaves.
- [ ] Record exact observed behavior and gaps. Mark S15 complete only if source review, automated gates, durable restart, atomic apply/history, actual GP roundtrip, both caller coverage, and actual desktop checks pass. Otherwise retain partial with the unmet gate named. No original-GP8, account, other-OS, performance, or shipping claim follows from this run.

Self-review: each spec requirement maps to Tasks 1–4; storage and command names/types agree across owners; review-focus tests are assigned; S14 ownership and test-profile isolation are explicit. This plan records future work only; no product edit, test, build, or desktop acceptance was performed while writing it.
