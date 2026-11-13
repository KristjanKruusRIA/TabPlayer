# Backing pitch and frequency filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add persisted local backing pitch/cents and six frequency filters with unchanged score timing and coherent playback/audio export.
**Architecture:** Extend the existing optional backing settings through strict contracts, voice-owned processing and prepared native installs. Extend the existing Backing sidebar from the generated concept; use existing GP omit flow for unsupported processing metadata.
**Tech Stack:** Rust1.88/Tauri2, React/TypeScript, existing Biquad/granular BackingVoice, Vitest and native Cargo tests; no new dependency.
**Spec:** docs/superpowers/specs/2026-10-16-gp8-backing-processing-design.md

## Global constraints

- Authoritative checkout <checkout>; feat/gp8-parity. All scoped work approved; no approval question. Root owns Git/full checks/build/apps/actual acceptance.
- Preserve P16 clocks, source-frame gates, current-source byte identity, strict unknown-field rejection, owner/revision/generation protections and legacy payloads. No score/global tonality changes or invented GP metadata.
- Numeric local policy: integer semitones[-12,12], integer cents[-100,100], additive with no carry; filter wire values and exact curve/response contract come from spec.
- Actual GenAI backing-pitch-filter-concept.png and provenance were generated and root-inspected before UI. Keep left sidebar placement; no P16 visual freshness recheck.
- Serialize Cargo ownership; native contract producer owns all Rust until release. Disjoint frontend work may proceed. No worker whole suite/build/app/Git. Preserve private/untracked/user files.
- New view verification: one batch, one identified correction set, at most one confirmation. Quiet physical audio window ended; no Play/device capture assumed. Full GP8/platform/shipping acceptance is separate.

## Review focus

- Existing embedded/missing/null/explicit-neutral backing and invalid equivalent edits: strict validation and live redo preserved (Task1/4).
- Pitched interpolation/correlation/transient neighbors across fractional source gates: excluded PCM cannot affect output or tails (Task3).
- Transform-only settings on an old effective plan: audible change with same tick/generation; reference timing remains newly-prepared-only; gain-only stays cheap (Task3/6).
- Numeric own-busy, hidden pending commit, stale source and rejection: one command, no lease leak or stale error (Task4).
- Included GP silently losing a nonneutral transform versus frozen WAV/stem processing: block include in both paths, allow explicit omit, preserve sources (Task5/6).

### Task 1: Freeze and implement strict shared processing contracts

**Files:** root new tests/backing-processing-protocol.json. TS producer: src/edit-types.ts, src/document-settings.ts, new src/audio/backing-processing.ts and focused tests. Native producer: src-tauri/src/settings.rs, new src-tauri/tests/backing_processing_protocol.rs, and only mechanical processing:None additions at existing BackingSettings literals discovered under src-tauri/src and tests. No DSP edits yet.

**Interfaces:** TS BackingFilter/BackingProcessing and optional BackingSettings.processing per spec; defaultBackingProcessing():BackingProcessing, backingProcessingKey(processing:BackingProcessing|null|undefined):string. Rust enum BackingFilter variants None(default), BassEnhance/BassAttenuation/MediumEnhance/MediumAttenuation/HighEnhance/HighAttenuation, camelCase serde. BackingProcessing {semitones:f64,cents:f64,filter:BackingFilter}, Default and validate()->Result<(),String>. BackingSettings.processing:Option<BackingProcessing> default/skipNone.

- [x] Root authors literal protocol with legacy missing/null, all7modes, limits/cancellation/decimal integer spellings, malformed keys/types/modes/fractions/out-of-range; preserve P16 fixtures. Independently inspect fixture expectations before distributing.
- [x] Producers write protocol/direct nonfinite/neutral-normalization tests; run focused RED before implementation. TS valid legacy remains valid; Rust new processing objects initially reject under old strict serde. Helper keys distinguish individual pair but equate missing/null/explicit0/0/none.
- [x] Implement only strict types/defaults/validation/helpers and mechanical native literals. Keep old serialization missing fields and source data unchanged; BackingProcessing is one optional nested object, no schema migration/new IPC.
- [x] Run TS npx vitest run src/audio/backing-processing.test.ts src/document-settings.test.ts --maxWorkers=2 --testTimeout=15000 plus npm run typecheck; native cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml --test backing_processing_protocol plus existing reference_sync_protocol and focused settings/edit wire checks. Record exact commands/RED/GREEN/hashes; obtain fresh scoped contract review, release paths/Cargo. Root accepts scoped checkpoint before downstream GREEN.

### Task 2: Implement independently testable six-mode backing filter

**Files:** src-tauri/src/audio/dsp.rs only, including bounded backing_filter_tests unit module.

**Interfaces:** pub(crate) BackingFilterDsp::new(mode:BackingFilter,rate:u32)->Result<Self,String>, process([f32;2])->[f32;2], reset(). Consumes Task1 enum. Existing Biquad private; no complete TrackDsp or dependency.

