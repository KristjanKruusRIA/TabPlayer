# THE-197: Visible pending fret digits

2026-11-09. Branch `agy/the-197-pending-fret` from `develop` (`f24e72b`).

## Context & Problem

The typed speed half of THE-197 was merged previously (`18fe022`). The remaining open half was visible pending fret digits:
- While fret digits were typed but not yet committed with Enter, only the Inspector Fret field updated.
- There was no on-score or status-line feedback indicating an uncommitted fret entry was pending, and no prompt explaining that Enter commits and Escape cancels.

## Changes

1. **State & Entry Management**:
   - Added `pendingFret` state to `src/App.tsx`.
   - When typing digits (`0`–`9`), `pendingFret` updates with the pending text digits (1–2 digits).
   - When `Enter` is pressed, `pendingFret` is cleared and `enterFret` commits the note.
   - When `Escape` is pressed while digits are pending, `pendingFret` and `digits.current.text` are cleared, and the fret value is restored to the current note's fret (or 0) without creating an undoable history entry.
   - When `Backspace` is pressed, pending digits are cleared and the note fret is restored before any deletion occurs.
   - When cursor or selection moves, `pendingFret` is cleared.

2. **On-Score Caret & Status Indicators**:
   - `ScoreView.tsx`: Added `editPendingFret` prop to `ScoreView`. When digits are pending, the score caret overlay over the note / string displays `Fret {pendingFret}`.
   - `score-hint`: The score pane hint banner below the paper renders `Fret {fret}: Enter commits, Escape cancels` with `role="status"`.
   - `statusbar`: The bottom status bar displays `Fret {fret}: Enter commits, Escape cancels` with `role="status"` while digits are pending.

3. **Translations**:
   - Added `editor.pending_fret`:
     - `en`: `'Fret {fret}: Enter commits, Escape cancels'`
     - `et`: `'Krihv {fret}: Enter kinnitab, Escape tühistab'`
     - `de`: `'Bund {fret}: Enter bestätigt, Escape bricht ab'`

## Verification

- `src/App.test.tsx`:
  - Verified pending fret digits appear in score hint and status bar upon typing a digit.
  - Verified `editPendingFret` is passed to the score view.
  - Verified Escape cancels pending digits and restores fret without adding an edit command.
  - Verified Enter commits the note and clears the pending state.
  - All 24 tests in `GP8 edit and cursor keys` passed.
- `src/ScoreView.test.tsx`:
  - Verified `.score-edit-entry` renders `Fret {pendingFret}` on the score caret overlay when `editPendingFret` is provided, and reverts when cleared.
  - All 27 tests in `ScoreView.test.tsx` passed.
- TypeScript: `npx tsc --noEmit` passed with 0 errors.

## Review follow-up

- The on-score labels ("Fret N", "String N", "Entry") now go through `src/i18n` (`score.pending_fret_label`, `score.edit_string`, `score.edit_entry`) in en, et and de.
- Estonian uses "astmetraat" for fret, the term the catalog uses most (the new strings had "krihv"). Four older strings (`help.shortcut_fret`, `help.topic.editing.p1`, `refinger.*`) still say "krihv"; they were not touched.
- Escape and Backspace restore the fret that stood before the first pending digit (a note's fret, or one set beforehand, such as from the instrument view), and record no edit.
- Only the score hint carries `role="status"`; the status bar copy is plain text.
- The hint ends when the one-second digit window closes, which is also when Backspace deletes the note again.

## Limits

- No desktop driver, WebView2 run or visual check was done. The on-score label placement, the overlay position and the screen-reader announcement were not seen in the real app.
- Evidence is jsdom tests only (`src/App.test.tsx`, `src/ScoreView.test.tsx`, `src/i18n`).
- The on-score "String N" and "Entry" labels are translated but have no test of their own.
