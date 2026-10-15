# Guitar Pro 8 Practice Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver custom/fixed/progressive practice speed, metronome settings and sample-scheduled count-in with independent timing and PCM evidence.

**Architecture:** Root stages the exact wire contracts, then a native scalar-primitives worker and a frontend panel worker run independently. Root integrates those modules into the existing callback/renderer and acknowledged controller, preserving authored score time, source bytes and ephemeral settings; fresh review follows meaningful scoped checks.

**Tech Stack:** Existing alphaTab1.8.4, React/TypeScript, Rust1.88/Tauri, CPAL, Vitest and Rust tests; no dependencies added.

**Spec:** [2026-10-15-gp8-practice-design.md](../specs/2026-10-15-gp8-practice-design.md)

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**; practice settings never enter EditCommand, history, GPIF, MIDI or score JSON.
- Use alphaTab **1.8.4**, fflate **0.8.3**, Rust **1.88** and the existing React/TypeScript/Tauri audio stack; no dependency changes.
- The native output callback is the only transport clock; no browser timer, Web Audio clock or second cursor clock schedules playback.
- Root owns shared contracts, plan/renderer/device/runtime/controller integration, Transport/App/export integration, Git, apps/builds and acceptance. Workers edit only assigned new modules and tests.
- Preserve source/archive/backing bytes, authored tempo maps, existing audio behavior and the approved slate/cream/lime layout; no adjacent refactoring.
- Validate complete settings before mutation/enqueue. Retain generation guards, callback epochs, coherent status snapshots and allocation-free live rendering/seek/loop transitions.
- Wire positions are zero-based; user measure/beat labels are one-based. Practice loops stay independent of editing selections.
- Model retention, native replay, notation, actual PCM and original GP8 runtime compatibility require separate evidence; full parity remains open.

## Review Focus

1. A count or loop ending inside a callback buffer must use the exact remaining slots, including a fixed-tempo loop crossing source tempo changes — Tasks4/5.
2. Pause/device recreation during a count must preserve sub-beat progress without duplicate pulses; a fault must recover paused — Tasks2/5.
3. Muted/embedded/new backing and10%/300% stretching must obey the fixed guard and keep measured transients/pitch aligned — Tasks4/6/8.
4. Lagging acknowledgements, malformed nested settings and New/Open of identical bytes must not lose settings or affect another generation — Tasks1/3/6.
5. Practice changes must not alter history, editing selection, original tempo/source bytes or export a false fixed-mode coefficient — Tasks6/7/8.

---

## File ownership and execution order

Root stages `src/audio/practice-types.ts` and the wire declarations/default/validate skeleton in `src-tauri/src/audio/practice.rs`. After staging, native worker exclusively extends practice.rs and creates `src-tauri/tests/audio_practice.rs`; frontend worker creates `src/audio/practice.ts`, `practice.test.ts`, `PracticePanel.tsx`, `PracticePanel.test.tsx`. Root does not edit either worker's files concurrently.

Root owns other shared/audio/export/App files and fixtures. Tasks2/3 can run concurrently after Task1; Tasks4–7 are root integration with scoped tests; Task8 is native acceptance/review. Workers do not operate Git/apps/builds or run full suites. Root makes reviewed, focused commits; no main merge or parity-complete claim from this batch.

### Task 1: Root stages exact IPC and written meter fields

**Files:** Create `src/audio/practice-types.ts`, `src-tauri/src/audio/practice.rs`, `src-tauri/tests/audio_practice_protocol.rs`, `tests/practice-protocol.json`. Modify `src/audio/types.ts`, `src/audio/bridge.ts`, `src/audio/plan.ts`, `src/audio/plan.test.ts`, `src/audio/bridge.test.ts`, `src-tauri/src/audio/mod.rs`, `src-tauri/src/audio/plan.rs`, `src-tauri/src/audio/device.rs`, `src-tauri/src/runtime.rs`, and authored native plan test literals affected by the required fields.