- [x] With exclusive Cargo slot, write independent PCM response/stereo/reset tests RED. All six modes,44.1/48kHz;80/1000/10000 target4–7dB with correct sign, other listed bands<1dB. NoFilter exactidentity; [s,s],[s,-s],[s,0],[0,s] coherent; finite output at supported boundary rates, invalid rate rejection.
- [x] Implement low180Hz shelf, mid1000Hz peak Q0.7 and high4000Hz shelf +/-6dB, existing0.45rate clamp, independent channel state, direct none bypass. No normalization/limiter/tail plumbing yet.
- [x] Run cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml --lib backing_filter_tests and scoped fmt check. Supply RED/GREEN/report/hashes/fresh source review; release DSP/Cargo before Task3 native edits.

### Task 3: Integrate duration-preserving pitch, voice-owned filtering and native installs

**Files:** src-tauri/src/audio/backing.rs, renderer.rs, device.rs; src-tauri/src/runtime.rs, focused runtime/native processing tests and new src-tauri/tests/backing_processing.rs. P16 reference_sync.rs original tests unchanged except additional new scoped cases if needed.

**Interfaces:** BackingVoice::new neutral retained; new_with_processing(audio:Arc<DecodedAudio>,map:BackingMap,rate:u32,processing:BackingProcessing)->Result<Self,String>. Renderer::install_backing neutral retained; install_processed_backing(audio,map,mix,processing:BackingProcessing)->Result<(),String>. Use defaulted frozen BackingSettings.processing in production device/runtime callers.

- [x] Write behavioral RED:440Hz +12→880/-12→220/+1→466.1637615/+50c→452.8929841/-50c→427.4740541, combined+13→932.327523/-13→207.6523488; tolerance max1Hz/0.3% settled independent frequency estimate. +1/-50 and0/+50 exact same ratio output; -1/+100 and old neutral exact PCM.
- [x] Write RED gate/oracle cases for fractional entry/exit, excluded-source sentinel pair, both interpolation neighbors/correlation/transient windows, exact exit impulse, seek near ends, range/loop and no backing tails. Retain score-source clocks/frame counts at44.1/48k, cross-rate and0.1/1.23/3relative speeds; all stereo relationships and deterministic reset.
- [x] Change only within-grain stride sites, wire Task2 filter after transient assembly/before gain; prepare off callback, reset/suppress at seeks/gates/EOF/tails. Neutral path retains old PCM. Keep current source/timing validation before omit.
- [x] Add transform classification to set_mix's existing preserved-install path, reusing decoded Arc/resources; test processing changes install/actual PCM, generation/tick/range/loop/practice stay, gain-only noreset/cheapMix, stale reference timing still rejects. No decode/allocation/DSP preparation on callback.
- [x] Thread frozen processing through native device and runtime/export renderer install. Test live-core versus backing-stem PCM and unchanged score stem/events, device-rate reconstruction, omitted backing timing, stale source/revision/generation and invalid native input.
- [x] Run cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml --test backing_processing, incumbent audio_backing/reference_sync and focused lib/runtime tests with exact filters after reviewing module names. Root may grant targeted tests; no whole suite yet. Demonstrate negative control sensitivity then restore. Fresh native review, report/hashes, release Rust/Cargo.

### Task 4: Add the generated Backing controls and semantic history key

**Files:** new src/audio/BackingProcessingControls.tsx and test, BackingPanel.tsx/test, App.tsx/test only actual visibility prop, controller.ts/test key, NativePlaybackController processing-focused test; minimal incumbent stylesheet rules if needed. Consumes Task1 helpers; may run parallel with Tasks2/3 after Task1 acceptance.

**Interfaces:** BackingProcessingControls props exactly spec. BackingPanel adds optional visible:boolean defaulttrue; App passes referenceVisible. DocumentController.backingState adds normalized processing key. No change to referenceTimingKey.

- [x] Inspect actual new GenAI/provenance and current panel; read craft-floor immediately before UI edits. Write local numeric lease tests RED: Enter once, unchanged/noop, Escape/blur/windowblur/collapse/hide/sourcechange/unmount cancel; ownbusy active usable; pending retains lease; stale errors suppressed. Invalid/partial/fraction draft cannot commit old valid value; arrows1/Shift10 clamped, stop key propagation.
- [x] Write all7ordered Filter options/reset one captured setBacking tests, preserving mix/anchors/reference/source. Original embedded/score-only no committed controls; busy siblings disabled. Add live-redo tests for default-equivalent/identical noops and distinct pair/filter persistence. Validate invalid before no-op.
- [x] Implement one small component/local refs/state, inherited styles/white focus, labelled paired fields/select/helper. Use full settings snapshot before await and existing operation lease. No general framework or new App layout/dock behavior.
- [x] Test settled processing edit invokes NativePlaybackController setMix at same generation/timing/source/notation; gain-only still works; no new tempo generation. Run focused Vitest for processing controls/panel/controller/playback, typecheck; exact commands/hashes/RED/GREEN, fresh source/a11y/lifecycle review, release paths.

### Task 5: Guard GP include without rewriting source audio

