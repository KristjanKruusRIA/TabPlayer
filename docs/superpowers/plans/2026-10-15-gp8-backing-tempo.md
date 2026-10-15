# GP8 Reference Sync and Tempo Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the bounded P16 native reference clock, nondestructive brackets, atomic tempo conversions and truthful current-backing GP projection.

**Architecture:** Preserve authored score/legacy mapping; derive one effective plan from occurrence-aware sync pins. Shared pure contracts support independent native playback, TS timing/conversion and UI producers. Root owns historical replay, controller/workspace joins, native asset reads, whole verification and actual acceptance.

**Tech Stack:** Existing Rust1.88/Tauri2, React19/TypeScript, alphaTab1.8.4, Symphonia0.6.1, Vitest/owned Playwright desktop harness; no new dependency.

**Spec:** [2026-10-15-gp8-backing-tempo-design.md](../specs/2026-10-15-gp8-backing-tempo-design.md). Status: Task1 static schemas, typed seams and independent literal oracles accepted after behavioral checks and fresh reviews; Tasks2–9 pending. Standing human execution method is parallel work in this chat plus independent review with all scoped changes approved; no new approval question.

## Global Constraints

- Preserve legacy omitted/null referenceSync behavior, original source/asset bytes, strict unknown-field rejection, native document/revision/activation ownership and existing operation lease.
- Stored source convention is sourceMs=audioMs-offsetMs; reference mode permits signed stored pins only with valid physical coordinates. No persisted source duration, tick/tempo cache or schema bump.
- Reference endpoints use first occurrence start/last occurrence end, full performed route, quarter BPM at PPQ960, source translation slope1 at100%; initial grace is silent-backing score pre-roll, exclusive musical exit. Export explicit tail is wall time.
- No fixed-practice10–300 limit on derived tempos. No second clock/decoder/PCM copy/service, global cache/job framework, general batch command, destructive trim, pitch/filter/recording or unrelated UI changes.
- Actual GenAI image8F3F6B33/provenanceDEB694E6 precede code. Keep adaptive dock height/Inspector boundary/numeric anchors/gain units; generated geometry/timing and blended stereo are illustrative.
- Root alone owns shared joins/Git/Cargo slot/full suites/build/app/CDP/physical capture. Each worker owns only its paths, requests Cargo slot, supplies frozen hashes and independent review before root adoption.
- P15/older actual screenshots/audio/Long/Library/OLE retained; no freshness reruns. No installer, rejected cleanup retry, private-source commit or main promotion.
- Native .tabplayer/source/Windows/GP/all-platform/shipping acceptance are distinct. GP bracket encoding is unverified; do not invent XML or advance P16 beyond supported criteria.

## Review Focus

1. Same-score reference edits must rebuild effective clock while gain-only edits retain generation; notation seeks/cursor must map authored milliseconds through musical ticks. Task7 pins both.
2. Structural history must reflow endpoints at the original command position; settings-only replay, Undo/Redo and reopen must equal full replay, including free-time/repeat/rhythm changes. Task6 pins both and rejects EOF before apply.
3. Exclusive frame/event gates must cover interpolation/grains/transients/near-tick dispatch and backing-omitted export duration. Task3 pins native PCM and selected range/tail scheduling.
4. Numeric own-busy state, hidden-but-mounted dock, invalid partial input and late asynchronous source read must never self-cancel a valid action or commit into a newer document. Tasks5/6 pin these.
5. Repeated-pass conversions compare complete inherited BPM functions, and current selected backing must beat original archive audio collisions without dropping unrelated source siblings. Tasks4/8 pin both.

## Contract freeze and ownership

Task1 creates exact types/stubs before producers. Spec function signatures are authoritative, including `referenceSyncTiming`, `referenceSourceMs`, `applyReferenceSyncPlan`, `referenceTimingKey`, `initializeReferenceSync`, `disableReferenceSync`, `moveReferenceEndpoint`, `adjustReferenceSyncBounds`, `syncPointsFromScore`, `scoreTemposFromSync`. Do not rename a consumer's import silently.

