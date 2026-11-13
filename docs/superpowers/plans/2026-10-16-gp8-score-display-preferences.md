# Per-document score display preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve score layout and zoom policy through existing per-document view repair, bridge and native recovery while retaining old sessions exactly.

**Architecture:** Add one optional view object and narrow shared TS resolver, mirrored by strict native enums. This independently testable contract slice implements the View contract section of the architectural spec; physical renderer/UI work belongs to a subsequent plan after the throwaway feasibility probe. No controls or renderer changes are included here.

**Tech Stack:** TypeScript, Vitest, Rust1.88, serde, existing workspace/recovery bridge; no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-gp8-score-layouts-design.md`, View contract and modes section. The rest of that spec is not claimed by this contract slice.

## Global constraints

- Authoritative worktree `<checkout>`, feature branch only; root owns Git/publication and serialized native-check slots. All scoped changes are authorized; no further approval gate.
- Optional `DocumentViewState.scoreDisplay` has exactly `{layout,zoomMode}`. Missing/null means absence in Rust; frontend repair drops invalid/null objects. Untouched old views and initialDocumentView retain their exact omitted-field shape.
- Layout values: `verticalPage`, `horizontalPage`, `grid`, `parchment`, `verticalScreen`, `horizontalScreen`. Zoom policy values: `manual`, `fitWidth`, `fitPage`. Missing preference resolves to `parchment/manual`; frontend resolves endless fitPage to fitWidth. Native accepts structurally valid pairs; no transport behavior.
- Numeric manual zoom remains finite fractional25–300%, independent of fit policy. No document/settings/edit/IPC/audio schema, App/ScoreView/UI, dependency, export or renderer changes.
- No whole suite/build/app/browser/device/Play/audio/capture. Preserve old artifacts/private data and closed visual cycles. Codegraph unavailable; narrowly scoped source reads are fallback.

## Review focus

- Old absent-field sessions must deserialize and reserialize without gaining null/default keys (Task1).
- Extra keys, arrays, null, unknown enum values and partially valid preference objects must not enter frontend view state (Task1).
- All18 valid native pairs must roundtrip; only frontend applicability normalizes the three endless fitPage pairs (Task1).
- Repair/activation must retain manual137.5%, layout and policy without modifying project history/dirty/revision or issuing audio work (Task1).
- Existing strict native envelope rejection must remain intact; no permissive flatten/map workaround (Task1).

### Task 1: Compatible frontend/native view contract

**Files:** Create `src/engraving/screen-view.ts`, `src/engraving/screen-view.test.ts`. Modify `src/workspace/types.ts`, `src/workspace/view-state.ts`, `src/workspace/view-state.test.ts`, `src/workspace/WorkspaceController.test.ts`, `src/workspace/session-bridge.test.ts`, `src-tauri/src/recovery.rs`. Only necessary exhaustive Rust view initializers elsewhere may gain `score_display:None`; report them, no adjacent changes.

**Interfaces:** Export `ScoreLayoutMode`, `ScoreZoomMode`, `ScoreDisplayPreferences` from `screen-view.ts`; interface exactly `{layout:ScoreLayoutMode;zoomMode:ScoreZoomMode}`. Export `isPhysicalPageLayout(layout:ScoreLayoutMode):boolean`, `repairScoreDisplay(value:unknown):ScoreDisplayPreferences|undefined`, `resolveScoreDisplay(value:unknown):ScoreDisplayPreferences`. Resolver returns a fresh repaired preference or fresh `{layout:'parchment',zoomMode:'manual'}`. Existing view/bridge APIs retain their signatures.

- [x] Append a frontend behavioral regression before introducing the helper module: repair an existing initial view augmented with `{scoreDisplay:{layout:'grid',zoomMode:'fitPage'},zoom:137.5}` and assert the exact object is retained. Run `npx vitest run src/workspace/view-state.test.ts --maxWorkers=2 --reporter=dot`; require failure specifically because scoreDisplay is dropped.
- [x] Add native `score_display_*` tests in recovery.rs using serialized existing default view JSON augmented with scoreDisplay, without referring to not-yet-existing fields/types. Require exact roundtrip of grid/fitPage and old omission; run the allocated filtered Cargo command and retain the initial unknown-field rejection before adding production schema.
- [x] Implement shared unions/preferences and the three helper signatures. Validate exactly two own object keys, both enum choices; malformed input returns undefined. Only valid endless fitPage normalizes to fitWidth. Add optional typed scoreDisplay to DocumentViewState and conditionally retain repaired supplied values; leave initialDocumentView unchanged.
- [x] Add matching Rust `ScoreLayoutMode`, `ScoreZoomMode`, `ScoreDisplayPreferences` with camelCase serde names, deny_unknown_fields on the object, and `#[serde(default,skip_serializing_if="Option::is_none")] score_display:Option<ScoreDisplayPreferences>` on native DocumentViewState. Add None to its Default. Preserve existing strict envelopes; no custom transport or behavior.
- [x] In screen-view.test.ts pin all6layouts×3policies, physical-mode predicate, defaultfreshness, normalization and invalid objects including null, arrays, missing fields, extra keys, unknown case/numbers. In view-state tests pin old omission, malformed drop, manual25/137.5/300 retention and endless-policy repair.
- [x] Extend existing WorkspaceController/session bridge tests to retain grid/fitPage/manual137.5 across activation and forwarded view writes without modifying project/history/revision/dirty state; do not invent a native audio harness. Add native all18pair roundtrips, absent/null omission, unknown/extra/numeric/missing-field rejection and unchanged old strict-view fixtures.
- [x] Run `npx vitest run src/engraving/screen-view.test.ts src/workspace/view-state.test.ts src/workspace/WorkspaceController.test.ts src/workspace/session-bridge.test.ts --maxWorkers=2 --reporter=dot` and `npm run typecheck`. Native slot: `cargo test --manifest-path src-tauri/Cargo.toml --locked score_display -- --nocapture`, then `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`; require focused GREEN without editing unrelated code for formatting. Retain RED/GREEN commands, hashes and limitations in the exact task report supplied by root. No commits by producer.

