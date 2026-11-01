# GP8 Parity S19: Cross-Voice Collision Prevention in String Count Changes

Closes the cross-voice collision gap in `setStringCount` by sharing cross-voice placement checks with `refinger.ts`.

## Behavior

- **Cross-voice collision prevention**:
  - `setStringCount` in `src/editor/structure.ts` now tracks placed notes per bar and uses `crossVoicePlacement` (shared from `src/editor/refinger.ts`) to ensure notes sounding at the same time in different voices do not land on the same string.
  - `sounding` and `beatSpans` use the current rhythm (derived from `rhythmTicks` on the fly), so any preceding rhythm edits (lengthened durations, tuplets, grace notes) are accurately accounted for.
  - If overlapping notes in different voices have no free strings to avoid collision, `setStringCount` refuses the edit and lists the unplaceable notes using `describeUnreachable` with reason `conflict` (`the notes of this beat have no free strings for all of them`).
- **Compatibility & replay integrity**:
  - Single-voice string count changes that have no playable string in the new tuning continue to throw the established `A note at ... has no playable string in the new tuning.` error.
  - All existing project logs and tests replay exactly as before without mutation or regressions.

## Evidence

- **Unit tests**:
  - `src/editor/string-count.test.ts`:
    - `never puts notes of two voices that sound together on one string after a string count change`: verifies two overlapping voices in 7-string tuning reduced to 6-string end up on distinct strings.
    - `refuses and lists conflicting notes when overlapping voices have no free strings`: verifies that when all strings are occupied, the operation refuses atomically and lists the conflicting notes in the interface language.
    - `uses current rhythm including an edit made just before to detect cross-voice overlap`: verifies that a preceding rhythm edit (lengthened duration) that causes overlap is correctly detected and keeps the notes on different strings.
  - All 27 tests in `src/editor/string-count.test.ts` pass.
  - All 32 tests in `src/editor/refinger.test.ts` pass.
  - All 991 tests across 75 test files in `src/editor/` pass.
  - `npx tsc --noEmit` exits 0 with no diagnostic errors.

## Review

- Reused `crossVoicePlacement`, `sounding`, `beatSpans`, and `describeUnreachable` directly from `src/editor/refinger.ts` without duplicating logic.
- Preserved single-voice error messages to ensure backwards compatibility with existing test expectations and replay logs.
- Confirmed that this requires a separate review before merging due to touching edit replay and note placement semantics.

## Limits

- Desktop drivers (port 9223) were not run in this session per shared rules; desktop verification remains for merge review.