**Interfaces:** Produce the spec wire types verbatim, SetPractice, required status.practice/status.loop, PlaybackState.practicePending/practiceNotice and occurrence meterNumerator/meterDenominator. Re-export PracticeSettings from device.rs; do not extend EditCommand or tests/protocol.json. Root owns both staged type files until handoff.

- [ ] Write shared valid fixture settings for relative.1/1.23/3, fixed10/100.5/300, progressive.5→1 step.2 repeats2, volume0, bars0/16, equal trainer endpoints. Add invalid missing/extra nested fields, booleans as null/string, fractional/negative repetitions/bars, ratio.099/3.001, BPM9.9/300.1, step0/2.901, reversed end, repeats0/101, bars17 and volume1.01. Native protocol tests deserialize and validate each fixture; Task3 consumes this same fixture to establish frontend/native agreement. Test nonfinite fields separately in each language because JSON cannot express them.
- [ ] Write `meter_fields_keep_written_pickup_and_rare_denominators`: generated pickup keeps full written numerator despite shorter clickTicks; imported3/8,5/128 and33/256 emit exact fields; repeated occurrences retain the same written meter. Invalid0numerator/denominator3 reject without accepting an arbitrary32cap. Preserve initial-grace shift assertions.
- [ ] Extend bridge.test.ts to assert the complete SetPractice object reaches audio_command unchanged through the ordered queue; it must not become a document edit. Run `npx vitest run src/audio/plan.test.ts src/audio/bridge.test.ts` and `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test audio_practice_protocol --test audio_plan`. Capture meaningful RED for missing protocol/meter behavior; frontend semantic validation is Task3's independent deliverable.
- [ ] Stage exact contracts/defaults and plan validation/emission. Native settings wire objects are Copy/Serde with nested deny_unknown_fields; repetitions u32/bars u8; native semantic validate returns static errors. Keep the public controller/export callers compiling while staged integration proceeds; any temporary native adapters are removed by Task5.
- [ ] Update existing authored plan literals to provide actual meter values; do not add guessed defaults in the production validator or modify private files. Update TS native status test builders centrally in their local test files.
- [ ] Repeat scoped tests; require GREEN. Root records the staged interfaces and transfers exclusive ownership of practice.rs to Task2 and new frontend modules to Task3. Commit reviewed contract work using only explicit task paths.

### Task 2: Native worker builds pure count/click/trainer primitives

**Files:** Extend `src-tauri/src/audio/practice.rs`; create `src-tauri/tests/audio_practice.rs`.

**Interfaces:** Consume Task1 PracticeSettings/PracticeTempo. Produce the spec's RenderTempo, PulsePosition, CountInSnapshot/CountFrame, `progressive_ratio(&PracticeTempo,u64)->f64`, CountInClock new/next_frame/remaining_wall_seconds/snapshot/from_snapshot and ClickVoice new/trigger/frame. No device/renderer/runtime imports or wall clock.

- [ ] Write `trainer_repeats_per_speed_and_clamps`: start.5,end1,step.2,repetitions2 at completed passes0..8 equals[.5,.5,.7,.7,.9,.9,1,1,1] within1e-12; equal endpoints remain fixed and no intermediate value exceeds end. Validate the same semantic edge cases as the staged fixtures, including fixed with backing.
- [ ] Write `count_uses_exact_absolute_frame_boundaries`:120BPM/48k, one3/8bar yields pulses0/12,000/24,000 and exactly36,000count samples; finished call consumes no next slot. Two4/4bars=192,000samples;5/128=3,750;33/256=12,375. Bars0 immediately finishes. Pin remaining count before/on/after pulse boundaries.
- [ ] Write `count_rounding_pause_and_rate_restore`:100.5BPM at44.1k has <=1frame cumulative error versus direct `round(index*60/100.5*4/denominator*44100)` arithmetic; no calls during pause changes no snapshot. Snapshot a fractional pulse at48k, restore44.1k; remaining wall duration differs by <=1/44100seconds and emitted pulse is not replayed. Reject invalid rate, u32pulse/u64frame overflow and sub-one-frame period before changing an existing clock.
- [ ] Write `click_volume_and_visual_silence`: volume0 gives exact-zero samples; isolated un-limited energy at.4 is4x.2 within1e-5 relative tolerance. Independent frequency estimate distinguishes2400/1800Hz, and50ms click stops; retrigger replaces the prior age. Use a test allocator guard around warmed scalar next_frame/click calls and snapshot restoration.
- [ ] Run `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test audio_practice`; capture RED. Implement only these pure primitives, absolute-frame count scheduling and existing oscillator shape; repeat to GREEN. Handoff owned file list and evidence. Worker does not edit shared files or commit.

