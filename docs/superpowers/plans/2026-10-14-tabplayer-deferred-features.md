# TabPlayer Deferred Features Implementation Plan

> **For agentic workers:** Use the parallel-agent workflow to deliver independent requirements concurrently, with root coordinating shared interfaces and integration. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every deferred product feature and verify the complete expansion scope.

**Architecture:** Preserve Rust/Tauri and alphaTab 1.8.4 notation. Extend the finite editor protocol, add native Rust sample synthesis/backing/DSP, and use the same renderer for audio exports.

**Tech Stack:** Rust/Tauri 2, TypeScript/React, alphaTab 1.8.4, CPAL, Symphonia, RustySynth, svg2pdf/pdf-writer.

**Spec:** [Full expansion](../specs/2026-10-14-tabplayer-deferred-features-design.md), with its three approved linked specifications.

**Execution:** The user subsequently instructed: “Consider everything auto-approved. Use sub-agents to deliver different requirements at the same time.” Parallel requirement owners now implement independent modules; root coordinates shared contracts/integration and one independent whole-change review. Do not request design/plan approvals again. Approval is authorization to execute; it is not evidence that tests or platform checks passed.

## Global Constraints

- Engine version remains exactly 1.8.4.
- Native project schema version 2 retains the immutable base and ordered edits and adds an immutable, content-addressed asset table.
- Version 1 projects migrate in memory without changing their musical result and save as version 2.
- Shipping builds omit the existing desktop test commands.
- Private test music and extracted Guitar Pro application resources remain outside product/source releases.
- Every acceptance check receives a result and evidence path in the validation report; a passing narrow test does not establish an entire feature.

## Review Focus

1. Large backing files must stay Rust-side during ordinary edits; editor task 2 and audio task 4 test metadata-only snapshots.
2. Overlapping voices and independent string bends must retain note identity; audio tasks 1–3 test both explicitly.
3. Deleting music with links or sync anchors must leave a valid replayable document; editor tasks 3–5 and audio task 4 cover it.
4. Failed/cancelled exports must preserve prior output and dirty state; export tasks 1–4 inject each failure.
5. Packaged offline behavior and genuine platform I/O require runtime evidence; export task 4 records native checks, not only build success.

## Order and contracts

Execute independent work in [advanced editor](2026-10-14-tabplayer-advanced-editor.md), [native audio](2026-10-14-tabplayer-native-audio.md) and [exports/delivery](2026-10-14-tabplayer-exports.md) concurrently with explicit file ownership. Their task numbers are qualified by plan name. Shared-contract consumers coordinate interface readiness before joint compilation; root serializes Git mutations and integration.

The editor plan defines the matching Rust/TypeScript project, asset, sound and print DTOs used by later plans. The audio plan defines `PlaybackPlan`, `AudioResources`, `Renderer`, `AudioService` and `NativePlaybackController`. The exports plan consumes those exact interfaces. Keep stable track identity from `engine.ts`; do not create another identity scheme for mixer/export.

Use the already attached clean managed worktree at `C:/Users/krist/.codex/worktrees/tabplayer-rust/TabPlayer`, branch `codex/tabplayer-rust`. Base expansion commit is `f2f77f143f38a94c44d5cc87091ee7d0044f278e`. Preserve the original completed milestone and its tests. Use the using-git-worktrees skill to validate/reuse this checkout, without creating an unnecessary second worktree.

Verification commands run from the worktree. On this Windows host, Cargo is `C:/Users/krist/.cargo/bin/cargo.exe`; add that directory to the task's PATH before `npm run tauri`. Use `npm test`, `npm run typecheck`, `cargo test --manifest-path src-tauri/Cargo.toml --tests`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `git diff --check` for complete checkpoints. Targeted red/green commands are specified in each task. Commit only after its relevant checks pass.

## Requirement closure

| Requirement | Owning tasks |
| --- | --- |
| E1 Techniques and breaking ties | Editor 2–3, 6; audio 1–3 |
| E2 Voices/staves/layout | Editor 4, 6 |
| E3 Rhythm/notation | Editor 2, 5–6; audio 1; exports 1–2 |
| E4 Track rename/instruments | Editor 4, 6; audio 3, 5 |
| E5 Selection bug | Editor 1, 6 |
| A1 Backing audio | Editor 2; audio 4–5; exports 3 |
| A2 Realistic voices | Audio 1–3, 5 |
| A3 Amps/effects | Editor 2; audio 3, 5; exports 3 |
| X1 PDF/print | Editor 2; exports 1, 4 |
| X2 MIDI | Exports 2, 4 |
| X3 Mixed/stem WAV | Audio 3–5; exports 3–4 |
| C1–C3 Preservation/offline/platforms | All integration tasks; exports 4 |

## Final audit

- [ ] Complete every linked plan task and preserve red/green and runtime evidence.
- [ ] Run the independent whole-change review; resolve substantive findings and reverify affected behavior.
- [ ] Audit every scope row against actual source, outputs and native behavior; record any unverified release credentials/runtime separately.
- [ ] Build shipping packages without test hooks, hash the deliverables, verify their contents and finish the Git integration/push to main.

The full objective remains active until every feature is implemented and its applicable checks are evidenced. An intermediate editor or sound milestone is not completion.
