# Pitched trill sounding transposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Preserve a non-stringed pitched trill's interval through native-plan preparation, serialized MIDI and GP export without changing canonical written music.

**Architecture:** Extend the existing detached pitched normalizer to fold both base and active alternate into sounding pitches and zero the detached sounding offset. Reuse it at the start of MIDI preparation, then retain the incumbent tremolo correction; existing plan, worker, SMF and GP callers keep their signatures.

**Tech Stack:** TypeScript, pinned alphaTab 1.8.4, Vitest/jsdom, existing fflate; no dependency or Rust change.

**Spec:** `docs/superpowers/specs/2026-10-16-gp8-pitched-trills-design.md`.

## Global constraints

- Authoritative checkout: `C:/Users/krist/.codex/worktrees/tabplayer-rust/TabPlayer`. All scoped parity changes are authorized; no additional approval gate. Root starts this only after releasing P17/P18 delivery and owns Git/publication.
- Production edits only `src/interchange/pitched.ts` `preparePitchedGpScore` and `src/audio/plan.ts` `prepareMidiScore` plus its necessary import. Canonical written pitches, dynamics, IDs, relationships and source data remain exact; stringed/percussion staves are untouched.
- Normalize both pitched main and active alternate exactly once in detached copies; preserve display offset and incumbent negative-duration tremolo behavior. Supported normalized MIDI domain 0–127; no new broad range/clamping policy.
- No new UI, dependency, schema, IPC, renderer, native DSP or transport work. No app/browser/audio capture/build/Cargo/whole-suite run by the producer or reviewer.
- Accept literal source/MIDI/GP artifacts only. No physical audio, original-GP8, platform or shipping claim; no arbitrary promotion of broad partial parity rows.

## Review focus

- Different sounding offsets and display offset +7 must give 48/50 or 72/74 while canonical 60/62 remains exact (Task 1).
- Repeated preparation and the combined tremolo path must not subtract twice, lose IDs/links or alter rhythm (Task 1).
- A pitched trill chord must not leak the lane's nonselected chord-carrier sentinel or lose the neighboring note (Task 1).
- Mixed pitched/stringed/percussion staves and ordinary no-trill notes must preserve their existing domains (Task 1).
- Correct importer roundtrip output must not hide a wrong serialized Trill, shared-generator oracle or canonical mutation (Task 1; independent audit Task 2).

### Task 1: One producer — literal RED, two-function correction, focused GREEN

**Files:** Modify `src/interchange/pitched.ts`, `src/audio/plan.ts`, `src/interchange/pitched.test.ts`, `src/audio/plan.test.ts`, `src/harmony/transpose.test.ts`. Create `src/interchange/pitched-trill-oracle.test.ts`. Read-only integration seams: `src/export/midi.ts`, `src/interchange/gp.ts`, `src/audio/plan.worker.ts`; incumbent checks: `src/export/midi.test.ts`, `src/interchange/gp.test.ts`.

**Interfaces:** Keep `preparePitchedGpScore(score:model.Score,settings:Settings):model.Score` and `prepareMidiScore(score:model.Score):model.Score`. Existing `buildPlaybackPlan`, `buildPlaybackPlanFromJson`, `exportMidi` and `exportGpInterchange` consume their prepared results unchanged. The new test file owns only a small authored fixture and independent SMF decoder; do not introduce a shared fixture/codec framework.

- [x] Write `pitched_trill_literal_midi_plan_and_gp_contract` in the new jsdom test file. Use a finished single-bar fixture with independent dynamics 3; parameterize literal `{offset:12,base:48,alternate:50}`, `{offset:-12,base:72,alternate:74}`, `{offset:0,base:60,alternate:62}`. Decode real `exportMidi` bytes and compare plan/JSON-plan attacks to `Array.from({length:16},(_,i)=>({tick:i*240,key:i%2===0?base:alternate,velocity:63}))`; compare paired release ticks `(i+1)*240`, keys, PPQ 960 and duration 3840. Expected base/alternate values come only from this literal table.
- [x] In that oracle inspect real `exportGpInterchange` ZIP/GPIF: exact Trill 50/74/62, normalized main pitch, valid note references; verify reopened MIDI only as a supplementary check. Snapshot canonical JSON/links/offsets before all routes and require exact preservation afterwards. Add display +7, valid low-boundary 0/2, independent mixed offsets and a trill-plus-nontrill chord with no extra carrier attacks.
- [x] Run `npx vitest run src/interchange/pitched-trill-oracle.test.ts --maxWorkers=2 --reporter=dot`. Record the initial failure showing alternate 62 where 50/74 is required before changing production or weakening historical assertions. If another fixture error prevents that observation, fix the fixture and obtain the meaningful RED first.
- [x] Extend `preparePitchedGpScore` to capture each eligible base sounding pitch and active alternate minus the same original staff offset before cloning; apply both to the detached notes, preserve display offset and zero only eligible detached sounding offsets. Reuse this function at the start of `prepareMidiScore`, then compose the existing tremolo correction with that prepared score. Keep the current link/dynamics/backing preservation path; no caller rewrites or general abstractions.
- [x] After the meaningful RED, revise `src/interchange/pitched.test.ts`'s `preserves current absolute trill playback...` characterization so prepared/exported alternates are 50/74 and canonical alternate remains 62; any direct public legacy control stays explicitly labeled. Revise `src/harmony/transpose.test.ts`'s existing alternate-pitch limitation case to expect emitted 49/51 after +1 while canonical written 61 / alternate 63 stays exact.
- [x] Extend `src/audio/plan.test.ts` to pin both preparers' idempotence, neutral identity return and the combined pitched/tremolo duration/ID/link case. Retain existing mixed stringed/drum, ordinary pitch/display, per-note dynamics, tie/slur, backing detachment and archive-preservation assertions; do not edit unrelated expected events to obtain GREEN.
- [x] Run `npx vitest run src/interchange/pitched-trill-oracle.test.ts src/interchange/pitched.test.ts src/audio/plan.test.ts src/export/midi.test.ts src/harmony/transpose.test.ts src/interchange/gp.test.ts --maxWorkers=2 --reporter=dot` and `npm run typecheck`; require all selected tests and types to pass. The initial wrong-alternate RED is the negative control. Only if it did not isolate the alternate defect, perform one temporary bypass under producer ownership, observe the same literal failure, restore exact source bytes and obtain GREEN again.
- [x] Release the exact changed files with SHA-256s and `.analysis/parity/pitched-trills-producer-report.md`: commands/results, RED/GREEN receipts, canonical/preservation checks, any deliberate mutation/restoration and limitations. Do not commit, broaden scope or start actual app/build acceptance.