| Owner | Exclusive product paths after Task1 freeze |
|---|---|
| Task2 TS math | new reference-sync.ts/.test.ts; existing backing-timeline.ts/.test.ts |
| Task3 native playback | new audio/reference_sync.rs and tests/reference_sync.rs; audio/backing.rs, renderer.rs, device.rs; export/audio.rs plus directly corresponding focused tests |
| Task4 conversions | new editor/tempo-automations.ts/.test.ts and audio/tempo-conversion.ts/.test.ts |
| Task5 UI | new audio/useReferenceSyncEdit.ts/.test.tsx; BackingPanel.tsx/.test.tsx; BackingWaveform.tsx/.test.tsx; backing-waveform.css; export/ExportDialog.tsx/.test.tsx |
| Task8 TS GP projection | new interchange/backing-projection.ts/.test.ts; existing interchange/gp.ts and targeted GP tests |
| Root | all shared types/validators/fixtures/module declarations, engine/replay/advanced dispatcher, plan/route extraction, DocumentController, native read endpoint/workspace/runtime/lib, playback controller, App/Workspace and frontend export joins; whole checks, evidence, ledger, Git |

Task2/3/4 may work in parallel after Task1; Task4's executable math tests wait for accepted Task2. Task5 may author its isolated transaction after contracts, but math-dependent checks/overlay integration wait for Task2. Task8 projection may proceed independently after its exact read/selection contract. Root accepts frozen producer paths and fresh scoped reviews before shared joins. No worker runs app/prepares fixtures or changes the progress overlay.

### Task1: Root freezes strict schemas, literal oracles and compilable seams

**Files:** edit-types.ts, editor/tempo-types.ts, parity-commands.ts, document-settings.ts, audio/types.ts/plan.ts, export/types.ts, bridge.ts, new export/backing-asset-types.ts and interchange/backing-projection.ts seam plus reference-sync-types.ts/reference-sync.ts/tempo-conversion.ts/tempo-automations.ts seams; Rust settings.rs/edit_types.rs/audio/plan.rs/mod.rs/lib.rs, new export_backing.rs DTOs plus exact existing plan/settings literals; new tests/reference-sync-protocol.json and tests/reference-sync-timing.json; protocol tests in src/audio/reference-sync-protocol.test.ts and src-tauri/tests/reference_sync_protocol.rs.

**Interfaces:** ReferenceSyncBounds optional nullable in BackingSettings; RatioTempoPoint and ReplaceTempoAutomations score variant; optional PlaybackPlan.playbackEndTick; exact spec pure interfaces. Export `backingLocationsForScore(score:model.Score):readonly ReferenceLocation[]` from plan.ts using the incumbent lightweight resolver, separate from full isolated-note generation. Existing validateBackingAnchors consumes it with widened optional referenceSync. Native pure module starts with typed bodies returning Err, not unresolved imports.

Freeze shared endpoint edit props in reference-sync-types.ts:
```ts
interface ReferenceEditBinding {
 active:{endpoint:ReferenceEndpoint;surface:'number'|'waveform'}|null;
 preview:BackingSettings|null;error:string|null;
 begin(endpoint:ReferenceEndpoint,surface:'number'|'waveform'):boolean;
 update(sourceMs:number):void;commit():void;cancel():void;
}
interface ReferenceEditOptions {
 owner:Readonly<AudioOwner>;document:DocumentRevision;sourceKey:string|null;
 settings:BackingSettings|null;timeline:BackingTimeline|null;durationMs:number|null;
 visible:{number:boolean;waveform:boolean};busy:boolean;
 beginOperation:()=>()=>void;isCurrent:(document:DocumentRevision,settings:BackingSettings)=>boolean;
 onCommit:(backing:BackingSettings,document:DocumentRevision)=>Promise<void>;
}
```
Invalid/nonfinite update marks the current draft invalid; it cannot commit its last valid preview. Hook returns ReferenceEditBinding; each view owns raw numeric/pointer mechanics, not another lease. App resolves preview timing through the pure helper.

