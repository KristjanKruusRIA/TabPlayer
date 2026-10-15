# Guitar Pro 8 Global Measure Transforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert global measures at any position and remove an inclusive range with reversible source/musical state preservation.

**Architecture:** Root stages shared command/index-map types. A measure worker implements notation transforms and a focused inspector; root joins raw-lyric/backing mappings and native replay using the same map, then verifies the actual desktop workflow.

**Tech Stack:** Existing React/TypeScript, alphaTab1.8.4, Rust/Tauri, Vitest and desktop Playwright harness; no new dependencies.

**Spec:** [2026-10-15-gp8-measure-transforms-design.md](../specs/2026-10-15-gp8-measure-transforms-design.md)

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared DTOs/validators, engine/router, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds, native verification and final integration. Workers edit only assigned modules and tests.
- Validate the entire command and every destination before mutation. Each mutation is one native history entry; selection changes never dirty the project.
- Source files, GP archive siblings, backing bytes, raw lyric text and unrelated music remain immutable. Preserve per-note dynamics and surviving note relationships through rebuild/replay.
- Keep the approved slate/cream/lime layout. Use note names in user pitch displays and one-based labels for zero-based internal indices.
- Public-model retention, native replay, notation, actual MIDI/audio output and GP8 runtime compatibility require separate evidence; full parity remains open.

## Review Focus

1. Structural changes after a settings-only edit must map embedded/asset backing anchors exactly as full history replay; Task3 tests both paths and invalid occurrences atomically.
2. A late carrier beat with a fractional DSP ratio must stay at its musical ratio, including boundary inherited state; Tasks2/4 decode events and check no duplicate/fade loss.
3. Raw lyric comments/CRLF/empty verse slots/visibility and unmanaged assignments must survive bar mapping and rebuild; Task3 tests exact source data separately from rendered syllables.
4. A retained contextual simile/repeat/direction cannot silently point to different music; Task2 tests all guards and complete-group success before mutation.
5. Links, note dynamics, per-staff key/clef/voices and archive/backing bytes must survive first/tail/multistaff edits without aliasing; Tasks2–4 test sources and actual native output.

---

### Task 1: Root stages strict measure commands and index-map types

**Files:** Create `src/editor/measures-types.ts`; modify `src/edit-types.ts`, `src/parity-commands.ts`, `src/parity-commands.test.ts`, `src-tauri/src/edit_types.rs`, `src-tauri/tests/protocol.rs`, `tests/protocol.json`.

**Interfaces:** Produce `MeasureCommand`, `BarIndexMap` and `MeasureTransformPanelProps` verbatim from the spec; extend EditCommand. Root coordinates shared edits with the range plan; workers never edit these files.

- [ ] Write failing protocol cases: insert before0/count1 and count1000; remove0..0; reject unknown fields, null/negative/fractional/u32-overflow indices, count0/1001 and reversed removal. Existence/keep-one-bar checks remain score-dependent. Assert legacy appendMeasure/removeMeasure fixture behavior is unchanged.
- [ ] Run `npx vitest run src/parity-commands.test.ts` and `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test protocol`; capture missing-command RED.
- [ ] Add strict TS/Rust shapes/domains and shared exported types; no recursive batch/history command or project schema bump.
- [ ] Rerun both checks; root commits accepted shared contracts and dispatches Task2 against them.

### Task 2: Global notation transforms, guards and inspector

**Files:** Create `src/editor/measures.ts`, `src/editor/measures.test.ts`, `src/editor/MeasureTransformPanel.tsx`, `src/editor/MeasureTransformPanel.test.tsx`.

**Interfaces:** Consume Task1 types, existing common/link helpers and interchange automation APIs. Produce `planMeasureMap(barCount,command):BarIndexMap`, `applyMeasureEdit(score,command):boolean`, `mapBackingMeasures(backing,map):void`, and `MeasureTransformPanel(props:MeasureTransformPanelProps)`; no lyric-source or document-settings ownership.

