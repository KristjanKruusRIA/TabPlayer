# GP8 parity N09: tie whole beats across voices (2026-10-22)

GP8 can tie every note of a beat, in every voice, in one step. This slice adds that to the Music selection panel. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Music selection → Selected notes:**
  - "Tie selected notes" ties every selected note, across all its voices and chord members, as one undoable edit.
  - "Untie selected notes" removes the ties into the selected notes.
- **Where a tie comes from:**
  - On guitar and bass, the nearest earlier note on the same string. It must have the same fret and harmonic, and sound the same pitch.
  - On other pitched staves, the nearest earlier note of the same pitch.
- **Refused ties:**
  - a missing origin;
  - a dead origin;
  - a rest or missing voice between the notes;
  - an origin more than three bars back (GP files reopen ties only that far);
  - a tie that would cut another note's tie;
  - drum hits.

  Any refusal changes nothing, so a partly valid selection is never half tied.
- **Other cases:**
  - Dead notes in a selection are left alone.
  - A note whose existing tie skips over a newer note is re-tied from the nearer note.
  - Clicks that would change nothing are refused, so they never become undo steps.
  - Tie is disabled for drum selections.
- **Saved form:** `setSelectionTies {selection, tied}`. The frontend and Rust refuse a non-boolean `tied` and extra fields. Saved edits replay on reopen.

## Evidence
- **Frontend:**
  - `selection-ties.test.ts`:
    - a bar ties every note in both voices from the previous matching notes, and the ties survive a GP export and reopen;
    - single-note ties untie back to the original score;
    - refusals are atomic, even when valid ties come before the failing note;
    - a different string, a rest, a dead origin, or a harmonic with a different fret or type is refused;
    - the three-bar limit holds, at exactly three bars and with a GP round trip;
    - drum hits are refused and dead notes are left alone;
    - a stale spanning tie is re-made, and an unrelated tie is never cut;
    - untie stays in the selection, and no-op edits are refused;
    - the saved command envelope is validated.

    Each guard was mutation-checked: removing the three-bar limit, the fret match, the cut-tie refusal or the rest check fails a test.
  - `RangePanel.test.tsx`: the buttons send tie and untie commands, and refusals raise an alert.
  - Protocol fixture: 74 wire examples.
  - RED log: `.analysis/parity/selection-ties-red.log`.
- **Rust:** `edit_types.rs`:
  - the command round-trips for every selection kind and requires every field;
  - `tied` accepts only a boolean.
- **Desktop:** `tests/desktop/parity-selection-ties.mjs` on a Windows desktop-test build, with a generated three-bar, two-voice guitar score:
  - measure 1 is refused and records no edit;
  - measure 2 ties all notes in both voices in one edit, with voice 2 tied back into measure 1, as shown by GP export;
  - untie, undo and redo behave, and playback is ready afterwards.
- **Verification:** these all pass:
  - full `vitest`: 3325 tests. The known load-sensitive `tuning-ui` and `WorkspaceApp` files pass when run alone.
  - `tsc`;
  - `cargo test`;
  - rustfmt on the changed file.
- **Review:** an adversarial review found five problems, all fixed and tested:
  - ties reached back further than GP reopens;
  - dead origins and harmonic fret mismatches;
  - percussion ties that reopened onto the wrong drum;
  - a stale tie that left a requested note untied;
  - weak atomicity tests.

## Limits
- N09 is partial:
  - ties need an existing matching note; tying doesn't change a destination's pitch to match, as GP does;
  - no keyboard shortcut;
  - no original-GP8 comparison.
- A refusal message stays visible until the next successful edit.