Also freeze `ReferenceSyncControls` exactly from spec and optional BackingPanel.reference/BackingWaveform.reference props; no later prop negotiation. GP ExportOptions adds optional backing:boolean defaulttrue. Freeze `GpBackingProjectionInput {score:model.Score;settings:DocumentSettings;bytes:Uint8Array|null;selection:ExportSelection;backing:boolean}`, `projectGpDocument(input:GpBackingProjectionInput):model.Score` and `gpBackingSelectionIssue(score:model.Score,backing:BackingSettings|null,selection:ExportSelection):string|null` in the projection seam. ExportDialog optional gpBackingIssue callback has the exact latter selection-only consumer signature from spec. NativeBridge gains required readBackingAsset(assetId,revision):Promise<Uint8Array>; Task1 factory/mocks use a typed rejected-promise seam until Task8 actual implementation, so the contract checkpoint compiles without a registered endpoint. IPC request is exactly `{request:{document,assetId}}` and strict response `{document,assetId,sha256,bytesBase64}`; assetId lowercaseSHA256 and bytes match digest, query-only512MiBraw-container cap before/afterbase64, not a universalimportlimit. Root adds protocol DTOs/shared byte-read fixtures/tests here; no registered runtime read endpoint until Task8.

- [x] Write shared valid legacy omitted/null, reference signed-offset, bounds, replacement-ratio and active-end payloads; invalid extra/missing nested fields, unsafe/u32 indices, nonfinite/fraction/order/duplicate/initial-point/BPM cases. TS-only NaN/Infinity included. Legacy-negative-stored stays invalid. Native schema tests need no score/device.
- [x] Freeze byte-read BackingAssetReadRequest/response strict DTOs and MAX_EXPORT_BACKING_BYTES=512*1024*1024 in the named TS/native files. Pure validateBackingAssetReadRequest rejects wrong/unsafe document revision, non-lowercaseSHA256 assetId and extra fields; payload response checks are Task8. Include shared cases in the protocol fixture; expose native module without a registered command.
- [x] Write literal timing fixtures:120→60 source pins, ±offset/zero source,6/8, pickup/free-time, grace/tail, reference activation fallback, endpoint aliases/missing occurrence/crossings, structural append/interior insert/EOF, repeat conflicts and ratio1/3/3/8. Expected numbers are authored, never regenerated from the candidate implementation.
- [x] Run `npx vitest run src/audio/reference-sync-protocol.test.ts --maxWorkers=2 --testTimeout=15000` and `cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml --test reference_sync_protocol` to behavioral RED, then implement only shapes/defaults/static validation and lightweight route extraction to GREEN. Compile all existing Rust literals with None so later RED is behavioral rather than a compiler error. Do not implement effective timing here.
- [x] Run focused incumbent protocol/plan/legacy settings checks, typecheck/fmt; get fresh contract review and commit exact paths. Record hashes/ownership under .superpowers/sdd/2026-10-15-gp8-backing-tempo before dispatch.

### Task2: TS worker implements pure reference timing and projection

**Interfaces:** all exact spec timing functions. Consumes frozen ReferenceLocation, BackingTimeline, PlaybackPlan and fixtures. Produces deterministic detached derived plan/settings; legacy returns incumbent behavior/object where promised.

- [x] Write tests resolving literal(0,1000),(3840,3000),(7680,7000) →120/60,6000ms, tick4800/source4000; offsets+120/−120, source0, fractional no-op,6/8 and real short/long occurrence extents. Reject missing/skipped/duplicate/endpoint seam and crossed/invalid pins, invalid source bounds, finite-arithmetic overflow. Snapshot every input.
- [x] Test applyReferenceSyncPlan removes authored intra-span tempo changes, preserves every note/MIDI/beat/click identity/tick, adds correct playbackEndTick and recomputes full duration/occurrence milliseconds. Grace120ticks→62.5ms preroll; note end4440 retained while active end3960. Legacy plan object unchanged.
- [x] Test activation valid legacy endpoints versus[0,D] fallback, matching endpoint absorption and conflicting endpoint rejection; disable signed stored pins rebases anchors+offset equally and retains physical map; clear interiors keeps mandatory bounds.
- [x] Test adjustReferenceSyncBounds old/new extent rule: append exit11000 and old prefix unchanged; interior insertion source-fixed expectations240/30BPM; unchanged extent/grace shift leaves exit fixed. Source upper-bound enforcement remains caller-supplied actual D, not invented settings metadata.
- [x] Extend existing backing-timeline reference branch to project tick→source using mandatory endpoints and derived math, including local preview, grid, repeated selections, score-ms→tick and signed anchor movement. Preserve all P15 legacy fixture results. Native playhead uses committed effective timeline while local candidate grid/segments preview changes.
- [x] Run `npx vitest run src/audio/reference-sync.test.ts src/audio/backing-timeline.test.ts --maxWorkers=2 --testTimeout=15000` RED→minimal implementation→GREEN. Supply hashes/report, get fresh scoped review; relinquish paths.

