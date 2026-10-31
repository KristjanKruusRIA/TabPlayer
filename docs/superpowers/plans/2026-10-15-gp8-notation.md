# Guitar Pro 8 Beat and Bar Notation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already selected parallel feature workers; root coordinates shared integration.

**Goal:** Add bounded public-model beat/bar gestures with native history, rendered notation, audible targeted crescendos, and proven standard GPIF repairs.

**Architecture:** Root stages one finite local types module, then disjoint gestures and bar workers implement new handlers/panels/tests. An owned GPIF adapter repairs demonstrated stem-inversion and fermata-fraction omissions. Fermatas cover authoring/native persistence first; timing and unknown GP styling remain open.

**Tech Stack:** Rust/Tauri, React/TypeScript, alphaTab1.8.4, fflate0.8.3, DOM XML, Vitest.

**Spec:** [Guitar Pro 8 beat/bar notation design](../specs/2026-10-15-gp8-notation-design.md), supporting [the umbrella design](../specs/2026-10-15-gp8-feature-parity-design.md). Canonical DTO bodies and behavior live only in the subsystem spec; executors read both.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared TypeScript/Rust DTOs and validators, engine/router, App/EditorPanel/ScoreView, model rebuilds, GP adapter integration, selection/export integration, Git, and desktop verification.
- Feature workers edit only assigned new modules, panels, tests, and authored fixtures. Do not edit installed alphaTab or first-delivery feature files.
- DTO indices are zero-based; measure labels are one-based. Validate complete payloads and destinations before mutation. Undo/redo uses deterministic history replay.
- Standard GPIF fields must be demonstrated by public readers/writers or authored GP8 fixtures; no invented extension elements, IDs, or private properties.
- Model retention, native replay, rendered notation, musical output, and target-runtime GP8 compatibility require separate evidence.
- Fermatas cover authoring, public-model retention, proven standard GPIF fields, and native persistence first. Playback timing and Fermata.length units remain open.
- Nested tuplets N06, common/cut-time GP styling, arbitrary/final per-staff bar-line GP styling, and dedicated slap/pop/golpe sound remain separate open capabilities.

## Review Focus

1. Clearing fermatas removes both the master map and derived beat references; finish/replay cannot resurrect them — Task2.
2. Range edits retain neighboring beats/voices/pitches/links across rests and unequal rhythms — Task2.
3. Simile source playback, pair clearing, mismatched meters, and selected export retain musical meaning — Tasks3/5.
4. Finite enum/nullable validation is atomic and identical in frontend/native schema — Tasks1/3/5.
5. Flags may be omitted by export or ignored by playback; inspect actual XML/MIDI and preserve open gaps — Tasks2/4/5.

---

## File map and parallel ownership

- Root creates `src/editor/gestures-types.ts` once from the spec before dispatch. Both workers consume it unchanged. Root alone registers shared TypeScript/Rust schemas.
- Gestures worker creates `src/editor/gestures.ts`, `gestures.test.ts`, `GesturePanel.tsx`, `GesturePanel.test.tsx`, `src/interchange/notation.ts`, `notation.test.ts`, and authored fixtures under `src/interchange/fixtures`. Owns Tasks1/2/4.
- Bar worker creates `src/editor/bar-gestures.ts`, `bar-gestures.test.ts`, `BarGesturePanel.tsx`, `BarGesturePanel.test.tsx`. Owns Task3 without editing gestures worker files.
- Root owns Task5: `src/editor/gestures-replay.test.ts`, native/shared schema fixtures, router/UI/GP adapter/XML projections/selection/timer integration, desktop verification, review, and Git.
- Feature workers do not modify existing techniques/notation/non-tab/song files, start apps, run full suites, or commit. Gestures and bar work is independent after the root types module exists.

### Task 1: Selected-beat gestures and stem/beam controls

**Files:** Create `src/editor/gestures.ts`, `gestures.test.ts`, `GesturePanel.tsx`, `GesturePanel.test.tsx`; consume root-staged gestures-types.ts.

**Interfaces:** Produce `applyGestureEdit(score:model.Score,command:GestureCommand):boolean` and `GesturePanel(props:GesturePanelProps):React.JSX.Element`. Consume exact GestureCommand/GesturePatch/props from the spec. Use public fields; model.BeamDirection is not a runtime enum export.

