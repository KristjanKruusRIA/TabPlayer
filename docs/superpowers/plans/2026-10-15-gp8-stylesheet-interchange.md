# Guitar Pro 8 Common/Cut Stylesheet Interchange Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user already selected parallel feature workers and preapproved this work; root coordinates integration without further approval questions.

**Goal:** Import the demonstrated full-score common/cut choice and export representable edits while preserving untouched inherited and view styles.

**Architecture:** Independent bounded adapters patch one established GPSS path and one legacy key while retaining opaque bytes. Ephemeral Score/MasterBar provenance distinguishes inherited absence from explicit numeric authoring through replay and clones. Root connects those modules to the existing GP merge and existing finite commands; unsupported changed projections fail before file writes.

**Tech Stack:** TypeScript, alphaTab1.8.4, fflate0.8.3, existing React/Rust/Tauri integration, Vitest.

**Spec:** [Common/cut stylesheet interchange design](../specs/2026-10-15-gp8-stylesheet-interchange-design.md). Read it in full; its exact signatures, error copy, bounds and unchanged-export policy are normative.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**; existing commands, clipboard versions **1/2**, and replay meaning stay compatible.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing TypeScript/React and Rust/Tauri stack; no new dependencies or vendor patches.
- Change only the demonstrated `StylesheetBase.bar(11) → BarStyle.showTimeSignatureAsSymbol(5) → OptionalBool.value(1)` path and legacy `Staff/drawTimeSignatureC` key. Do not invent a GPIF symbol field or expand other stylesheet options.
- Preserve original source bytes, unknown supported records, unrelated archive members, backing audio, raw lyrics, harmony and surviving links. No read/export operation adds document history or mutates canonical music.
- Untouched or semantically unchanged full-score intent preserves original stylesheet and scoreview bytes exactly. A changed projection rejects unsupported mixed or unresolved eligible-bar intent before output is written.
- Root owns shared integration, existing editor/engine/source-copy hooks, Git, full suites, builds, applications and CDP. Workers edit only their assigned new modules/tests.
- Retained static native evidence, independent byte/ZIP tests, public-model round trips, rendered output and original GP8 runtime acceptance are separate claims. Do not describe authored probes as original-GP8-opened fixtures.

## Review Focus

1. Explicit false after inherited absence must survive even when the displayed boolean was already false; untouched inheritance must remain opaque — Tasks3/4.
2. Intent must follow actual masters through clone, remove, insert, excerpt and clipboard rather than transfer to neighbors by stale index — Tasks3/4.
3. Deliberate original view overrides must not block unrelated exports; changed projection must not silently overwrite them — Tasks3/4.
4. A malformed unknown wire record or giant length must fail before allocations or partial writes, while supported opaque encodings stay byte-exact — Tasks1/2.
5. Style patching must run after original-source overlay on every export return path, including the no-XML fast path — Task4.

---

## File map and ownership

- GPSS worker: new `src/interchange/stylesheet-wire.ts` and `stylesheet-wire.test.ts` only.
- Legacy worker: new `src/interchange/stylesheet-legacy.ts` and `stylesheet-legacy.test.ts` only.
- Provenance/policy worker: new `src/editor/time-signature-source.ts`, `time-signature-source.test.ts`, `src/interchange/stylesheet.ts` and `stylesheet.test.ts` only. Its byte-adapter integration follows Tasks1/2; pure provenance can run in parallel with them.
- Root: small edits to `src/interchange/gp.ts`, `src/editor/bar-gestures.ts`, `src/editor/notation.ts`, `src/editor/measures.ts`, `src/engine.ts`, `src/export/ExportDialog.tsx`; new `src/interchange/stylesheet-replay.test.ts` and `tests/desktop/parity-stylesheet.mjs`; relevant existing editor/export/controller tests and a final validation note. No shared DTO/Rust schema changes.
- Use independently authored test bytes in test files; do not copy original GPSS descriptors, binaries or target implementation. The ignored evidence note and existing probes remain immutable supplementary evidence.
- Root commits independently accepted chunks, retains the full-parity goal and released main baseline, and handles final push. Workers do not commit or run full suites/apps/CDP.