### Task3: Native worker implements translation, exclusive gates and active duration

**Files/interfaces:** exclusive native paths above. Add `ReferenceSyncMap::new(settings:&BackingSettings,plan:&PlaybackPlan)->Result<Self,String>` in audio/reference_sync.rs; public read-only entry/exit source seconds, entry/end ticks and translation methods used by BackingMap/voice. Exact internal fields may remain private; do not change legacy BackingMap::new contract.

- [ ] Test shared oracles with authored literal plans and decoded impulse PCM: validate effective spans (including interior authored tempo rejection), signed stored reference pins/offset, first grace and last occurrence endpoint; malformed/missing/aliased/crossed points and dishonest effective plan reject before voice.
- [ ] Test true source translation at100%/50% using impulses/sustained signal and analytical source-time indices; source1000→7000 at elapsed0→6000 (plus explicit grace). Excluded pre-entry/exact-exit impulses cannot leak via grains, correlation/interpolation or transient path. Retain legacy source-time/pitch/practice tests.
- [ ] Test active duration6000ms for long60000ms file, omitted/muted backing, note tail and repeated route; seek/end/range/loop and near-tick note/MIDI/click exclusion. Existing fixed-BPM-with-backing restriction remains. setMix changing reference timing rejects before publication; gain-only same-map update works.
- [ ] Test whole/selected audio and stem export at100%/50%, omitted backing and500ms wall tail (12500ms result for6000ms at50%);≤one output-frame scheduling tolerance, score-release-only tail and no post-exit backing. Preserve source assets and legacy duration branch.
- [ ] In exclusive granted Cargo slot run `cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml --test reference_sync` and focused touched-unit/export suites RED→implementation→GREEN, then scoped fmt. No app/device/physical speaker capture. Supply logs/hashes and fresh native review before relinquishing slot/paths.

### Task4: Conversion worker implements one captured score edit and pure replace/add

**Interfaces:** `applyTempoAutomations(score:model.Score,points:readonly RatioTempoPoint[]):void` in editor/tempo-automations.ts; pure conversion functions from spec. Root later calls the score helper from advanced dispatcher and wires controller queue.

- [ ] Test complete atomic authored replacement at ratios0,1/3,3/8, arbitrary positive BPM/linear flags; validate existing bars/all entries before assignment; clear absent arrays/update initial tempo while preserving every unrelated score field. Invalid late point leaves entire score exact. Full normalized no-op comparison includes labels/visibility defaults.
- [ ] Test From score literal two-bar120@0,60@1280,180@5760/end7680 →physical1000,5000/3,19000/3,7000; stored+120 and authored map unchanged. Replace captures all true breakpoints; Add preserves endpoints/existing points, idempotent agreement within1e−7ms, different-time alias/crossing/EOF rejects whole union. Legacy initialization uses accepted helper; final enters reference.
- [ ] Test full repeated-bar union of inherited/internal BPM functions: hidden second-pass1/3 change and120vs120.000001 reject. Compatible passes emit one written map including needed bar starts, no terminal outgoing event, preserve ratio values and regenerate candidate performed schedule to prove equality. Grace outside occurrences gets no fabricated ratio.
- [ ] Run `npx vitest run src/editor/tempo-automations.test.ts src/audio/tempo-conversion.test.ts --maxWorkers=2 --testTimeout=15000` RED→GREEN after accepted Task2; add exact regression for isLinear generated piecewise behavior rather than claim ramp support. Supply hashes/report/fresh review, relinquish.