### Task 3: Frontend worker builds validated complete drafts and panel

**Files:** Create `src/audio/practice.ts`, `practice.test.ts`, `PracticePanel.tsx`, `PracticePanel.test.tsx`.

**Interfaces:** Consume staged practice-types.ts. Produce spec `validatePractice(settings,hasBacking):void`, `practiceForBacking(...):{settings,notice}`, PracticePanelProps and PracticePanel. Exact props use settings/busy/hasBacking/onChange; parent uses a documentEpoch key to reset the panel on explicit New/Open.

- [ ] Write `validates_exact_shapes_and_preserves_inputs`: consume tests/practice-protocol.json; all shared valid bounds pass and invalid/unknown nested shapes throw in agreement with native protocol results. Add local NaN/infinity cases; before/after deep snapshots match. With backing, fixed fails with the spec error, even if UI draft says metronome off. `practiceForBacking` returns detached settings, changes only fixed tempo to relative1 and exact notice; other modes/fields remain unchanged with notice null.
- [ ] Write `panel_applies_one_complete_detached_draft`: edit relative123/10/300, fixed100.5, trainer50→100/increment20/repetitions2; Apply emits exact wire ratios and one command. Invalid incomplete numeric drafts emit nothing. Labels show Repetitions per speed and percentage-point increment. Mode changes preserve metronome/count fields.
- [ ] Write `rapid_volume_visual_edits_do_not_overwrite`: volume0 then visual on before Apply yields enabledtrue/volume0/visualtrue together; every draft change emits0commands and Apply emits1. Rerender with unrelated playback tick/unchanged accepted settings does not erase drafts; changed accepted settings does reset; explicit key remount resets. Busy disables Apply, and fixed mode with backing is disabled with a reason.
- [ ] Run `npx vitest run src/audio/practice.test.ts src/audio/PracticePanel.test.tsx`; capture RED. Implement exact validation and an existing-style disclosure/fieldset with Apply practice settings; no controller, App, stylesheet or native edits. Repeat to GREEN; report owned files and evidence for root review.

### Task 4: Root integrates renderer rate policy and measured pulses

**Files:** Modify `src-tauri/src/audio/renderer.rs`, `src-tauri/tests/audio_render.rs`, `src-tauri/tests/audio_backing.rs`, `src-tauri/src/export/audio.rs`; use accepted Task2 primitives.

**Interfaces:** Produce the renderer APIs in the spec and RenderStatus pulse_count/last_pulse. Keep set_speed/set_metronome adapters for existing offline renderers, preserve stem_count ordering and existing scratch allocation.

