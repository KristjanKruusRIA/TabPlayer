# Guitar Pro 8 Selections and Range Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact editable selections and reversible note-range Erase/Transpose/String Move/Re-finger/sustain assistants.

**Architecture:** Root stages shared types and owns native/UI/replay integration. A fingering worker and a selection/range worker implement isolated modules in parallel against those types; each provides RED/green evidence and receives fresh review before root acceptance.

**Tech Stack:** Existing React/TypeScript, alphaTab1.8.4, Rust/Tauri and Vitest; no new dependencies.

**Spec:** [2026-10-15-gp8-range-editing-design.md](../specs/2026-10-15-gp8-range-editing-design.md)

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared DTOs/validators, engine/router, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds, native verification and final integration. Workers edit only assigned modules and tests.
- Validate the entire command and every destination before mutation. Each mutation is one native history entry; selection changes never dirty the project.
- Source files, GP archive siblings, backing bytes, raw lyric text and unrelated music remain immutable. Preserve per-note dynamics and surviving note relationships through rebuild/replay.
- Keep the approved slate/cream/lime layout. Use note names in user pitch displays and one-based labels for zero-based internal indices.
- Public-model retention, native replay, notation, actual MIDI/audio output and GP8 runtime compatibility require separate evidence; full parity remains open.

## Review Focus

1. Invalid last selected note/placement must leave every earlier note and native history unchanged; tests in Tasks2/3/4 pin atomicity.
2. Linked notes outside selection and natural harmonics must retain musical invariants; Tasks2/3 test actual pitch, constraints and boundary tie policy.
3. Erase/rebuild must retain raw lyric text, backing/archive bytes, fractional DSP events and dynamics3; Task4 tests complete history/source lifetimes.
4. Grace groups and overlapping independent voices must resolve once by the specified attack semantics; Task3 tests membership and Task5 verifies rendering.
5. Score gestures/shortcuts must not hijack text fields or change practice loops/seek position; Tasks4/5 test DOM behavior and native interaction.

---

### Task 1: Root stages the shared contracts and protocol

**Files:** Create `src/editor/range-types.ts`; modify `src/edit-types.ts`, `src/parity-commands.ts`, `src/parity-commands.test.ts`, `src-tauri/src/edit_types.rs`, `src-tauri/tests/protocol.rs`, `tests/protocol.json`.

**Interfaces:** Produce all spec types verbatim, including the explicit `bars` selection and `FingeringRequest.fixedString`; extend EditCommand with RangeCommand. No worker owns these files. Existing BeatTarget/IndexedNoteTarget are reused.

- [ ] Write failing shared protocol cases for every command and all3selection variants. Assert unknown nested field, duplicate note/lane/track, empty arrays, fractional/negative/u32-overflow indices, transpose0/±128, maxFret0/128, invalid direction/kind and enabled:null reject in TS/Rust. Valid transpose±127, maxFret1/127 and bar selection0..0 deserialize consistently; score existence is not assumed at protocol level.
- [ ] Run `npx vitest run src/parity-commands.test.ts` and `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test protocol`; capture expected failures from missing contracts.
- [ ] Add strict shapes/domains and the shared types from the spec. Root records range commands as non-settings edits. Do not change legacy command domains.
- [ ] Rerun both commands; all fixture/validation assertions pass. Root stages shared types so Tasks2/3 can run in parallel.
- [ ] Root commits only reviewed task files after focused checks; workers do not operate Git.

### Task 2: Pure collision-free fingering

**Files:** Create `src/editor/fingering.ts`, `src/editor/fingering.test.ts`.

**Interfaces:** Consume `FingeringRequest`/`FingeringPlacement` from range-types; produce `planFingering(staff:model.Staff,requests:FingeringRequest[],maxFret:number):FingeringPlacement[]`. No selection-module import or passage state.