**Files:** src/interchange/backing-projection.ts and focused backing-projection tests only. May parallel Tasks2–4 after Task1.

**Interfaces:** incumbent projectGpDocument(input:GpBackingProjectionInput):model.Score and gpBackingSelectionIssue(score,backing,selection):string|null. Exact error copy is in spec.

- [x] Write RED for nonzero total pitch/allnon-none filters in direct projection and UI preflight, with selection variants. totalzero+none includes rawbytes unchanged; explicit omit bypasses source read/projection and removes active backing/sync; preserved original siblings unchanged.
- [x] Implement one small audibly-neutral predicate/guard reused at both boundaries before current-audio read if possible under incumbent facade. Preserve full route/selection/current-byte validations and callback purity. No decoder/encoding/GPIF processing fields.
- [x] Run npx vitest run src/interchange/backing-projection.test.ts src/export/useExportCoordinator.test.ts src/export/useExportCoordinator.reference-sync.test.ts --maxWorkers=2 --testTimeout=15000 (verify exact incumbent test paths first); fresh scoped review/hashes/report, release.

### Task 6: Root coherent verification and bounded actual acceptance

**Files:** reviewed inert new tests/desktop/backing-processing-fixture.mjs and parity-backing-processing.mjs; docs/validation/2026-10-16-gp8-backing-processing.md and supported current P17/P18 overlay updates only.

- [x] Collect frozen producer reviews; root review joins, run typecheck/fmt/resources plus coherent whole frontend/native once. Fix only demonstrated failures, preserve all fail/skip/ignore receipts. No P16 freshness replay.
- [x] Review guarded fixture/driver BEFORE prepare: original low-level tone/multitone and short scores only; source/binary/profile/PID/exe/start/owned-output/hash admission, inert default/help, exact cleanup/no broadkill/delete/global input. Root builds fresh production frontend/diagnostic --no-bundle, binds source/resources/exe and unique profile.
- [x] Actual Windows paired numbers/filter/reset, correct audible-settings receipt/cursor clock, Enter/Escape/invalid/cancel/ownbusy/UndoRedo, saved clean natural exit/fresh reopen; GP actual included-processing block then omit native publication. Source/history/redo/assets invariant on noops; real processing commit revisions exact.
- [x] Publish an original processed backing WAV and/or stem through real native export; inspect independent frequency/filter response and same duration/current frozen setting, score stem unchanged. Keep offline/headless versus physical/listening claims separate; no physical audio window assumed.
- [x] One batched new-control visual review960/1280/1600+short/focus/invalid/pending/embedded. Fix complete identified set once, at most one confirmation then STOP. Preserve P16 exhausted ceiling and old visual evidence.
- [x] Publish final exact-source validation/limits, independently review and adopt only supported P17/P18 assessment preserving all historical fields/other rows/prior evidence/CI snapshots. Root scoped commit/push, remote and current-head CI snapshot, close this plan's bounded gates. Full258 parity/platform/shipping still open.

## Self-review

The plan covers strict neutral compatibility (Task1), all documented modes (Task2), shared native audible/time/source behavior (Task3), local UI/history ownership (Task4), honest interchange (Task5), and actual persistence/publication/verification (Task6). Five review-focus cases each have an explicit oracle. This is a local backing extension, no replacement visual world or global tonality subsystem. New tests precede implementation; producers stop at exact path/Cargo boundaries. All task boxes start pending.

## Execution amendment — native observer, 2026-10-16

The first two guarded desktop attempts stopped on test-harness defects before the planned feature workflow: wrapping-label text matching, then an observer that attempted to replace Tauri 2.11.6's immutable invoke function. Neither is accepted feature verification. All failures, builds and captures remain retained. Root authorizes one capability-gated bounded continuation after a focused observer regression check and scoped review: observe the real native transport response, require a successful read-only status probe before editing, and forward held requests exactly once. This necessary correction replaces the earlier functional-run cap; it does not extend the one visual batch/correction/confirmation ceiling or reopen any P16 acceptance. Do not silently fall back or count missing instrumentation as a pass.

## Bounded closure — 2026-10-16

Tasks 1–6 are accepted within the declared local scope. Final report EF0ABDCE and independent final review 115F05F1 support P17 implemented/local numeric scope and P18 partial/six frequency filters. Root adopted exact reviewed overlay bytes D560E359/DB7C320F; post-adoption preservation check 3477815D confirms 2580 historical fields, 256 other objects/rows, 99 prior evidence entries, 45 prior digests and frozen CI unchanged. Evidence commit 59fa09fbbc453498afe572ed1e8509383aa33772 was pushed and remote feature head verified; released main remains 7fc41c773a1b016d7249ceb98ab7929fcca1ce8f. Its current-head CI snapshot run 38822271084 records prepare-audio failure without reported steps/log URL and desktop skipped/no artifacts; cause unknown, no CI success claim. Root retains exact closure-commit remote/CI receipt separately. P17/P18 visual ceiling is exhausted. Physical audio, original-GP8, macOS/Linux, shipping, broader P18 separation and overall parity remain open.