### Task 2: Independent review and root delivery

**Files:** Released Task1 paths; new `docs/validation/2026-10-16-gp8-score-display-preferences.md` and root's ledger/receipts. This plan's checkboxes may reflect completed work.

**Interfaces:** Review the frozen Task1 patch and report; root produces source-bound focused evidence. No D01/D02 promotion from a preference schema.

- [x] Fresh independent reviewer checks the optional shape, strict native contract, exact legacy omission, all enum/applicability behavior, source/manual preservation and meaningful REDs. Read one immutable packet, audit exact tests/source; no source edits or broad check repetition.
- [x] Root verifies frozen source hashes, runs joined focused checks appropriate to the released delta, and records native producer results accurately. Broaden only for an observed risk/failure; a schema slice does not require a desktop build or image round.
- [x] Root publishes concise validation and scoped commit/push under existing authorization. Mark only this contract plan complete; keep architectural UI/rendering work and broad parity rows open. Preserve probe and generated assets as their own evidence, not runtime acceptance.

## Bounded closure — 2026-10-16

Tasks1–2 complete for the preference contract only. Accepted source6a634c4; producer130frontend/7native/types0/fmt0, fresh independent review15ECDB40 PASS, root130frontend/types0. ValidationB0ECC94A committed8db5c4f699614f9a1f3d269eb21dcc5a459f0d1a, pushed and remote feature verified; released main7fc41c7 unchanged. Native results precede only one new-test whitespace wrap as disclosed. No UI/rendering/desktop/physical-audio/platform/shipping/full-parity acceptance or overlay promotion. Root records the closure commit separately; geometry and UI integration remain active work.