- [ ] Write `index_map_first_middle_tail_and_keep_one`:3bars insert2 before1 -> oldToNew[0,3,4], inserted[1,2]; insert at3 -> oldToNew[0,1,2], inserted[3,4]; remove1..2 from5 -> [0,null,null,1,2]. Reject removing all/count0/1001/invalid last bar before mutation.
- [ ] Write `all_tracks_staves_voices_inherit_without_alias`: guitar/piano/drum fixture with2staves/4voices and3bars; insertion2 before1 yields5 master/staff bars. Originalbar1 music moves3, note IDs/dynamics3/links remain; inserted key/clef/octave/meter/common/feel/beaming context is correct. New bars have voice0 meter rests/other carriers; free-time bars have carriers only. Existing sections/repeats/fermata/tempo/sync/chords/timers are not copied. Mutating one inserted beaming/rest object does not affect another or the source context.
- [ ] Write `remove_detaches_boundaries_preserves_survivors`: external ties/slides/hammer/slurs clear both directions on removed notes; retained internal relationships and solo-slide modes survive rebuild. Map lineBreaks by dropping removed positions and shifting survivors.
- [ ] Write `suffix_state_prefers_explicit_zero_and_uses_bar_ratios`: removed bars establish tempo90, program30, bank2, volume4/16, pan12/16 and sustainDown; suffix without ratio0 changes receives this state. Explicit suffix program42/tempo130/CC7/CC10 at0 wins, even when carried on another staff. DSPratio.25 onbeat3 is ordered by.25, not that beat's playbackStart; linear/text/visibility retained. Up at suffix0 cancels inherited sustain; Hold alone does not. No duplicated fades or controller family resets. Deleting the tail adds no suffix event; insert0 initializes old tempo.
- [ ] Write `context_guards_are_atomic`: split double-simile pair, change retained simple/double predecessor, orphan partial repeat group/ending, or remove directions while other directions survive -> throw with entire source fingerprint unchanged. Complete repeat-group removal and insertion within an intact repeat succeeds. Do not weaken guards merely to make fixtures pass.
- [ ] Write `backing_map_and_panel_envelopes`: anchor bar3->1 after removal1..2, removed anchor drops, occurrence/ratio/audioMs/offset/mix/assetId unchanged. Panel InsertAfter bar1/count2 emits beforeBar2/count2; one-based inclusive removal converts once; busy blocks submit/count1..1000 enforced.
- [ ] Run `npx vitest run src/editor/measures.test.ts src/editor/MeasureTransformPanel.test.tsx`; capture expected missing-function RED.
- [ ] Implement exact spec transforms, source-state ordering and preflight guards. Keep source raw lyric/document settings untouched for root Task3. Apply fresh public objects and preserve IDs; do not edit installed alphaTab or legacy structure commands.
- [ ] Rerun focused tests and request fresh measure-scoped review covering hidden voice/staff state, contextual guards and atomicity. Root commits accepted task files.

### Task 3: Root joins lyric/backing/source lifetimes and native replay

**Files:** Create `src/editor/lyrics-measures.ts`, `src/editor/lyrics-measures.test.ts`, `src/editor/measures-replay.test.ts`; modify `src/engine.ts`, `src/editor/advanced.ts`, `src/EditorPanel.tsx`, `src/App.tsx`, `src/selection.ts`, `src/styles.css`, and shared validation tests only when required.

**Interfaces:** Consume Task2 public functions. Produce root-owned `mapLyricsMeasures(score:model.Score,map:BarIndexMap):void` using existing getLyricsSource/setLyricsSource; no edit to lyrics.ts/source store is needed. Existing buildDocument/replayDocumentSettings consume the same map.

