# GP8 parity S18: partial capo by string (2026-10-30)

GP8 can set a capo on some strings only. TabPlayer had one capo per staff. This slice adds a partial capo to a staff, for sound, display and GP files. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-partial-capo-design.md`. Claude implemented it with an agent, had it reviewed four times, and ran it on a Windows desktop build. The row is partial: see Limits.

## Behavior
- **Rule:** on a covered string the higher of the staff capo and the partial capo acts. Elsewhere only the staff capo acts. Fret numbers count from the capo acting on that string.
- **Coverage:** the playback plan, MIDI export, notation, audition, instrument view and range edits follow the same rule. alphaTab has no per-string capo, so `Note.stringTuning` is replaced once.
- **Controls:** the Staff panel has a fret field and a checkbox per string. An invalid fret keeps the last valid value and blocks Apply.
- **Edits:** no new edit command. `setStaffSettings` and `addStaff` take an optional `partialCapo`.
- **String count:** changing it renumbers the partial capo with the kept strings, and keeps each note's pitch.
- **GP files:** read and written as `PartialCapoFret` and `PartialCapoStringFlags`. A malformed value is skipped with a warning.
- **Older projects:** a project with an edit history and no `partialCapo` marker replays with the file's partial capo ignored, so its notes are the same as before this feature. The first edit of a history-free project on such a file sets the marker, which is not an undo step. Projects whose file has no partial capo serialize as before.

## Evidence
- **Rust:** 815 tests passed across the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout. The rest of the suite passed 3,742 of 3,743 with 1 skipped; the one failure, `src/editor/corpus.test.ts`, was a timeout under load, and it passed alone. Eight old logs replay on a base holding a partial capo and match the same log on a base without one, including after save and reopen. With the gate forced on, those tests fail.
- **Desktop:** `tests/desktop/parity-partial-capo.mjs` passed on a Windows desktop-test build of the merged source. The run:
  - opened a GP file holding a capo and a partial capo, and compared each string's planned pitch;
  - changed both from the Staff panel, and checked undo and redo;
  - proved the first edit sets the marker;
  - exported GP, with a trill stored unchanged, then reopened the export and compared pitches with what the app sounded.

## Review
- **First review:** found trills drifting on every GP round trip, and that older projects could stop opening. Both Highs were fixed, along with a lost draft and an invalid fret clearing the capo.
- **Second review:** rejected the fix: a logged paste, theory chord, string move or string count change could still throw on open.
- **Third review:** approved the idea of a project marker but rejected the code. Undo to zero flipped the capo on, a new edit could mark a legacy project, and the library reader refused marked projects.
- **Fourth review:** approved the guard, with no High or Medium findings.
- **Desktop run:** the first run failed in the driver, because a trill adds planned notes.

## Limits
- **Why partial:**
  - GP flag order, lowest string first, is an assumption: no GP8-written file with a partial capo was available;
  - how GP8 numbers tab on covered strings is unconfirmed.
- **One per staff:** only one partial capo.
- **Harmony:** the saved-chord context compares only the staff capo.
- **Whole-neck capo edits:** they do not rebase trills, because that would change how existing logs replay.
- **Older projects:** an unmarked project reports the ignored capo only through a console warning. Undoing such a project to zero, then saving and reopening, gives a history-free project, so the capo then applies.
- **`partialCapo: null`:** the project reader accepts it, while the library reader and TypeScript refuse it. No writer emits it.
- **`file_library_intake`:** this Rust test target does not compile, because of `library_receipt`. It predates this slice.
