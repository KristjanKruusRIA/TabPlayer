# GP8 entry and interchange implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver pitched/drum note editing, full song metadata, direction/spelling controls, accurate track GP automation and MusicXML intake as the first parallel parity batch.

**Architecture:** Workers add isolated public-model modules and panels. Root integrates shared command contracts in TypeScript/Rust, replay, playback/export and the existing approved layout. The full parity inventory remains open beyond this batch.

**Tech Stack:** Rust 1.88/Tauri, TypeScript/React, alphaTab 1.8.4, Vitest, fflate 0.8.3.

**Spec:** `docs/superpowers/specs/2026-10-15-gp8-feature-parity-design.md`

## Global constraints

- Windows, macOS and Linux; existing approved editor layout.
- Keep native project/source/history compatibility and immutable source bytes.
- No dependency patching, proprietary resources in Git, or fake GPIF parity fields.
- Root owns shared schemas, engine, App, EditorPanel, ScoreView, dependencies, native DTOs, Git and desktop apps.
- Workers run focused checks and report exact changed files, commands and limitations; no Git mutations.

## Review focus

- Transposed pitched staves: written C4 with transposition 12 sounds MIDI48; display transpose does not change audio.
- Custom percussion index overrides a standard articulation ID; independently decode resulting SMF pitch/channel.
- Repeated bars and midbar controller events keep their performed timing and existing fade events.
- Structural rebuild and save/reopen preserve per-note dynamics and links.
- Old projects and invalid command fields retain exact schema behavior in both languages.

### Task 1: song metadata, directions and spelling

**Files:** create `src/editor/song.ts`, `src/editor/directions.ts`, `src/editor/pitch.ts`, `src/editor/SongPanel.tsx`, `src/editor/DirectionsPanel.tsx`, `src/editor/SpellingControl.tsx` and matching tests. Root integrates shared contracts later.

**Interfaces:** each pure router accepts `(score:model.Score, edit:EditCommand):boolean`, returning false for commands it does not own. Names: `applySongEdit`, `applyDirectionEdit`, `applyPitchEdit`. Panels receive score/current target and an `onEdit(EditCommand)` callback, following existing panel conventions. Commands have exactly the fields in the spec.

- [ ] Write/run failing tests for all eight metadata strings including empty values; invalid direction values; duplicate direction normalization; all seven spelling modes with invariant sounding pitch.
- [ ] Implement pure routers and focused existing-style controls without shared-file edits.
- [ ] Verify public GP roundtrip and DC/DS/Fine itineraries using authored fixtures; report pickup/D.C. defect separately.
- [ ] Run module and panel tests, report exact public interfaces and evidence for root integration.

### Task 2: non-tab tracks, notes and generic techniques

**Files:** create `src/editor/non-tab.ts`, `src/editor/NonTabPanel.tsx`, `src/editor/percussion-catalog.ts` and matching tests; modify only `common.ts`, `techniques.ts`, `TechniquePanel.tsx` as needed for indexed addressing.

**Interfaces:** `applyNonTabEdit(score:model.Score, edit:EditCommand):boolean`; `IndexedNoteTarget {target:BeatTarget; noteIndex:number}` in shared types provided by root. `noteAt` accepts legacy or indexed target. Commands/numeric domains exactly as spec. Export a finite named articulation catalog, respecting custom track overrides. Root adds schemas/types concurrently.

- [ ] Write/run failing tests for piano chords, transposition, drum mapping/custom overrides, invalid pitch/articulation/index, removal and existing string edits.
- [ ] Implement new tracks, indexed entry and selection controls with public model types.
- [ ] Extend technique/link resolution for pitched and percussion notes; reject string-only effects where unsupported.
- [ ] Independently decode SMF: piano C4/A4/G9 -> 60/69/127; transposed C4 ->48; percussion91/92/114/124 ->38/46/43/62 on channel9; custom0 ->82. Test more than15melodic editor tracks without implying unrestricted SMF export.
- [ ] Verify JSON rebuild and GP roundtrip; report any public importer losses. Run focused tests and hand off without shared-file edits.

### Task 3: owned GP track-automation adapter

**Files:** create `src/interchange/gp.ts`, automation helper and matching authored fixture/tests. Root installs fflate and integrates engine/MIDI callers.

**Interfaces:** `loadInterchangeScore(bytes:Uint8Array,settings:Settings):model.Score`; `exportGpInterchange(score:model.Score,settings:Settings):Uint8Array`. Provide an explicit helper contract for extracting exact performed controller points and preparing a detached MIDI generator model before root integration; preserve existing controllers/fades.

- [ ] Write/run failing real-GPIF tests for DSP11/12, master track ordering, ratios .333333 and .375, Linear flags and sibling archive bytes.
- [ ] Implement standard-GPIF ZIP/XML adapter; non-GP-ZIP imports retain public loader behavior.
- [ ] Write/run timing tests covering repeats, fractional positions, linear events and fade controller preservation; implement owned helper with no global CC7 deletion.
- [ ] Run focused tests; report root integration sequence and remaining master/linear semantics gaps honestly.
- [ ] Correct reproduced GP drum references using the native articulation table; prove standard/custom output pitches through repeated GP roundtrips without source mutation.
- [ ] Add `preparePitchedGpScore(score,settings):model.Score` in `src/interchange/pitched.ts` with RED→GREEN tests for sounding/display pitch preservation, chords, ties, multi-staff offsets and supported trills. Root applies it before GP export and carries archive sibling provenance to the detached model. Keep stringed transposition compatibility open.

### Task 4: shared protocol and engine integration (root)

**Files:** `src/edit-types.ts`, `src/project.ts`, `src/editor/advanced.ts`, `src/engine.ts`, `src/editor/structure.ts`, `src-tauri/src/edit_types.rs`, shared protocol fixtures/tests and `src-tauri/src/lib.rs`.

- [ ] Add failing TypeScript/Rust command-validation fixtures for every new finite command, invalid domains, unknown fields and old project replay.
- [ ] Add exact shared variants/validation, route isolated feature modules, stable identities for new track types, empty-tuning validation and non-tab pitch handling.
- [ ] Add a regression proving dynamics3 survives rebuild, subsequent edits, replay and generated velocity; fix normalization in owned conversion logic and verify links remain intact.
- [ ] Integrate GP wrappers and exact automation timing for playback/SMF. Add MusicXML file filters and fixtures; keep importer fidelity defects open for later fixes.
- [ ] Run focused shared checks, full frontend/typecheck and Rust locked tests using toolchain1.88.0.

### Task 5: editor integration, review and desktop evidence (root)

**Files:** `src/App.tsx`, `src/EditorPanel.tsx`, `src/ScoreView.tsx`, styles and integration tests as required by existing locations.

- [ ] Read Superdesign skill and existing draft state; preserve approved layout while integrating the focused controls.
- [ ] Add meaningful integration tests for piano/drum selection, note-name editing, metadata, directions, undo/redo and save/reopen.
- [ ] Start one root-owned preview; inspect visual layout and the complete user workflows. Verify actual generated/native note pitches and automation rather than labels alone.
- [ ] Obtain independent spec/quality review of immutable feature changes; fix material defects and rerun affected checks.
- [ ] Commit verified batches, update the full requirement ledger with evidence/status and continue subsequent parity families without new approval requests.

## Plan self-review

This plan implements only the first explicitly bounded delivery in the umbrella design. Later families remain open in the requirement matrix and receive separate evidence-based plans. Interfaces, ownership and all five review-focus conditions are assigned above. The user's explicit standing approval authorizes execution now; no additional approval gate applies.