- [ ] Write `lyrics_map_exact_raw_and_distribution`: insertion before raw start moves its bar, removal of its start chooses mapped successor/last remaining; preserve `[VERSE]\r\nHel-lo  world+today`, empty verse slots, hidden/visible and managed flags exactly. Managed reflow follows mapped start after rebuild; unmanaged source Beat.lyrics stays with surviving beats. Inputs/source objects remain independent.
- [ ] Write `settings_fast_replay_matches_full_build`: asset-backed and embedded anchors with repeated occurrence mapping survive insert/remove plus later setTrackMix or setPrintLayout. Undo/redo/settings replay yields identical effective backing settings to full build; invalid surviving repeated occurrence rejects before bridge.applyEdit and leaves native history0additional entries.
- [ ] Write `source_and_notation_survive_native_style_history`: imported GP with sibling and WAV, multiple staves/voices, metadata, note dynamics3, directions/fermata and fractional controller. Insert -> range remove -> later edit -> project JSON roundtrip -> undo/redo retains expected map, raw sources, byte-identical WAV/sibling and unaffected music. Assert each new command adds1history entry and legacy append/remove history snapshots retain old semantics.
- [ ] Run `npx vitest run src/editor/lyrics-measures.test.ts src/editor/measures-replay.test.ts src/controller.test.ts`; capture RED.
- [ ] In root engine routing, prebuild derived state and plan map; map raw lyrics before array mutation; apply measure notation plus document/embedded backing map; rebuild with link capture/restoration, scoreFromJson dynamics and immediate copyGpInterchangeSource. Validate effective backing before committing. Mirror mappings in replayDocumentSettings. Wire MeasureTransformPanel and repair cursor to mapped survivor/successor; clear stale range selection. Do not introduce separate history entries for auxiliary updates.
- [ ] Rerun focused tests and `npm run typecheck`; perform condensed React review on edited TSX. Request fresh integration review; root commits accepted files.

### Task 4: Root verifies exported and native workflow

**Files:** Create `tests/desktop/parity-measures.mjs`, `docs/validation/2026-10-15-gp8-measure-transforms.md`; extend `src/editor/measures-replay.test.ts` with independent export assertions.

**Interfaces:** Existing GP adapter, export MIDI/public desktop-test bridge; no vendor/private fixture assets committed. This can share root's native build with the range delivery while keeping receipts/workflows distinct.

- [ ] Add GPIF assertions for5aligned bars after insert2, mapped key/meter/repeats/directions/fermata and DSPbar/ratio. Independently decode SMF suffix tempo90/program30/bank2/CC7=32/CC10=96 at the mapped boundary, plus explicit ratio0 overrides; verify actual controller ticks for a.25event after insertion/removal, not only serialized flags. Include held sustain versus explicit Up and unchanged authored note velocity.
- [ ] Run full frontend/native suites once both deliveries integrate, `npm run typecheck`, `cargo +1.88.0 fmt --manifest-path src-tauri/Cargo.toml -- --check`, then root's desktop-test build. Report actual counts/skips; do not ship the diagnostic executable as a production package.
- [ ] Exercise native InsertBefore/After and inclusive removal in a multitrack score, one-step undo/redo, failed contextual/anchor edits, save/full process restart/reopen and GP/MIDI export. Assert source/private corpus hashes and backing bytes unchanged. Verify selected cursor repair and preservation of approved layout.
- [ ] Obtain independent whole-delivery review; fix validated findings through RED tests and rerun affected verification. Root records evidence/explicit context and runtime limits, commits/pushes under standing authorization, and leaves full parity inventory open.

## Self-review and handoff

Coverage: Task1 owns exact DTOs; Task2 owns notation/index maps/guards/boundary state/inspector; Task3 owns raw lyric/backing/native history lifetimes; Task4 owns independent musical/desktop evidence. Each of5review focuses has named RED tests. Shared interfaces contain no undefined selection/clipboard dependency. Root owns Git and shared files throughout; no worker commits or target/app execution. The plan does not duplicate future clipboard design or claim simile/ramp/full-GP8 runtime parity. User preapproval permits execution after root adoption without a new permission question.