- [ ] Write `relative_10_123_300_keeps_attack_clock_and_pitch`: independent source120BPM quarters at48k have spacing240,000 / (24,000/1.23) /8,000frames within2frames. Independently estimate440Hz A4 for recorded and GM voices with existing oracle tolerances. Repeat key boundary checks at44.1k, with authored backing tone/transients at.1/1.23/3; same score tick maps to same source pitch and anchor.
- [ ] Write `fixed_90_ignores_source_120_then_60`: two4/4bars, source120then60,8quarters total. Fixed90 produces onsets32,000frames apart and end256,000frames at48k, native tick7680 within one sample movement and nominal seconds6. Original plan tempos and notes remain byte-for-byte serialized equal.
- [ ] Write `fixed_output_budget_crosses_tempo_step`: at ticks2880..4800 and90BPM budget64,000frames, independent of source tempo change; half-consumed budgets use remaining ticks correctly. Native fixed policy with installed backing rejects before changing position/policy.
- [ ] Write `visual_only_pulses_and_gain_preserve_stems`: rest plan, enabledtrue volume0 produces zeroPCM but same pulse_count/positions as.2/.4; pre-limiter energy ratio4. Visual enabled with audible disabled creates pulses and no metronome audio stem. Existing audible-metronome stem ordering/sum still passes at.4. Preserve pickup/mixed-meter/repeat/seek click tests.
- [ ] Run `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test audio_render --test audio_backing`; confirm RED, implement resolved tempo advancement/pulse reports/shared ClickVoice, then require GREEN. Widen Renderer::set_speed and offline schedule validators to.1–3; no count-in export implementation. Run existing no-heap render/seek test after these edits.

### Task 5: Root integrates callback count/trainer/state and device recovery

**Files:** Modify `src-tauri/src/audio/device.rs`, `src-tauri/src/runtime.rs`, `src-tauri/tests/audio_transport.rs`; create `src-tauri/tests/audio_practice_transport.rs`.

**Interfaces:** Consume renderer APIs and pure CountInClock. Produce acknowledged PracticeStatus/PracticeLoop, exact spec transition table and coherent same-epoch runtime snapshot (phase/resume-count, count snapshot, passes, pulse/serial, interrupted-count plus existing tick/seconds/generation). Only CallbackTransport owns passes/published pulse serial. Remove old wire SetSpeed/SetMetronome adapters after callers move to SetPractice.

- [ ] Write `count_finishes_inside_same_output_buffer`: authored3/8at120, onebar count. Detect count clicks at0/12k/24k and first identifiable score attack at36k, <=2sample oscillator-onset tolerance. Render35,999frames then1 then an irregular511block; score tick/seconds are frozen throughout count and progress starts in the first available subsequent slot. No score/backing energy exists before count end.
- [ ] Write `fixed_loop_and_natural_end_are_sample_bounded`: fixed90 loop2880..4800 crosses saved tempo change, wraps once every64kframes with irregular127/511/1024buffers; partial last buffer is filled from the next pass. Natural end pins end tick and silences remaining output slots. Compare PCM attacks, not only completedPasses.
- [ ] Write `trainer_count_uses_next_pass_coefficient`:120BPM4/4onebarloop, start.5/end1/step.2/repeats2, onebar counts before/between. Count+score each192kframes at.5; after two passes next count+score each round(96k/.7)frames within1sample cumulative scheduling tolerance. Pass increments once per wrap; source repeats alone do not increment trainer. No Loop stops naturally at start coefficient.
- [ ] Write `pause_stop_seek_apply_are_atomic`: pause during count freezes snapshot/serial and produces exact silence; resume completes remaining samples without repeated pulse. Stop cancels count/seeks0/clears pulse; repeated Play is idempotent. Seek/loop changes cancel count/reset passes and preserve running intent. Volume-only settings apply during count without restarting frozen duration; tempo change resets trainer but not current count BPM. Rejected/stale settings leave runtime and saved prepared settings identical.
- [ ] Write `device_snapshot_preserves_count_and_epoch`: healthy48k→44.1k switch retains phase/pass/settings/tick and count remaining wall duration within1new sample, with no repeated pulse. Fault mid-count recovers paused and next Play starts full count; fault in score recovers paused at same tick. A retired epoch cannot update pulse/settings/loop. Read status and runtime from one seqlock snapshot, not separately.
- [ ] Extend warmed allocator guard through count generation, between-loop count/trainer wrap and valid volume settings commands. Count validity/overflow is prechecked for each applicable occurrence/tempo off callback; no control-thread resources/locks/allocations enter render transitions.
- [ ] Run `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test audio_practice_transport --test audio_transport`; capture RED. Integrate transitions/settings/publish/recovery and native fixed+backing guards at prepare/command. Repeat scoped tests and accepted primitive/renderer tests to GREEN. Root reviews/commits the focused native integration; no full suite in parallel with workers.