- [ ] Write failing `complete_assignment_beats_greedy_choice`: on tuning whose playable candidates let noteA use strings1/2 and noteB only1, assert A->2 and B->1 with no duplicate string. `fixed_request_reserves_unselected_string` keeps a fixed note's string/fret/ID and rejects an impossible final request without source mutation.
- [ ] Write `actual_pitch_capo_transposition_and_twelve_nonmonotonic_strings`: candidate sounding pitches equal requested output with capo/sounding offsets; standard model string1/fret5 sounds45 and model string2/fret0 also45. Include9and12strings, reject13strings, pitch0/127 boundaries and duplicate-open-pitch ambiguity at move-policy level in Task3.
- [ ] Write `harmonic_and_tie_break_are_explicit`: detached natural harmonic candidates use actual realValue; impossible same-harmonic shift throws; fixed note identity/effects/dynamics remain unchanged, including original fret30 with movable maxFret24. Equal-cost assignments use lower center then lexicographic strings in request order, then lower fret vector for equal harmonic choices; repeated calls return equal placements without object mutation. Invalid fret bounds0/128 reject.
- [ ] Run `npx vitest run src/editor/fingering.test.ts`; confirm missing-export/behavior RED.
- [ ] Implement the pure one-chord solver using per-center string-mask DP and the exact cost/tie breaks from the spec; support1..12strings, movable frets0..maxFret, legal fixed frets0..127 and fixedString constraints. Reuse model getters via detached candidate notes attached to the target staff.
- [ ] Rerun the focused tests; request fresh scoped review of pitch arithmetic/collisions/atomicity. Root commits after accepted fixes.

### Task 3: Selection resolution, range edits and inspector

**Files:** Create `src/editor/range-selection.ts`, `range-selection.test.ts`, `range-edits.ts`, `range-edits.test.ts`, `RangePanel.tsx`, `RangePanel.test.tsx`.

**Interfaces:** Consume Task1 types, existing common rhythm/location helpers, capture/restore/detach links, and Task2 `planFingering`. Produce all6selection functions, `applyRangeEdit(score,command):boolean`, and `RangePanel(props:RangePanelProps)` as specified. Root owns router/UI wiring.

- [ ] Write `half_open_onsets_reverse_drag_and_partial_chord`: in two4/4bars with quarter onsets0/960/1920/2880, [bar0,960..bar1,960) resolves exactly4attacks and excludes bar1tick960. Reverse beat drag yields the same range. Two lanes/tracks resolve each note once. A named chord note excludes its unselected neighbor. Empty/free-time SelectBar/SelectTrack return bars selections without fake ticks.
- [ ] Write `grace_groups_follow_attack_and_validate_all_lanes`: before-beat/on-beat grace join their associated selected attack in source order; an explicit grace-only note selection works. Invalid final lane/note rejects and resolvers never mutate arrays/links. Duplicate input addresses reject before resolution.
- [ ] Write `erase_only_member_and_preserve_beat`: remove one linked chord member, detach incoming/outgoing links, keep other member, rhythm/text/chord/gesture/automation and mark a last-note beat as a rest. Capture before/after fingerprints for invalid last target and assert equality.
- [ ] Write `transpose_literal_pitches_and_boundary_tie`: piano60/64 +1 ->61/65 and +12 ->72/76; sounding offset12 gives48->49; selected trill value also shifts; forced accidental resetsDefault. Internal ties stay equal/connected; a boundary tie detaches without moving its unselected endpoint. Drum mixed selection and out-of-range last pitch reject atomically. Dynamics3/bend intervals stay unchanged.
- [ ] Write `string_move_refinger_and_sustain`: selected string1/fret5 -> higher string2/fret0 keeps45; occupied neighbor, duplicate-open ambiguity, external same-string link and impossible harmonic reject all. Re-finger uses Task2 deterministic per-chord plans and locks linked notes. Sustain changes only requested strings/kind, skips unselected chord members and rejects nonstringed lanes.
- [ ] Write panel tests asserting correct command envelopes for±1/±12, explicit semitones, selected-string flags and maxFret24; busy disables mutations, scope/count is visible, selection actions invoke onSelection and never onEdit.
- [ ] Run `npx vitest run src/editor/range-selection.test.ts src/editor/range-edits.test.ts src/editor/RangePanel.test.tsx`; capture RED. Task2 may be finishing in parallel; do not replace its module or add a competing solver.
- [ ] Implement spec functions and panel with complete proposed mutations validated before assignment/removal. Keep changes in these new files; do not refactor non-tab/structure/techniques.
- [ ] Rerun focused checks after Task2 lands; request fresh scoped review for membership/link/pitch correctness and UI envelope agreement. Root commits accepted task files.