### Task5: UI worker extends the existing sidebar and waveform from GenAI

**Interfaces:** exact ReferenceEditOptions/Binding/Controls, `useReferenceSyncEdit(options):ReferenceEditBinding`. BackingPanel receives optional reference:ReferenceSyncControls; BackingWaveform optional reference:Pick<ReferenceSyncControls,'timing'|'edit'>. onEdit remains setBacking-only. ExportDialog GP choice passes options.backing; all omitted props/options retain legacy default behavior.

- [ ] Inspect actual GenAI image and relevant Impeccable craft-floor immediately before UI edit; inherit existing Operate identity, no context rerun/new identity exercise. Write transaction tests before implementation: local candidate, single lease, first-change begin, own-busy keeps active control enabled; zero early command, one changed command/settlement release, invalid NaN/partial draft cannot commit last valid plot.
- [ ] Test numeric Enter applies once/blur orEscape cancels; exact fractional no-op; number Up/Down1ms/Shift10ms changes draft with no key-up commit. Waveform pointerup and Left/Right1ms/Shift10ms matching key-up commit once. Revision/full-settings/source/activation/generation/visibility/windowblur/unmount and pointercancel/lostcapture cancel, even hidden-but-mounted dock. Late rejection/settlement cannot affect new document.
- [ ] Test sidebar native Timing labels, actual Entry/Exit values/source duration, Fromscore Replace/Add menu focus/Escape/no-history and consequence description. Original embedded/loading/error/score-only have no enabled persisted controls; existing Edit embedded path, numeric anchors/mix/gain units remain.
- [ ] Inspect actual pre-code backing-gp-export-concept.png5AB74C54/provenance, then add GP-only Include backing audio checkbox defaulttrue and optional gpBackingIssue(selection) preflight callback. Call only for valid selection/GP/include, memoized off score/settings/selection, no decode/byte query/render side effect. Show compact associated issue/disabled invalid submit using existing dialog error/focus management. No audio-format controls in GP mode. A false choice clears that include issue and keeps selected notation export available, with no active backing/sync and no claim to remove unreferenced preserved archive bytes.
- [ ] Test waveform distinct edge-reachable endpoint sliders/names/white keyboard outline/readout, cannot Delete endpoint; real mono/stereo paths remain, outside-span dimming and120/60 segment labels from pure timing. Candidate previews update both surfaces/grid only, with no native transport/request/score-tempo command. View-only zoom/pan/selection no edit.
- [ ] Run targeted hook/panel/waveform Vitest RED→GREEN on accepted math; no app/visual acceptance from jsdom. Supply source/report hashes and fresh scoped accessibility/transaction review, relinquish paths.

### Task6: Root joins historical reflow and serialized source/revision admission

**Files:** engine.ts, editor/advanced.ts, plan.ts/route cache seam, controller.ts and new focused engine/controller reference-sync tests, App/Workspace binding only.

- [ ] Test full history replay after append/insert/remove/paste and meter/pickup/free-time/repeat/direction/grace/rhythm/longest-lane changes, including history with later setBacking, Undo/Redo and settings-only fast path. Check native file retains original one command and source/assets exact; full/settings replay final brackets equal.
- [ ] Capture lightweight old timing before each non-settings command, apply existing remaps/rebuild, adjust bounds once at historical point then validate. Do not reuse a WeakMap result on mutated score. Reference settings replay fallback reconstructs derived settings while preserving committed score identity. Wire applyTempoAutomations as ordinary score command.
- [ ] Add setReferenceWaveformBridge lifetime binding and editAtRevision queue guard. Test actual metadata read buckets1 before apply on changed reference timing/route, source-bound receipt reuse, EOF/decodererror/missingbridge rejection, bridge/activation/revision/source change during await, queued conversion stale revision, no-op/failed action preserving redo/history/assets. Native expected revision stays the captured one.
- [ ] Test reference mode enable only committed asset; staged import remains legacy until committed; original embedded remains read-only. App bind/unbind bridge safely per activation, with old cleanup unable to clear a newer binding. No output-device dependency.
- [ ] Run focused engine/controller/workspace/new-schema tests RED→GREEN, types; get fresh historical replay/admission review before accepting join. No full suite yet.