### Task 2: Fresh independent source and oracle review

**Files:** Read Task 1's exact released files, this spec/plan and producer report. Create only `.analysis/parity/pitched-trills-independent-review.md`.

**Interfaces:** Consume the released source/test hashes and literal event/XML contract. Produce an explicit scoped verdict with actionable file/line findings and evidence gaps; the reviewer does not modify production or repeat root's entire verification.

- [x] Independently inspect the two-function composition for exactly-once normalization, source immutability, preserved offsets/dynamics/links and untouched stringed/percussion domains. Check combined tremolo and lane-carrier behavior against the actual existing callers.
- [x] Audit that MIDI assertions decode serialized bytes, GP assertions inspect exact XML rather than only reimport, and plan/worker assertions use literal expected values rather than the public generator. Confirm the wrong-alternate RED demonstrates sensitivity; request a single targeted control only if this evidence is insufficient, rather than adding mutation harnesses.
- [x] Check each Review Focus case against a meaningful test, and verify changed legacy characterizations preserve their original narrow purpose. Release verdict/report hash tied to the exact producer hashes. Return genuine defects to the same producer for a surgical RED/fix/GREEN and scoped rereview; no new feature work.

### Task 3: Root focused verification and honest validation

**Files:** Released Task 1 files and Task 2 report. Create `docs/validation/2026-10-16-gp8-pitched-trills.md`; root may update this plan's checkboxes to the actually completed state.

**Interfaces:** Consume independent acceptance and exact source/test hashes. Produce root-confirmed focused results and versioned validation of source behavior plus serialized MIDI/GP artifacts, without substituting prior P17/P18 or whole-suite results.

- [x] Verify release hashes, then execute the same six-file focused Vitest command and `npm run typecheck` at the joined source. Broaden only for a specific observed failure/new risk; no blanket 2647/617 rerun, Cargo, build, app or physical-audio task is implied.
- [x] Retain authored artifact pairs `.analysis/parity/pitched-trills-plus12.{mid,gp}` and `.analysis/parity/pitched-trills-minus12.{mid,gp}` from the oracle, independently inspect the literal MIDI event table and GPIF Trill 50/74, and record exact hashes with command/source provenance. Do not claim these artifacts were accepted by original GP8. Record source immutability, idempotence and all supported preservation cases.
- [x] Publish the concise validation with exact source/test/report/artifact hashes, actual focused totals, meaningful RED/GREEN evidence, independent review and explicit out-of-domain/physical-audio/original-GP8/platform/shipping limits. Supersede only the demonstrated transposed-trill defect; broad sounding-transposition partials and other interchange-family work remain open. Overlay promotion is not part of this plan.
- [x] Root owns the scoped commit/push and any delivery checks. Close only completed bounded boxes; preserve older reports/receipts and do not relabel historical CI or unrelated whole-suite checkpoints as this tranche's runtime proof.

## Bounded closure — 2026-10-16

Tasks1–3 are complete within the declared valid-domain source/artifact scope. Source3c51510f85be0c1c4446a8ea36f1a0cdc00d31d8, independent source reviewFE581775 and final artifact/document review5D16354E are accepted. Root focused122/6files and types pass; root verificationB061A1D3 and independent actual SMF/GP inspection5350757C preserve exact literal pitch/tick/velocity/reference expectations. Validation report223D809C was committed and evidence2dede1a0ac9ffe665920ef2535b2c81a10446e62 pushed/remoteverified. This plan makes no parity-overlay promotion and no physical audio/originalGP8/platform/shipping/whole-suite claim. Released main remains7fc41c773a1b016d7249ceb98ab7929fcca1ce8f. Root records closure-commit remote/current-CI separately; no pending/failed CI becomes a success claim. Predecessor evidence and visual ceilings stay closed.