### Task 4: Root joins history, sources and visible selection

**Files:** Modify `src/editor/advanced.ts`, `src/engine.ts`, `src/App.tsx`, `src/ScoreView.tsx`, `src/EditorPanel.tsx`, `src/styles.css`, `src/selection.ts`; create `src/editor/range-replay.test.ts`, `src/range-interaction.test.tsx`; extend `src/controller.test.ts` if needed.

**Interfaces:** Consume Task2/3 public APIs and RangePanelProps. App stores `MusicSelection|null` separately from BeatTarget. ScoreView receives editor selection callbacks/props and exposes public-model beat/note hit events; root chooses local prop names consistently in component/tests. No playback controller API changes are required.

- [ ] Write `range_command_replays_one_undo_and_preserves_sources`: authored source GP with WAV and sibling entry, raw lyric text `[VERSE]\r\nHel-lo  world+today`, visible/managed source slots, note dynamics3 and DSPratio.25 carried atbeat3. Apply range edit -> later notation/settings edit -> save-style serialize/reopen -> undo/redo; assert raw text/slots/visibility, WAV/sibling bytes, fractional automation and unrelated music unchanged. Native history gains exactly1entry; invalid last target gains0.
- [ ] Write `selection_shortcuts_do_not_dirty_seek_or_loop`: Ctrl/Cmd+A and triple-click select active track; Ctrl/Cmd-click toggles one chord note; Shift/reverse drag/handles change endpoints; Escape clears. Inputs/selects/textareas/contenteditable preserve text shortcuts. Assert no controller.edit, seek, or practice-loop mutation from selection actions. Document replacement clears old indexed selection.
- [ ] Run `npx vitest run src/editor/range-replay.test.ts src/range-interaction.test.tsx src/controller.test.ts`; capture RED.
- [ ] Register range routing and rebuild before derived-timing consumers and after mutation. Retain dynamics restoration, captured links and copyGpInterchangeSource immediately on full clones. Wire RangePanel and public alphaTab highlights/owned note overlays; remove subscriptions on teardown. Preserve keyboard cursor entry behavior outside modifiers.
- [ ] Rerun focused tests, `npm run typecheck`, and condensed React best-practices review for edited TSX. Root requests a fresh integration review and commits after issues are fixed.

### Task 5: Root verifies musical/native workflow and records evidence

**Files:** Create `tests/desktop/parity-range.mjs`, `docs/validation/2026-10-15-gp8-range-editing.md`; extend owned tests only for newly found issues.

**Interfaces:** Use existing desktop-test bridge/harness and native build scripts; no production diagnostic hooks or private songs are committed.

- [ ] Add independently decoded SMF assertions for piano60/64->61/65, octave72/76, offset48->49 and guitar refingering unchanged45; assert velocities retain authored dynamics3. Separate the known trill-alternate limitation from primary note success.
- [ ] Run full frontend/native suites once integration is stable, `npm run typecheck`, `cargo +1.88.0 fmt --manifest-path src-tauri/Cargo.toml -- --check`, and root's desktop-test release build. Report explicit hardware/bank skips accurately.
- [ ] Run actual desktop selection/partial chord/drag/handles/keyboard/text-field flows, transpose/refinger/sustain/erase, one-step undo, native save/process restart/reopen and GP/MIDI roundtrip. Compare private source hashes unchanged; screenshot visible selection/inspector without exposing private content in Git.
- [ ] Request an independent whole-delivery review, fix evidence-backed findings with focused RED tests, and rerun affected/full checks only as changes justify. Root records accepted commands/results/limits and commits/pushes according to the standing workflow.

## Self-review and handoff

Coverage: every spec type/API/command maps to Tasks1–4; musical/native evidence is Task5. Each review focus has named RED tests. Finger solver has no dangling preferredCenter API or hidden passage state; bars selection handles empty free-time context. Plans describe assertions/interfaces rather than implementing bodies. Clipboard/theoretical transpose/optimizer/runtime gaps remain open explicitly. User preapproved this execution method; root proceeds after adopting these docs without another permission question.