### Task 1: Bounded lossless current-GPSS adapter

**Files:** Create `src/interchange/stylesheet-wire.ts`, `src/interchange/stylesheet-wire.test.ts`.

**Interfaces:** Produce `readGpStylesheetSymbol(bytes:Uint8Array):boolean|null` and `writeGpStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array`. Consume no other feature module. Bounds/error prefix are copied exactly from the spec.

- [ ] Write `reads_literal_optional_bool_presence` with independently literal bytes: empty root → null; `5a00` → null; `5a022a00` → false; `5a042a020800` → false; `5a042a020801` → true. Assert unchanged input and noneligible knowledge stays out of this byte layer.
- [ ] Write `creates_only_the_missing_target_path`: writing true to empty bytes gives `5a042a020801`; writing false gives `5a042a020800`. Exercise existing empty root/bar/wrapper with unrelated fields and assert only the required path changes. An already equal explicit false empty wrapper remains byte-equal; repeated same writes are byte-idempotent and outputs are detached.
- [ ] Run `npx vitest run src/interchange/stylesheet-wire.test.ts`; require meaningful RED for missing behavior.
- [ ] Implement the exact path **11/5/1**, wires **2/2/0**, checked uint64 varints, raw record spans and bounded replacement. Parse only the three target messages; preserve unknown payloads without recursion. Do not introduce a general schema/reflection abstraction.
- [ ] Write `preserves_opaque_records_at_every_target_level`: unknown wire0/1/2/5 records before and after target at root, bar and wrapper; duplicate unrelated fields; a bounded nonminimal unknown varint; length changes crossing127/128. Compare literal raw records/order and unchanged input, not only a writer-reader round trip.
- [ ] Write table-driven `rejects_outside_bounded_wire_contract`: wrong target wires at each level; duplicate target at each level; bool2; field0; field536870912; truncated/overflow/eleven-byte varints; length beyond remaining bytes; truncated fixed32/64; wires3/4/6/7; input and output greater than1,048,576 bytes; aggregate visited records8193 split across root/bar/wrapper. Read a valid maximum field536870911. Exactly8192 records and exactly1,048,576 bytes remain accepted when both input and proposed output are valid. Missing-path creation from8189 opaque records yields8192 visited output records and passes; from8190 records would yield8193 and rejects before publication. Include missing wrapper/scalar insertion at their corresponding aggregate limits. Assert the specified error prefix and input immutability.
- [ ] Repeat the focused command; require GREEN. Request an independent focused review of literal preservation, budget scope and unchecked Number conversions. Freeze owned hashes and send root RED/GREEN evidence.

### Task 2: Bounded lossless legacy stylesheet adapter

**Files:** Create `src/interchange/stylesheet-legacy.ts`, `src/interchange/stylesheet-legacy.test.ts`.

**Interfaces:** Produce `readLegacyStylesheetSymbol(bytes:Uint8Array):boolean|null` and `writeLegacyStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array`. Consume no GPSS/provenance implementation. Exact key bytes and framing are in the spec.

- [ ] Write `reads_and_patches_literal_legacy_boolean`: zero-record header → null; authored target record type0 values0/1 → false/true; replacement changes only its value byte; append to zero/multiple records updates big-endian count exactly; already-equal output is detached and byte-equal.
- [ ] Run `npx vitest run src/interchange/stylesheet-legacy.test.ts`; require RED.
- [ ] Implement a raw-span record scanner for types **0–7**, without decoding unrelated content or importing alphaTab internals. Retain unrelated key/value encodings and ordering exactly; append only the demonstrated missing key.
- [ ] Write `preserves_every_unrelated_legacy_type`: independent records for bool/int32/float/string/point/size/rectangle/color, a zero-length string, UTF-8 key bytes and duplicate unrelated keys. Compare exact bytes outside target and unchanged source.
- [ ] Write table-driven `rejects_unsupported_legacy_framing`: negative count, count8193, truncated header/key/type/value for each type, type8, negative string length, string length beyond buffer, trailing bytes, duplicate target, target nonbool, bool2, input/output beyond one MiB. Reading8192 unrelated records passes; appending a missing target to them rejects because output would have8193 records. Appending to8191 yields8192 and passes. Replacement/equal writes at8192 and the one-MiB boundary pass only when the output stays within bounds. Require the spec error prefix and no mutation.
- [ ] Repeat the focused command; require GREEN. Obtain independent focused review and hand root hashes/evidence. Task1 and Task2 may execute concurrently under separate ownership.

