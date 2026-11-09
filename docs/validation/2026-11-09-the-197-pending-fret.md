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
