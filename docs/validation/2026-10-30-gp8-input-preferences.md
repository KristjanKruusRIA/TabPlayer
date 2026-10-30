# GP8 parity L08: score-input preferences (2026-10-30)

GP8 has input preferences for how notes are written. TabPlayer had none. This slice adds them to the View menu. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-input-preferences-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. The row stays partial: see Limits.

## Behavior
- **Keypad durations:** when on, keypad 1 to 7 set the duration and `.` toggles a dot, as one undoable edit. A key that changes nothing makes no edit, and NumLock-off keys keep navigating.
- **Auto-duration:** when on, a note written on a rest takes the last duration, as two undo steps. The pair is checked first, so a refused note leaves the rhythm alone. A status line explains when it does not apply.
- **Preview:** the existing play-notes-while-editing choice moved into the same group.
- **Diagram paste:** the default for whether a paste includes chord diagrams. Ctrl+V uses it, and the clipboard panel's filter follows it.
- **Storage:** choices are saved per user and shared across windows. They never edit a score.

## Evidence
- **Rust:** 815 tests passed across the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout, and the rest of the suite passed 3,742 of 3,743 with 1 skipped; the one failure, `src/editor/corpus.test.ts`, was a timeout under load, and it passed alone.
- **Desktop:** `tests/desktop/parity-input-preferences.mjs` passed on a Windows desktop-test build of the merged source. The run:
  - proved keypad keys type frets and edit nothing by default;
  - saved every choice, restarted the app, and read them back into the menu and the clipboard filter;
  - proved NumLock-off keys navigate and a no-op key makes no edit;
  - set durations and wrote notes through auto-duration, and read them back from an exported GP file;
  - turned the keypad off, and keys typed frets again.

## Review
- **Code review:** an Opus review found the row could not be called implemented, since GP8 documents a Plus/Minus Keys choice that TabPlayer lacks.
- **Findings and fixes:**
  - **High, fixed:** a refused duration still changed later entries.
  - **High, fixed:** NumLock-off keys were captured as durations.
  - **Medium, fixed:** a no-op key added an undo step, and a refused note left a changed rhythm.
  - **Medium, fixed:** the driver sent the NumLock-off key shape, so it tested the wrong path.
  - **Medium, fixed:** auto-duration skipped placeholders with no notice.
  - **Low, fixed:** changing the preference reset the panel's count and mappings.
- **Desktop run:** the first runs failed in the driver: a wrapped select, and paste options that appear only after a copy. A page reload also found the bug under Limits, so the driver restarts the app instead.

## Limits
- **Why partial:** Plus/Minus Keys Behavior is not implemented.
- **Diagram paste:** no fixture carries diagrams, so the driver checks the filter, not a paste with diagrams.
- **Auto-duration:** it does not apply to placeholders in empty bars, tuplet beats, or a duration that does not fit.
- **Reload:** a webview reload leaves the app on "Recovery unavailable", and Start new session does not leave that screen. This was not caused by this slice, and it is not fixed here.