- [ ] Write `sets_and_clears_every_finite_beat_gesture`: table-drive every flag/enum/barre/stem/beaming value, including all **18** nonzero rasgueados and clear values. Preserve unrelated sentinels. Assert up/down map to preferred0/1, inverted clears preference, auto clears both.
- [ ] Write `invalid_patch_is_atomic_and_staff_rules_are_explicit`: a valid slap preceding an invalid enum leaves complete score JSON unchanged; reject unknown/empty patches, invalid/nonstringed guitar gestures, bad barre and nonchord rasgueado. Permit clearing after staff-type change and golpe on a rest. Omitted barre and explicit null must differ.
- [ ] Write `gesture_panel_dispatches_exact_named_choices`: read imported values, all18 named rasgueado options, busy/reset behavior, one complete DTO per Apply.
- [ ] Run `npx vitest run src/editor/gestures.test.ts src/editor/GesturePanel.test.tsx`; require meaningful RED.
- [ ] Implement complete prevalidation, direct known public assignments, and existing-style controls from the spec. Do not add sound implementations or unknown GP fields.
- [ ] Repeat focused tests; require GREEN. Report owned files/RED-GREEN evidence to root.

### Task 2: Ottava ranges, audible dynamics, and fermata authoring

**Files:** Extend owned gestures modules/panel/tests only.

**Interfaces:** Implement remaining GestureCommand variants with inclusive same-voice ranges and authoritative MasterBar.fermata. Stored Length is finite positive data; no seconds/multiplier semantics or playback conversion is introduced.

- [ ] Write `ottava_range_is_bounded_and_pitch_preserving`: bar0/beat3 through bar1/beat1 changes exactly three beats; other voice/neighbors retain sentinels. For all ottava0..4, compare Note.realValue and literal SMF keys with control. Reject reversed/cross-track/staff/voice/missing endpoints atomically.
- [ ] Write `crescendo_has_exact_target_and_audible_progression`: four P->FF quarters yield enums **[2,3,5,6]** and independently decoded SMF velocities **[47,63,95,111]**; reverse gives **[111,95,63,47]**. Unequal durations use onset progress; rests carry hairpin without an audible step; outside notes unchanged. Clear hairpin retains dynamics. Reject invalid/wrong-direction targets and fewer than two attacks. Inspect standard Beat Dynamic/Hairpin XML.
- [ ] Write `fermata_is_global_and_clear_cannot_resurrect`: set from track1 at tick960, assert one authoritative map entry plus aligned beat references; clear then rebuild and require both absent. Retain offsets **0,87,960**, types, and positive lengths through public JSON. Invalid type/nonfinite/nonpositive length is atomic.
- [ ] Run focused gestures tests; demonstrate RED from missing behavior. The same public generator must not serve as the independent SMF decoder.
- [ ] Implement collected ranges, the spec's exact stepped-dynamic policy, and authoritative fermata updates. Preserve first-delivery per-note dynamics rebuild behavior.
- [ ] Repeat focused tests; require GREEN. Record the known identical-with-control fermata MIDI output as an open playback defect, not a passing timing assertion. Do not introduce audio/fermatas.ts, a hold DTO, or guessed units in this delivery.

### Task 3: Bar gestures, feel, and sounding similes

**Files:** Create `src/editor/bar-gestures.ts`, `bar-gestures.test.ts`, `BarGesturePanel.tsx`, `BarGesturePanel.test.tsx`; consume root-staged types unchanged.

**Interfaces:** Produce `applyBarGestureEdit(score:model.Score,command:BarGestureCommand):boolean` and `BarGesturePanel(props:BarGesturePanelProps):React.JSX.Element`. Consume exact command/props and public model. Do not edit gestures worker files.

- [ ] Write `single_and_double_simile_replay_source_music`: authored single at bar1 gives groups **[40,41,42,43]/[40,41,42,43]**; double bars2/3 plays bars0/1. Decode literal SMF. Clearing either double half atomically reveals original destination notes; notes are never deleted by the symbol.
- [ ] Write `simile_rejects_orphans_and_wrong_meter_atomically`: first-bar single, missing double predecessor/follower, source/destination duration mismatch, and replacing an existing pair member follow spec pair semantics. Compare full before/after snapshots.
- [ ] Write `master_and_clef_gestures_validate_before_assignment`: all octave clefs/Regular survive JSON/proven GPIF; rebuilt7/8 **[2,2,3]** unit8 groups survive GP export. Invalid sum/enum must not change doubleBar/feel. commonTime true accepts **4/4 or2/2**, rejects3/4; null beaming removes explicit override with public inheritance.
- [ ] Write `rhythmic_feels_have_literal_onsets`: four eighths Triplet8th **[0,640,960,1600]**, Dotted8th **[0,720,960,1680]**, Scottish8th **[0,240,960,1200]**, clear **[0,480,960,1440]**; sixteenth cases halve these offsets.
- [ ] Write `bar_panel_dispatches_named_finite_commands`: selected readback, one-based labels, named feel/clef options, parsed groups, busy/reset, exact DTOs.
- [ ] Run `npx vitest run src/editor/bar-gestures.test.ts src/editor/BarGesturePanel.test.tsx`; confirm RED.
- [ ] Implement full finite validation/public assignments and atomic pair behavior from the spec. Native common/cut display is not GP styling proof.
- [ ] Repeat focused tests; require GREEN. Handoff cases requiring root visual/selection checks.