### Task7: Root joins effective playback, notation time adapters and audio export

**Files:** NativePlaybackController.ts/new .reference-sync.test.ts; App.tsx/WorkspaceApp.tsx tests; useExportCoordinator.ts and targeted tests. Consumes accepted producers.

- [ ] Test same score reference bounds/offset/interior/enable/disable/source changes get new generation/prepare; gain-only retains plan/setMix. Keep authored plan worker output separately; superseded preparation/status cannot publish. Timing remains readable after no-device failure and preparing release.
- [ ] Test native tick4800/effective3000ms feeds authored view milliseconds at tick4800; inverse authored seek reaches that same native tick. Cover grace/repeats and differing intra-bar tempo. Timer/grid/active duration remain effective and source automations exact.
- [ ] Join one shared endpoint hook to panel/dock with both visibility flags, existing lease/current guards, editAtRevision, confirmed source metadata and explicit mode/Fromscore/write actions. Pure calculation runs on captured authored snapshot; queue guard rejects intervening changes. Preserve selection/export/Library/workspace admission.
- [ ] Transform frozen audio export plans before native export including includeBacking=false; retain playbackEndTick through omission. In native runtime export capture, active reference timing captures/decodes/validates source bounds and pin/BPM agreement before settings clearing or voice omission; omitted legacy backing incurs no new decode. Test malformed direct reference settings/EOF fail with PCM omitted, and valid omitted PCM retains timing/duration. Test staves/track/bar selection and current/saved speed use the same effective timing without mutating frozen settings/model.
- [ ] Run focused joined playback/App/Workspace/export tests RED→GREEN and types; fresh joined review accepts exact paths before root checkpoint.

### Task8: Current-backing GP projection and owned byte read

**Interfaces:** strict `read_export_backing({request:{document:DocumentRevision,assetId:string}})` response `{document,assetId,sha256,bytesBase64}`; NativeBridge.readBackingAsset(assetId,revision):Promise<Uint8Array> is implemented by createDocumentBridge and included in useExportCoordinator's bridge Pick. Both export paths call the frozen projectGpDocument facade then existing low-level exportGp. Exact selection contract is spec Interface section and frozen report322DDDF9, not a deferred design decision.

- [ ] Root writes native read protocol/admission tests: current applied backing only (not redo/otherdoc), immutable capture/short lock, decode/hash outside locks, source/digest/revision stale rejection and query-only512MiB limit before/afterbase64, using actual N/N+1 guard tests without allocating huge fixtures. No arbitrary filename read. Implement native endpoint/strict NativeBridge method to GREEN.
- [ ] TS projection worker tests detached full document current settings/original embedded/explicitnull; exact asset bytes and live score/source/settings/history unchanged. Legacy offset-only maps include representable boundaries; signed import normalizes mapping; reference endpoints use physical coordinates and preserve authored tempos until explicit conversion. Include generation ignores stale original sync authority. backing=false bypasses byte read/source-map generation and clears detached backing/sync after selection even with an invalid old map, keeping notation export available.
- [ ] Test old archive fixed Content/Assets/backing-track bytes[1,2,3] versus current[9,8,7], unrelated sibling[0,255]; generated active bytes win in both GP writer branches, all other original siblings remain. Explicit removal cannot resurrect source backing.
- [ ] Test direct GPIF ratio1/3/3/8 and occurrence/frame fields, frame padding guard and p1000.01/s2500.02 →−44100/66150 →1000/2500ms; general<1.5frame bound and second roundtrip. Test full identity and unique contiguous selected-route projection after selectScore with fresh occurrence keys: no-anchor120BPM/+250 selecting original bar2 gives3750..5750ms; reference secondbar gives3000..7000; contained closed repeat matches, cut repeated-B selection rejects ambiguous include while omit still exports. Changed pickup duration, separated windows and any non-identity pre-body grace reject include. Full-identity grace gets its own source-map roundtrip oracle. Clear stale pass1 points before writer in both include/omit. No bracket-clip/mix/pitch/filter parity claim.
- [ ] Root joins legacy controller.export and modern export coordinator through the same detached projection/read contract with captured revision; cancellation/stale byte-read cannot export new state. Run focused GP/native read/controller/coordinator tests RED→GREEN; get independent scoped export/provenance review. Do not expand to unknown GP bracket XML.