### Task 3: Intent provenance and archive policy

**Files:** Create `src/editor/time-signature-source.ts`, `time-signature-source.test.ts`, `src/interchange/stylesheet.ts`, `stylesheet.test.ts`.

**Interfaces:** Consume Tasks1/2's four functions. Produce `initializeTimeSignatureSource(score:model.Score,imported:boolean|null):void`, `setTimeSignatureIntent(master:model.MasterBar,value:boolean):void`, `copyMasterTimeSignatureSource(source:model.MasterBar,destination:model.MasterBar):void`, `copyTimeSignatureSources(source:model.Score,destination:model.Score):void`, `getTimeSignatureExportIntent(score:model.Score):{changed:boolean;value:boolean|null}`, `readStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):void`, and `writeStylesheetTimeSignatures(score:model.Score,entries:Readonly<Record<string,Uint8Array>>):Record<string,Uint8Array>`. `getTimeSignatureExportIntent` returns `{changed:false,value:null}` for unchanged/no eligible intent; representable changes return `{changed:true,value:boolean}`; unsupported changes throw. No persisted or public-model properties.

- [ ] Write `known_global_flag_applies_only_to_eligible_meters`: 4/4,2/2,3/4,6/8 masters; initialize true then false and assert only the first two change. A present GPSS false plus legacy true reads false; present GPSS absent wrapper plus legacy true remains unknown and leaves public values untouched. Legacy is consulted only with the GPSS entry absent; missing both records unknown.
- [ ] Write `inherited_numeric_is_not_explicit_false`: imported null with displayed false gives unchanged/null; `setTimeSignatureIntent(master,false)` on the sole eligible bar gives changed/false; known imported false plus explicit false stays unchanged. Imported true, false edit, Undo-equivalent baseline replay, and explicit true produce the expected changed/unchanged results. No-source new models use explicit actual booleans.
- [ ] Run `npx vitest run src/editor/time-signature-source.test.ts src/interchange/stylesheet.test.ts`; require meaningful RED.
- [ ] Implement WeakMap baselines/explicit markers and pure uniformity resolution. Detect actual public-model boolean changes relative to captured display baseline; do not erase an explicit equal-false marker. Import initialization validates the chosen active byte record before applying projection. No marker changes during resolution or failed writes.
- [ ] Write `markers_follow_master_objects`: aligned clone deep-copies metadata, then remove first master/reorder/excerpt retain each marker on its own master; context copies preserve inherited/explicit baseline; unmarked new master is explicit. A copied imported-true context followed by numeric-default false is detected as changed. Changing destination markers does not change source markers.
- [ ] Write `unchanged_export_preserves_all_source_styles` at the pure adapter/already-built-score boundary: root true with conflicting explicit false view, root absent option with malformed view, and malformed ignored legacy behind valid current GPSS. After unrelated score edits, returned map/style bytes remain equal, no view/legacy parsing is required, and source arrays/map are unchanged. A known-value command returning to baseline also takes this path. The malformed inactive-legacy case does not claim alphaTab can open that archive; Task4 separately pins the actual public load boundary.
- [ ] Write `changed_export_is_uniform_or_atomic_error`: true/false eligible mixture uses exact mixed error; an explicit false with unresolved neighboring eligible bars uses exact inherited error; noneligible bars are ignored; no eligible bars preserve every style byte. Uniform true/false patch current and legacy; with current entry absent it stays absent and only legacy changes. Missing generated legacy member is rejected on the changed path.
- [ ] Write `changed_view_guard_preserves_valid_original_overrides`: untouched conflicting view exports; changed conflicting recognized `scoreview1.gpss` rejects with path; absent/equal view options remain byte-exact; malformed recognized view rejects only changed projection; `scoreview0.gpss`, nested/unrelated names remain opaque. Original full-score/legacy/view/unknown record arrays remain unchanged on every failure.
- [ ] Repeat focused tests; require GREEN. Independent review verifies source absence is not coerced to false, unchanged export is not newly blocked, and cache transfers are aligned before topology changes. Freeze owned hashes before root integration.