### Task 4: Proven standard GPIF repairs and musical stream regressions

**Files:** Create `src/interchange/notation.ts`, `notation.test.ts`, `fixtures/notation-authored.gpif`; extend owned gestures tests where needed.

**Interfaces:** Produce `writeGpifNotation(score:model.Score,doc:Document):void`. Consume Beat.id and authoritative master fermatas. Root calls it within one existing XML/ZIP rewrite; worker does not edit gp.ts/xml.ts.

- [ ] Write `public_writer_loses_inversion_and_fractional_fermata`: literal existing-export XML lacks standard inversion property and offset87 fermata. Demonstrate meaningful RED before adding the adapter.
- [ ] Write `owned_writer_preserves_proven_standard_fields`: standard Beat XProperty **1124204545/Int1** and fermata offsets **0/1,29/320,1/1** for ticks **0,87,960** with exact types/lengths. Independently parse XML then reimport values. Assert false removes only that known property, no duplicate entries, and unchanged source objects/bytes/unrelated sibling archive content.
- [ ] Write `fade_and_rasgueado_survive_command_and_rebuild`: decode CC7 FadeIn **0->120 ending768**, FadeOut **120->0 at768**, VolumeSwell **0 at864**, retaining existing mix automation. Ii quarter chord yields **(0,40),(60,45),(120,50),(480,50),(540,45),(600,40)**. All18 patterns emit finite sorted events and known standard pattern strings.
- [ ] Run `npx vitest run src/interchange/notation.test.ts src/editor/gestures.test.ts`; confirm RED.
- [ ] Implement only standard inversion and exact authoritative fermata subtree repairs. Preserve all retained public fields from the spec's evidence table and current DSP/percussion patches. Do not invent common/cut/final-line styling or dedicated technique sound.
- [ ] Repeat focused tests; require GREEN. Report proven repairs separately from remaining public losses.

### Task 5: Root schemas, replay, selection, timers, and desktop checks

**Files:** Root modifies shared DTOs/validators/router/App/EditorPanel/GP adapter/XML projections/selection/timer preparation; creates `src/editor/gestures-replay.test.ts`, native/shared fixture cases, and timer integration cases.

**Interfaces:** Consume Tasks1–4 unchanged. Root stages local types before dispatch and preserves first-delivery note-index/dynamics/DSP/percussion behavior. Only root touches shared integration files.

- [ ] Before parallel dispatch, stage gestures-types.ts from the canonical spec. Write frontend/native RED cases for every command/enum bound, uint32 target bounds, exact nested shape, unknown/missing fields, omitted/null barre/fermata, and range shape.
- [ ] Write `gesture_native_history_is_deterministic`: blank/imported preview, native acceptance, JSON save/reopen, undo prefix/redo, structural rebuild, source immutability for every new variant. Assert per-note dynamics from the first delivery remain intact.
- [ ] Write `selection_exports_sounding_similes_and_boundaries`: nonzero range starts, both simile halves, inversion, fermata at selection edges; preserve links/mix automations/current source archive siblings. GP/MIDI sounding source must match native/public playback.
- [ ] Write `timer_uses_first_performed_time_after_tempo_and_repeat`: generate on detached current model, transfer timers by Beat.id to displayed model, assert note/rest first-pass elapsed values. Null/zero stale caches are not success; fermata-adjusted time remains open with fermata playback.
- [ ] Route commands, compose panels, integrate writeGpifNotation/projections in the existing single rewrite, and wire current timer preparation. Retain old setMeasureSettings resetting commonTime behavior for replay compatibility.
- [ ] Run six owned notation test files plus root replay/native schema/history cases and `npm run typecheck`; use actual existing Cargo test names. After focused gates pass, root runs existing broader frontend/native checks.
- [ ] Root visually verifies glyph spans, octave clefs/regions,7/8 groups, stem/secondary beam breaks, similes, fermata shapes/stored values, audible target crescendo, fade/rasgueado streams, and timers; exercise undo/redo/native reopen and PDF/MIDI/GP exports/GP8 open. Record field/render/musical evidence separately.
- [ ] Update only individually evidenced matrix rows. Keep N18 timing/Length units, unknown GP styling, nested tupletsN06, and distinct slap/pop/golpe sound open. Future timing/sound work needs its own bounded evidence-backed delivery. Root owns review/Git handoff.

## Self-review

- Spec coverage: selected fields/stem/beam → Task1; ranges/crescendo/fermata storage → Task2; bars/feel/similes → Task3; proven GPIF/musical streams → Task4; schemas/replay/selection/timers/render → Task5.
- Each Review Focus condition has named RED assertions and an owner.
- Type names/signatures match the spec; parallel workers have no shared writable files after root stages types.
- Fermata timing/units and GP styling unknowns remain open; no speculative conversion/private field is introduced.
- Adoption created documentation only. No product edit, app session, test execution, approval flow, or Git operation was performed.
