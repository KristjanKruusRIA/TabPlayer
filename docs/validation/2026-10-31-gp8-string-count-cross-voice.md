# GP8 Parity S19: Cross-Voice Collision Prevention in String Count Changes

Closes the cross-voice collision gap in `setStringCount` by sharing cross-voice placement checks with `refinger.ts` using an optional `crossVoice?: boolean` command field for strict replay backward-compatibility.

## Behavior

- **Cross-voice collision prevention on new edits**:
  - `setStringCount` in `src/editor/structure.ts` and `src/workstation/TrackSettingsPanel.tsx` uses an optional `crossVoice?: boolean` command field. New edits created from UI specify `crossVoice: true`.
  - When `crossVoice: true`, `setStringCount` tracks placed notes per bar and uses `crossVoicePlacement` (shared from `src/editor/refinger.ts`) to ensure notes sounding at the same time in different voices do not land on the same string.
  - `sounding` and `beatSpans` use the current rhythm (derived from `rhythmTicks` on the fly), so any preceding rhythm edits (lengthened durations, tuplets, grace notes) are accurately accounted for.
  - If overlapping notes in different voices have no free strings to avoid collision, `setStringCount` refuses the edit and lists the unplaceable notes using `describeUnreachable` with reason `conflict` (`the notes of this beat have no free strings for all of them`).
- **Compatibility & replay integrity for old logs**:
  - As with `preserveOpeningMark` on `setScoreInfo`, old project logs omitting `crossVoice` replay without cross-voice checking (placing notes voice-by-voice exactly as before S19). This guarantees old logs never fail to replay or load with shifted string assignments.
  - Single-voice string count changes that have no playable string in the new tuning continue to throw the established `A note at ... has no playable string in the new tuning.` error.
  - Validated by `src/parity-commands.ts` where `crossVoice` is accepted only as an optional boolean flag on `setStringCount`.
- **Native command type**: edits pass through Rust, whose `EditCommand` refuses unknown fields, so `SetStringCount` in `src-tauri/src/edit_types.rs` also carries an optional `cross_voice`. Commit 2405c00 had added the field in TypeScript only, and Rust then refused every string count change from the panel with ``unknown field `crossVoice` ``. A `tests/protocol.json` example in the panel's exact shape now keeps the two sides together.

## Evidence

- **Unit tests**:
  - `src/editor/string-count.test.ts`:
    - `never puts notes of two voices that sound together on one string after a string count change with crossVoice: true`: verifies two overlapping voices in 7-string tuning reduced to 6-string end up on distinct strings.
    - `replays old logs without crossVoice exactly as before, allowing notes in different voices to land on one string without error`: verifies pre-S19 logs without `crossVoice` replay identically without mutation or errors.
    - `refuses and lists conflicting notes when overlapping voices have no free strings and crossVoice is true`: verifies that when all strings are occupied, new edits refuse atomically and list the conflicting notes in the interface language, whereas legacy commands replay without error.
    - `uses current rhythm including an edit made just before to detect cross-voice overlap`: verifies that a preceding rhythm edit (lengthened duration) that causes overlap is correctly detected and keeps the notes on different strings.
    - `replays a saved project log without crossVoice via buildDocument without regression`: verifies full end-to-end project document replay.
  - `src/parity-commands.test.ts`:
    - `crossVoice is an optional boolean on setStringCount only, and absent edits keep their exact shape`: verifies command envelope validation, accepting absent or boolean `crossVoice` and rejecting invalid types or other commands.
  - All 29 tests in `src/editor/string-count.test.ts` pass.
  - All 20 tests in `src/workstation/TrackSettingsPanel.test.tsx` pass.
  - All 16 tests in `src/parity-commands.test.ts` pass.
  - All 993 tests across 75 test files in `src/editor/` pass.
  - `npx tsc --noEmit` exits 0 with no diagnostic errors.

## Review

- Reused `crossVoicePlacement`, `sounding`, `beatSpans`, and `describeUnreachable` directly from `src/editor/refinger.ts` without duplicating logic.
- Guarded by optional `crossVoice?: boolean` to protect replay invariance for projects saved prior to S19.
- Verified that `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passes cleanly across the Rust workspace.

## Limits

- `tests/desktop/parity-string-count.mjs` passed on a build of the fix, so a panel string count change goes through Rust in the real app. Its fixture has no overlapping voices, so the refusal message and cross-voice placement were checked in unit tests only, not in the app.
- Old logs were tested by commands without the field, not with a real saved project from before S19.
- The other desktop drivers were not run for this change.