### Task 4: Existing replay, merge and export integration

**Files:** Modify `src/interchange/gp.ts`, `src/editor/bar-gestures.ts`, `src/editor/notation.ts`, `src/editor/measures.ts`, `src/engine.ts`, `src/export/ExportDialog.tsx`; create `src/interchange/stylesheet-replay.test.ts`; extend existing relevant tests in `src/interchange/gp.test.ts`, `src/editor/bar-gestures.test.ts`, `src/editor/measures.test.ts`, `src/export/selection.test.ts`, `src/export/useExportCoordinator.test.ts`, `src/controller.test.ts` and `src/export/ExportDialog.test.tsx` only where the new behavior needs coverage.

**Interfaces:** Consume Task3's frozen functions. Existing `loadInterchangeScore`, `exportGpInterchange`, `copyGpInterchangeSource`, finite command shapes and bridge methods keep their signatures. Root owns all edits in this task.

- [ ] Write public-adapter REDs from independently authored ZIP entries: public GP score with4/4,2/2,3/4 plus literal current-GPSS true/false/absent option, opposing legacy flag, original view overrides and opaque archive sentinel. Assert true→`[true,true,false]`, false→allnumeric, absent option does not consult legacy for this flag, and unchanged exported style members remain byte-exact on the existing no-XML path. Add `malformed_inactive_legacy_remains_public_loader_limit`: valid current GPSS with a deterministically invalid/truncated legacy record still fails outer public load atomically, leaves the existing document/source bytes unchanged and is not interpreted as native fallback. Do not strip legacy entries or claim this slice decodes their other style fields.
- [ ] Write replay REDs: immutable native file source plus complete `setMasterBarGestures` false after unknown; two eligible bars with only one explicit false reject; both explicit false export; known true edit to false creates mixed failure, Undo restores exact original style bytes, Redo fails again; serialize/reopen native project recreates outcomes. Rejected commands leave both model and intent unchanged. Include `setMeasureSettings`' existing clear behavior.
- [ ] Run `npx vitest run src/interchange/gp.test.ts src/interchange/stylesheet-replay.test.ts`; confirm RED.
- [ ] In `gp.ts`, read the active symbol adapter after public ZIP load and before publication; retain sourceEntries unchanged. Extend `copyGpInterchangeSource` with `copyTimeSignatureSources` for every caller, including marker-only clones with no archive source. After generated/original/GPIF overlay, call the writer before ZIP output on every relevant path; direct raw output must also be patched when uniform source-free intent needs the legacy key. Preserve existing XML projection, pitched export, empty chord carrier, lyrics, backing and harmony paths.
- [ ] Add `setTimeSignatureIntent` only after successful validation in the two existing authoring paths. Add context metadata copy in `blankMaster` and existing append command without changing their existing model values. Do not add command fields, settings, arbitrary JSON or Rust schema migrations.
- [ ] Write `transform_and_clipboard_intent_survives_replay`: insert before/after inherited and explicit context; delete edited bars; copy/rebuild; selected uniform excerpt from otherwise mixed score; lower/removed tracks; multi-track clipboard master replacement is explicit model intent while single-track phrase paste preserves destination inheritance. Assert baseline origin follows retained masters, native command JSON is unchanged and source bytes are unchanged.
- [ ] Write `adapter_preserves_music_and_source_siblings`: literal standard MIDI note/control events, measure clocks, raw lyrics, harmony/link snapshots and backing bytes match before/after all known-flag projections and GP reopen. Compare all archive members except regenerated GPIF and intentionally changed style members; compare unrelated raw style records separately. Run with both no-XML and existing XML-adapter export paths.
- [ ] Add direct controller and export-coordinator failure tests: mixed/unresolved/view errors reach the existing error surface, no `bridge.exportGp` call occurs, pending/busy state clears and subsequent valid exports still work. Cancel remains existing behavior. Update the export help sentence exactly as specified; test its visible copy without changing dialog flow.
- [ ] Run `npx vitest run src/interchange/stylesheet-replay.test.ts src/interchange/gp.test.ts src/editor/bar-gestures.test.ts src/editor/measures.test.ts src/export/selection.test.ts src/export/useExportCoordinator.test.ts src/controller.test.ts src/export/ExportDialog.test.tsx` and `npm run typecheck`; require GREEN. Request fresh independent root integration review, fix meaningful findings with REDs and obtain scoped acceptance before final verification.
- [ ] Root stages only accepted owned files and commits a cohesive source change. Commit/branch/push strategy stays under the existing root workflow; do not change main or manufacture an approval gate.