### Task9: Root verifies coherent source and actual P16 workflow

**Files:** new tests/desktop/backing-tempo-fixture.mjs, parity-backing-tempo.mjs; docs/validation/2026-10-15-gp8-backing-tempo.md and only supported current ledger assessment.

- [ ] Obtain fresh producer/source/join reviews; run `npm run typecheck`, `cargo +1.88.0 fmt --manifest-path src-tauri/Cargo.toml --check`, resources, whole frontend `npx vitest run --maxWorkers=2 --testTimeout=15000` and native `cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml` once coherent. Fix only newly demonstrated failures, retain skipped/ignored truthfully.
- [ ] Author guarded inert fixture/driver with source/binary/owned-profile/PID/exe/start/revision/hash admission and independent source review before root prepare/run. Use original short impulses/tone and literal repeated/intra-bar/6/8/grace/EOF-conflict scores; no private songs/banks. Preserve source/redo/assets and exact owned-process cleanup, no broadkill/delete/global input.
- [ ] Root builds diagnostic once; record exact source/executable. ActualUI enable mode→move endpoints/numericEnter/key/cancel/invalid/outside/ownbusy→interior tempochange→Fromscore Replace/Add→compatible/incompatible Write score tempos→UndoRedo→save-clean-close-fresh-reopen. Assert current score/native cursor/seek/timing/conversion maps and byte/history invariants; screenshots alone are insufficient.
- [ ] In the same bounded actual workflow open GP export for an ambiguous repeated-bar selection with backing included: assert real validation blocks publication, focus the checkbox and capture the actual associated issue; clear Include backing audio→publish selected notation to a unique owned GP artifact. Inspect generated GPIF has correct selected music and no active backing/orphan sync, with source/history/assets unchanged. Also export one supported unique included source window and verify its physical timing/current audio bytes. Retain exact native publication revision and file hashes.
- [ ] Scoped authored offline/native PCM/transport receipt proves1s/s100%,0.5s/s50%, exact pre/exit gate, grace pre-roll, active end/omitted-backing/tail and range/loop. No old physical recording or unrelated audio/Long/OLE. Keep source/API versus audible/runtime claims calibrated.
- [ ] Batch actual960/1280/1600 and shortheight/reference/legacy/readOnly/error/focusednumeric+endpoint screenshots against8F3FGenAI plus the actual GP ambiguous-selection/focused-checkbox dialog against5AB74C54GenAI in that same visual round; root+fresh visual review once. Fix the identified set in one batch, at most one confirmation, then stop. Actual keyboard focus/readout must be captured after deliberate selection; no repeat P15 focus-capture mistake.
- [ ] Record exact tests/source/build/actual/screenshot hashes, failures and GP/platform/shipping limits. Preserve historical baseline/other rows and only advance current P16 scope supported by receipts; GP bracket compatibility remains open. Independent final joined review/adoption, root scoped commit/push and remote/currentCI snapshot precede Task9 closure. Do not mark overall goal complete.

## Self-review and completion boundary

Coverage is wire/legacy Task1, puretiming/projection Task2, native PCM/transport/export Task3, atomicconversion Task4, UItransactions Task5, historical/sourcequeue Task6, playback/notationjoin Task7, GPprojection/assetownership Task8, whole/actual/adoption Task9. Root self-review incorporated export-selection322DDDF9, exact bridge/view interfaces, query-limit truth and both independent design corrections (numeric Enter-only, reference validation before omitted PCM). Task1 contract checkboxes are accepted; Tasks2–9 remain pending their producer and runtime gates. This plan cannot establish unobserved native-GP bracket encoding, macOS/Linux runtime or full GP8 completion.