### Task 6: Root integrates acknowledged controller and transport

**Files:** Modify `src/audio/NativePlaybackController.ts`, `NativePlaybackController.test.ts`, `src/Transport.tsx`, `Transport.test.tsx`, `src/App.tsx`, `src/audio/bridge.ts`, `bridge.test.ts`; use Task3 panel/helpers. Extend existing App/score-interaction tests only for practice/selection independence.

**Interfaces:** Produce `setPractice(settings):void`, `exportPracticeRatio():number|null`, pending/notice state and native acknowledged Loop. Keep setSpeed(percent)/setMetronome(volume) convenience methods building complete settings; Transport settings draft uses the new panel. Derive hasBacking from effective backing settings and embedded backing, backed by native status/prepare validation.

- [ ] Write `settings_wait_for_native_ack_and_do_not_lose_drafts`: SetPractice queues once; command promise alone leaves practicePending true and active settings unchanged; matching status clears pending, unrelated status does not. Second pending Apply is rejected/disabled; unchanged Apply is no-op; command rejection clears pending and retains last active settings. New generation clears pending and stale acknowledgements do not change it.
- [ ] Write `count_has_no_cursor_clock_or_sounding_notes`: native count phase with playingtrue keeps alphaTab paused, pushes unchanged nominal seconds, and activeNotes returns[]. Paused count remains empty; paused score retains study notes. Fixed native updates across source tempo steps cannot dispatch relative SetPractice through alphaTab's rate setter. No timer or second synth is introduced.
- [ ] Write `practice_survives_edits_but_resets_same_source_new_open`: accepted custom/fixed/trainer settings retained after musical edit/undo/redo; runtime loop/count/pass clear. New/Open identical source bytes restores defaults and remounts panel drafts. Project snapshot, dirty flag and exportGP bytes remain unchanged solely by practice controls.
- [ ] Write `backing_transition_disables_fixed_before_prepare`: adding imported or embedded backing, even muted, passes relative1 to prepare and displays exact notice; other settings unchanged. Native rejection remains surfaced. Same document backing removal permits later fixed selection without automatically restoring an old fixed setting.
- [ ] Write `transport_loop_and_edit_range_are_independent`: Loop pressed state follows native ack/clear/generation, including failed command; changing selected note/range/track does not send seek or loop. Practice actions do not invoke document edit. Busy/pending disables settings while Pause/Stop still work as appropriate.
- [ ] Run `npx vitest run src/audio/NativePlaybackController.test.ts src/audio/bridge.test.ts src/Transport.test.tsx src/audio/PracticePanel.test.tsx` to RED. Integrate controller/view/panel/Transport/App behavior, including documentEpoch key. Repeat to GREEN and run `npm run typecheck`. Review edited TSX with the React checklist; no layout redesign.

### Task 7: Root makes export coefficient semantics accurate

**Files:** Modify `src/App.tsx`, `src/export/ExportDialog.tsx`, `ExportDialog.test.tsx`, `src/export/useExportCoordinator.ts`, `useExportCoordinator.test.ts`, `src-tauri/src/export/audio.rs` and existing offline schedule tests.

**Interfaces:** ExportDialog adds required `currentSpeedAvailable:boolean`; useExportCoordinator accepts `currentSpeed:number|null`. Controller exportPracticeRatio is relative/progressive current ratio, null in fixed. Preserve existing audio options shape and saved-speed output.