### Task 5: Native application and final evidence

**Files:** Create `tests/desktop/parity-stylesheet.mjs` and `docs/validation/2026-10-15-gp8-stylesheet-interchange.md`; preserve all earlier ignored evidence/probes/fixtures. Root only.

**Interfaces:** Use the existing desktop harness and actual Rust/Tauri file bridge. No new diagnostic command or target GP8 execution. New authored fixtures can be built in the ignored parity output directory by the harness without modifying the retained authored true/false inputs.

- [ ] Root runs the complete current frontend/scripts/typecheck and Rust/fmt checks using the established bounded concurrency/toolchain; record exact fresh counts, existing explicit skips and failures. Build the diagnostic Windows app with the existing script after accepted product changes. A passing earlier binary does not verify this head.
- [ ] In the actual app, open authored current-GPSS true containing4/4,2/2,3/4; inspect common and cut glyphs plus numeric3/4, then false numeric output. Keep physical guitar/drum views and existing editor layout intact. Save native project, fully restart the process, exercise Undo/Redo and compare exact edit JSON/source hashes.
- [ ] Export/reopen uniform true and false through direct and dialog paths; read the actual output current/legacy values independently and compare literal MIDI/events/clocks. Verify unrelated imported conflicting view styles pass with identical bytes, while changed conflicting/mixed/unresolved cases show the specified errors and leave the output file absent or unchanged. A valid export after each failure must succeed.
- [ ] Run the retained authored GPSS fixtures read-only as supplemental evidence; verify their hashes and original DLL hashes unchanged. Do not rerun the old Python producer, which overwrites retained evidence/archives. Do not launch/install/re-decompile GP8 merely to repeat static proof.
- [ ] Write final validation with independent review IDs/hashes, public/native/rendered evidence, exact preservation exceptions and remaining limits. Keep parent/default-style reconstruction, alphaTab's dependency on inactive legacy presentation data, arbitrary view relationships, mixed per-bar GP representation and original-GP8 runtime acceptance explicitly open. Do not change historical baseline counts without a separate requirement audit.
- [ ] Root verifies the final diff contains no private scores, original binaries/descriptors, ignored evidence or new dependencies, commits/pushes via its standing authorized workflow and verifies the remote SHA. Keep the complete parity goal active unless every original requirement is independently proven complete.

## Self-review and execution handoff

The file map isolates the two byte parsers from provenance/policy and reserves every existing/shared edit for root. Review Focus items each have explicit regression steps. All signatures and changed/unchanged return states match the spec. No required behavior depends on guessed schema or native runtime execution. The user's existing parallel implementation/no-approval choice remains the execution method; this document is ready for root's independent review and dispatch.