- [ ] Write `fixed_cannot_export_a_false_current_coefficient`: fixed mode disables Current speed coefficient, explains saved speed remains available, resets previously selected current option to saved, and direct coordinator request current+null rejects before any native job. GP/MIDI/PDF and saved-speed export remain unaffected.
- [ ] Write `progressive_exports_one_frozen_current_coefficient`: snapshot current.7 at job launch; subsequent pass speed does not alter job. Label does not promise trainer/count export. Live metronome/count settings do not override explicit export metronome or prepend count.
- [ ] Write independent schedule cases: one source120BPM4/4bar at48k produces960,000frames at.1, round(96,000/1.23) at1.23,32,000at3, before explicit tail. Invalid.099/3.001 reject. Do not compute expected frames through production Timeline/schedule helpers.
- [ ] Run `npx vitest run src/export/ExportDialog.test.tsx src/export/useExportCoordinator.test.ts` and `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --lib export::audio`; confirm RED, integrate nullable availability/accurate labels and wider offline bounds, repeat to GREEN. No offline countdown feature or changed persisted project schema.

### Task 8: Root verifies actual native path and obtains independent review

**Files:** Create `tests/desktop/parity-practice.mjs`; use existing `tests/desktop/harness.mjs` and `src-tauri/examples/capture_loopback.rs`. Write a bounded validation receipt under `docs/validation` only when actually completed; ignored PCM/screenshots/results stay under `.analysis/parity` or `.analysis/desktop-smoke`.

**Interfaces:** Actual native IPC/status and rendered controls only. Root owns app/CDP9223 and resource builds. No private source scores are committed; prefer small authored scores/WAVs.

- [ ] Once integration passes scoped checks, run the full frontend suite/typecheck, full native suite and fmt check serially. Honor explicit benchmark/hardware/bank ignores; report them. Build the existing desktop-test binary with `scripts/build-desktop-test.ps1` under Rust1.88.0. Do not ship diagnostic hooks.
- [ ] Desktop smoke sets relative123, fixed90 across authored120→60, progressive loop and count, visual-only volume0, Pause/Stop and New/Open. Compare actual native ticks/phases/pulse serials and visible notation cursor/selected-track notes. Verify no alphaSynth output sample messages; block external requests using existing harness pattern.
- [ ] Capture bounded Windows WASAPI PCM through the existing helper. Use independent frequency/onset analysis to verify count clicks precede score/backing together, fixed quarters stay32kframes apart at48k across saved tempo change, and A4 pitch is preserved at relative endpoints. Account explicitly for device capture onset latency using first identifiable click/score transients; do not substitute renderedFrames/status for PCM. If hardware cannot exercise a claim, keep it open with headless evidence distinguished.
- [ ] Exercise healthy device reselect and recovery paths; verify no stale epoch pulses/extra synth, project history remains clean, source hashes/backing bytes remain unchanged, and editing-range changes leave transport boundaries alone. Include Windows screenshot of visible countdown/actual BPM/disabled fixed with backing. Close only root-owned test app/process and release CDP9223.
- [ ] Dispatch fresh independent native-clock and frontend/protocol reviewers with the immutable reviewed commit/patch, spec and captured receipts. Verify findings against source, add failing regressions, fix and rerun affected checks; repeat full checks only for material new changes. Do not reuse an implementer as its own reviewer.
- [ ] Record exactly covered P04–P10 behavior, app-choice trainer/pickup semantics, remaining P02/P03/F25 and physical-platform/original-runtime gaps. Root commits/pushes reviewed task files according to existing branch authorization; keep full parity goal active.

## Self-review

Coverage maps every delivered spec contract to a task: wire/meter1, scalar primitives2, drafts3, rate/PCM4, transitions/recovery5, controller/lifetime6, export7 and actual Windows/review8. Producer/consumer names are consistent; runtime snapshot adds missing sub-beat recovery evidence without a second clock. All five Review Focus items have concrete RED cases. Steps specify exact inputs/output arithmetic rather than copying implementations; native/frontend modules can run concurrently only after root stages contracts. No product implementation or test execution is claimed by this plan.
